import type { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { seededDatabase } from '../../scripts/totals'
import { decodePolyline, encodePolyline } from '../lib/polyline'
import { importActivities, ingest, rematchPending, runRematch, runSync } from './sync'

/** D1's statement API over an in-memory SQLite database. */
function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...next: unknown[]) => stmt(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...(args as [])) }),
    first: async () => db.prepare(sql).all(...(args as []))[0] ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as [])).changes) } }),
  })
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: ReturnType<typeof stmt>[]) => {
      const out = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  } as unknown as D1Database
}

describe('rematch after a city is added', async () => {
  const db = await seededDatabase('sf')
  // A walk along Market Street, from the seed's own geometry.
  const rows = db.prepare(`SELECT coords FROM segments WHERE city = 'sf' AND name = 'Market Street' AND foot = 1 ORDER BY id LIMIT 8`).all() as {
    coords: string
  }[]
  const market = encodePolyline(rows.flatMap((r) => decodePolyline(r.coords, 6)))
  // Chicago's lakefront, outside every city floodfill.world covers.
  const lakefront = encodePolyline([
    [41.8917, -87.6086],
    [41.8676, -87.6136],
  ])
  const insert = db.prepare(
    `INSERT INTO activities (id, user_id, mode, city, start_date, start_ts, summary_polyline, status, updated_at)
     VALUES (?, 'u1', ?, NULL, '', ?, ?, 'ignored', 0)`,
  )
  insert.run(1, 'foot', 100, market) // in a city that has since been enabled
  insert.run(2, 'foot', 200, lakefront) // outside every enabled city
  insert.run(3, null, 300, market) // not a foot or bike activity
  // Seeded in production ahead of the deploy that enables it.
  db.prepare(`INSERT INTO state (key, value, updated_at) VALUES ('rematch:atlantis', '{"ts":0,"id":0}', 0)`).run()
  const env = {
    DB: d1(db),
    STRAVA_CLIENT_ID: 'id',
    STRAVA_CLIENT_SECRET: 'secret',
    STRAVA_LIMIT_15MIN: '400',
    STRAVA_LIMIT_DAILY: '4000',
    STRAVA_READ_LIMIT_15MIN: '200',
    STRAVA_READ_LIMIT_DAILY: '2000',
    STRAVA_BUDGET_FRACTION: '0.9',
  } as unknown as Env

  const result = await runSync(env, { trigger: 'cron', timeBudgetMs: 60_000 })
  const activity = (id: number) => db.prepare('SELECT city, status FROM activities WHERE id = ?').get(id)

  it('finishes and clears the flags of enabled cities', () => {
    expect(result.error).toBeNull()
    expect(result.rematched).toBe(1)
    expect(db.prepare(`SELECT key FROM state WHERE key LIKE 'rematch%'`).all()).toEqual([{ key: 'rematch:atlantis' }])
  })

  it('assigns ignored activities to the city they fall in and credits them', () => {
    expect(activity(1)).toEqual({ city: 'sf', status: 'summary' })
    const covered = db.prepare(`SELECT COUNT(*) AS n FROM coverage WHERE user_id = 'u1' AND mode = 'foot' AND completed = 1`).get() as {
      n: number
    }
    expect(covered.n).toBeGreaterThan(0)
  })

  it('leaves activities outside every city, or of other sports, ignored', () => {
    expect(activity(2)).toEqual({ city: null, status: 'ignored' })
    expect(activity(3)).toEqual({ city: null, status: 'ignored' })
  })
})

