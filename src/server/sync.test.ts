import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { seededDatabase } from '../../scripts/totals'
import { decodePolyline, encodePolyline } from '../lib/polyline'
import { runSync } from './sync'

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
  const centralPark = encodePolyline([
    [40.7812, -73.9665],
    [40.7712, -73.9742],
  ])
  const insert = db.prepare(
    `INSERT INTO activities (id, user_id, mode, city, start_date, start_ts, summary_polyline, status, updated_at)
     VALUES (?, 'u1', ?, NULL, '', ?, ?, 'ignored', 0)`,
  )
  insert.run(1, 'foot', 100, market) // in a city that has since been enabled
  insert.run(2, 'foot', 200, centralPark) // outside every enabled city
  insert.run(3, null, 300, market) // not a foot or bike activity
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

  it('finishes and clears every rematch flag', () => {
    expect(result.error).toBeNull()
    expect(result.rematched).toBe(1)
    expect(db.prepare(`SELECT key FROM state WHERE key LIKE 'rematch%'`).all()).toEqual([])
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