describe('rematch from a page visit', async () => {
  const db = await seededDatabase('sf')
  const rows = db.prepare(`SELECT coords FROM segments WHERE city = 'sf' AND name = 'Market Street' AND foot = 1 ORDER BY id LIMIT 8`).all() as {
    coords: string
  }[]
  const market = encodePolyline(rows.flatMap((r) => decodePolyline(r.coords, 6)))
  db.prepare(
    `INSERT INTO activities (id, user_id, mode, city, start_date, start_ts, summary_polyline, status, updated_at)
     VALUES (1, 'u1', 'foot', NULL, '', 100, ?, 'ignored', 0)`,
  ).run(market)
  db.prepare(`INSERT INTO state (key, value, updated_at) VALUES ('rematch:sf', '{"ts":0,"id":0}', 0)`).run()
  db.prepare(`INSERT INTO state (key, value, updated_at) VALUES ('rematch:atlantis', '{"ts":0,"id":0}', 0)`).run()
  // No Strava credentials: re-matching never calls Strava.
  const env = { DB: d1(db) } as unknown as Env
  const lock = (until: number) =>
    db.prepare(`INSERT INTO state (key, value, updated_at) VALUES ('sync_lock', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(until))

  it('waits while another sync holds the lock', async () => {
    lock(Date.now() + 60_000)
    expect(await runRematch(env, 60_000)).toEqual({ stopReason: 'busy', rematched: 0 })
    lock(0)
  })

  it('credits a newly enabled city and ignores flags for cities not deployed yet', async () => {
    expect(await rematchPending(env.DB)).toBe(true)
    expect(await runRematch(env, 60_000)).toEqual({ stopReason: 'complete', rematched: 1 })
    expect(db.prepare('SELECT city, status FROM activities WHERE id = 1').get()).toEqual({ city: 'sf', status: 'summary' })
    const covered = db.prepare(`SELECT COUNT(*) AS n FROM coverage WHERE user_id = 'u1' AND mode = 'foot' AND completed = 1`).get() as {
      n: number
    }
    expect(covered.n).toBeGreaterThan(0)
    expect(await rematchPending(env.DB)).toBe(false)
    expect(db.prepare(`SELECT value FROM state WHERE key = 'sync_lock'`).get()).toEqual({ value: '0' })
  })

  it('does nothing once there is nothing to match', async () => {
    expect(await runRematch(env, 60_000)).toEqual({ stopReason: 'complete', rematched: 0 })
  })
})

describe('importing a Strava export', async () => {
  const db = await seededDatabase('sf')
  const rows = db.prepare(`SELECT coords FROM segments WHERE city = 'sf' AND name = 'Market Street' AND foot = 1 ORDER BY id LIMIT 8`).all() as {
    coords: string
  }[]
  const market = encodePolyline(rows.flatMap((r) => decodePolyline(r.coords, 6)))
  const lakefront = encodePolyline([
    [41.8917, -87.6086],
    [41.8676, -87.6136],
  ])
  const base = { name: 'Walk', startDate: '2024-05-01T15:00:00.000Z', distanceM: 1000, movingTimeS: 600 }
  db.prepare(
    `INSERT INTO activities (id, user_id, mode, city, start_date, start_ts, status, updated_at) VALUES (9, 'someone', 'foot', 'sf', '', 0, 'detailed', 0)`,
  ).run()
  const added = await importActivities(d1(db), 'u1', [
    { ...base, id: 1, sportType: 'Walk', polyline: market },
    { ...base, id: 2, sportType: 'Run', polyline: lakefront },
    { ...base, id: 9, sportType: 'Walk', polyline: market },
  ])
  const activity = (id: number) => db.prepare('SELECT user_id, city, status, polyline IS NOT NULL AS has_track FROM activities WHERE id = ?').get(id)

  it('stores new activities and skips ones already stored', () => {
    expect(added).toBe(2)
    expect(activity(9)).toEqual({ user_id: 'someone', city: 'sf', status: 'detailed', has_track: 0 })
  })

  it('credits activities in a city from their full track', () => {
    expect(activity(1)).toEqual({ user_id: 'u1', city: 'sf', status: 'detailed', has_track: 1 })
    const covered = db.prepare(`SELECT COUNT(*) AS n FROM coverage WHERE user_id = 'u1' AND mode = 'foot' AND completed = 1`).get() as {
      n: number
    }
    expect(covered.n).toBeGreaterThan(0)
  })

  it('keeps the track of an activity outside every city, for a city that opens later', () => {
    expect(activity(2)).toEqual({ user_id: 'u1', city: null, status: 'ignored', has_track: 1 })
  })
})

describe('a cron run with a revoked account', async () => {
  const db = await seededDatabase('sf')
  const user = db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, 0)`)
  user.run('revoked', 'revoked@example.com')
  user.run('fine', 'fine@example.com')
  const account = db.prepare(
    `INSERT INTO strava_accounts (user_id, athlete_id, access_token, refresh_token, expires_at, connected_at, last_sync_at)
     VALUES (?, ?, 'access', 'refresh', ?, 0, ?)`,
  )
  // First in line: its access token has expired and Strava refuses to refresh it.
  account.run('revoked', 1, 0, 0)
  account.run('fine', 2, Math.floor(Date.now() / 1000) + 3600, 1)
  vi.stubGlobal('fetch', async (url: string | URL) =>
    String(url).includes('/oauth/token') ? new Response('{"message":"Bad Request"}', { status: 400 }) : Response.json([]),
  )
  afterAll(() => void vi.unstubAllGlobals())
  const env = {
    DB: d1(db),
    STRAVA_CLIENT_ID: 'id',
    STRAVA_CLIENT_SECRET: 'secret',
    STRAVA_LIMIT_15MIN: '400',
    STRAVA_LIMIT_DAILY: '4000',
    STRAVA_READ_LIMIT_15MIN: '200',
    STRAVA_READ_LIMIT_DAILY: '2000',
    STRAVA_BUDGET_FRACTION: '0.9',
  } as unknown as Env
  const result = await runSync(env, { trigger: 'cron', timeBudgetMs: 60_000 })

  it('disconnects the revoked account and still syncs the rest', () => {
    expect(result.stopReason).toBe('complete')
    expect(db.prepare(`SELECT user_id FROM strava_accounts`).all()).toEqual([{ user_id: 'fine' }])
    expect(db.prepare(`SELECT backfill_done, last_sync_at > 1 AS synced FROM strava_accounts WHERE user_id = 'fine'`).get()).toEqual({
      backfill_done: 1,
      synced: 1,
    })
  })
})

describe("an imported activity under someone else's Strava id", async () => {
  const db = await seededDatabase('sf')
  const rows = db.prepare(`SELECT coords FROM segments WHERE city = 'sf' AND name = 'Market Street' AND foot = 1 ORDER BY id LIMIT 8`).all() as {
    coords: string
  }[]
  const market = encodePolyline(rows.flatMap((r) => decodePolyline(r.coords, 6)))
  const completed = (userId: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM coverage WHERE user_id = ? AND completed = 1').get(userId) as { n: number }).n
  // Someone imports an "export" that borrows the id of another athlete's real activity.
  await importActivities(d1(db), 'squatter', [
    { id: 77, name: 'Walk', sportType: 'Walk', startDate: '2024-05-01T15:00:00.000Z', distanceM: 1000, movingTimeS: 600, polyline: market },
  ])
  const before = completed('squatter')
  // Then the owner's Strava sync lists it.
  const added = await ingest(d1(db), 'owner', [
    { id: 77, name: 'Morning Walk', sport_type: 'Walk', start_date: '2024-05-01T15:00:00Z', distance: 1000, moving_time: 600, map: { summary_polyline: market } },
  ])

  it('goes to the athlete Strava lists it for', () => {
    expect(before).toBeGreaterThan(0)
    expect(added).toBe(1)
    expect(db.prepare('SELECT user_id, name FROM activities WHERE id = 77').get()).toEqual({ user_id: 'owner', name: 'Morning Walk' })
    expect(completed('owner')).toBeGreaterThan(0)
  })

  it("takes back the importer's credit for it", () => {
    expect(completed('squatter')).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM coverage WHERE user_id = ?').get('squatter')).toEqual({ n: 0 })
  })
})
