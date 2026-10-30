import { CITIES, CITY_IDS, cityForTrack, type CityId } from '../lib/cities'
import { decodePolyline, encodePolyline } from '../lib/polyline'
import { applyActivityCoverage, type Mode } from './coverage/apply'
import { matchTrack } from './coverage/match'
import { loadCityIndex, type CityIndex } from './coverage/segments'
import { chunk, getState, MAX_PARAMS, setState } from './db'
import { StravaClient, StravaError, stravaConfigured, type StravaAccount, type StravaSummaryActivity } from './strava/client'
import { RateBudgetExhausted, RateLimiter } from './strava/rate-limit'

const FOOT = new Set(['Run', 'TrailRun', 'Walk', 'Hike'])
const BIKE = new Set(['Ride', 'MountainBikeRide', 'GravelRide', 'EBikeRide', 'EMountainBikeRide'])

export function modeFor(sportType: string): Mode | null {
  if (FOOT.has(sportType)) return 'foot'
  if (BIKE.has(sportType)) return 'bike'
  return null
}

/** Summary polylines are simplified, so long straight edges are expected. */
const SUMMARY_MAX_GAP_M = 2000
/** Full-resolution streams sample every ~1 s; longer jumps are GPS dropouts. */
const STREAM_MAX_GAP_M = 150
const PER_PAGE = 200

export type StopReason = 'complete' | 'rate_limit' | 'time' | 'not_configured' | 'not_connected' | 'busy' | 'error'

export type SyncResult = {
  stopReason: StopReason
  resumeAt: number | null
  requests: number
  listed: number
  detailed: number
  rematched: number
  error: string | null
}

/**
 * Imports and matches Strava activities within a time budget. With `userId` it syncs that user
 * (the Sync button); without, it works through connected users, least recently synced first
 * (the cron). One sync runs at a time, and all users share the app's Strava rate budget.
 */
export async function runSync(
  env: Env,
  opts: { trigger: 'manual' | 'cron'; timeBudgetMs: number; userId?: string },
): Promise<SyncResult> {
  const result: SyncResult = { stopReason: 'complete', resumeAt: null, requests: 0, listed: 0, detailed: 0, rematched: 0, error: null }
  if (!stravaConfigured(env)) return { ...result, stopReason: 'not_configured' }

  const db = env.DB
  const accounts = opts.userId
    ? await db.prepare('SELECT * FROM strava_accounts WHERE user_id = ?').bind(opts.userId).all<StravaAccount>()
    : await db.prepare('SELECT * FROM strava_accounts ORDER BY COALESCE(last_sync_at, 0)').all<StravaAccount>()
  if (opts.userId && accounts.results.length === 0) return { ...result, stopReason: 'not_connected' }

  const started = Date.now()
  const deadline = started + opts.timeBudgetMs
  if (!(await takeLock(db, started, deadline + 60_000))) return { ...result, stopReason: 'busy' }

  const run = await db
    .prepare('INSERT INTO sync_runs (trigger, started_at, user_id) VALUES (?, ?, ?) RETURNING id')
    .bind(opts.trigger, started, opts.userId ?? null)
    .first<{ id: number }>()

  const limiter = await RateLimiter.load(db, env)
  const outOfTime = () => Date.now() > deadline

  try {
    // 0. After a city's street network is rebuilt or added, re-match stored tracks. No API requests.
    result.rematched = await rematch(db, outOfTime)

    for (const account of accounts.results) {
      if (outOfTime()) break
      await syncAccount(db, env, limiter, account, outOfTime, result)
    }
    if (outOfTime()) result.stopReason = 'time'
  } catch (err) {
    if (err instanceof RateBudgetExhausted) {
      result.stopReason = 'rate_limit'
      result.resumeAt = err.resetAt
    } else {
      result.stopReason = 'error'
      result.error = err instanceof Error ? err.message : String(err)
      console.error('sync failed', err)
    }
  } finally {
    result.requests = limiter.requests
    await limiter.save(db)
    await db.batch([
      db
        .prepare('UPDATE sync_runs SET finished_at = ?, requests = ?, listed = ?, detailed = ?, stop_reason = ?, error = ? WHERE id = ?')
        .bind(Date.now(), result.requests, result.listed, result.detailed, result.stopReason, result.error, run!.id),
      releaseLock(db),
    ])
  }
  return result
}

export type RematchResult = { stopReason: 'complete' | 'time' | 'busy'; rematched: number }

/**
 * Only the re-matching step of a sync, with no Strava requests. Pages call this while a rematch
 * is pending, so a new city's progress is there as soon as the deploy that opens it is live,
 * rather than after the next cron run or someone pressing Sync.
 */
export async function runRematch(env: Env, timeBudgetMs: number): Promise<RematchResult> {
  const db = env.DB
  if (!(await rematchPending(db))) return { stopReason: 'complete', rematched: 0 }
  const started = Date.now()
  const deadline = started + timeBudgetMs
  if (!(await takeLock(db, started, deadline + 60_000))) return { stopReason: 'busy', rematched: 0 }
  try {
    const rematched = await rematch(db, () => Date.now() > deadline)
    return { stopReason: (await rematchPending(db)) ? 'time' : 'complete', rematched }
  } finally {
    await releaseLock(db).run()
  }
}

/**
 * Whether stored tracks still need re-matching in an enabled city. A city's seed goes into
 * production before the deploy that enables it, and its flag waits for that deploy.
 */
export async function rematchPending(db: D1Database) {
  const keys = ['rematch', ...CITY_IDS.map((city) => `rematch:${city}`)]
  const row = await db
    .prepare(`SELECT 1 AS x FROM state WHERE key IN (${keys.map(() => '?').join(',')}) LIMIT 1`)
    .bind(...keys)
    .first()
  return row !== null
}

/** Takes the sync lock until `until` unless another sync or rematch holds it: one runs at a time. */
async function takeLock(db: D1Database, now: number, until: number) {
  const lock = await db
    .prepare(
      `INSERT INTO state (key, value, updated_at) VALUES ('sync_lock', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE CAST(state.value AS INTEGER) < ?`,
    )
    .bind(String(until), now, now)
    .run()
  return lock.meta.changes === 1
}

const releaseLock = (db: D1Database) => db.prepare(`UPDATE state SET value = '0' WHERE key = 'sync_lock'`)

/** One user's import: new activities, history backfill, then full GPS streams. */
async function syncAccount(
  db: D1Database,
  env: Env,
  limiter: RateLimiter,
  account: StravaAccount,
  outOfTime: () => boolean,
  result: SyncResult,
) {
  const client = new StravaClient(db, env, limiter, account)
  const userId = account.user_id
  const touch = () => db.prepare('UPDATE strava_accounts SET last_sync_at = ? WHERE user_id = ?').bind(Date.now(), userId).run()

  // 1. New activities since this user's newest one.
  const newest = await db
    .prepare('SELECT MAX(start_ts) AS ts FROM activities WHERE user_id = ?')
    .bind(userId)
    .first<{ ts: number | null }>()
  if (newest?.ts) {
    for (let page = 1; !outOfTime(); page++) {
      const acts = await client.listActivities({ after: newest.ts, page })
      result.listed += await ingest(db, userId, acts)
      if (acts.length < PER_PAGE) break
    }
  }

  // 2. Backfill history, newest to oldest, one page (200 activities) per request.
  let { backfill_before: before, backfill_done: done } = account
  while (!done && !outOfTime()) {
    const acts = await client.listActivities(before ? { before } : {})
    result.listed += await ingest(db, userId, acts)
    if (acts.length > 0) before = Math.min(...acts.map((a) => toTs(a.start_date)))
    if (acts.length < PER_PAGE) done = 1
    await db
      .prepare('UPDATE strava_accounts SET backfill_before = ?, backfill_done = ? WHERE user_id = ?')
      .bind(before, done, userId)
      .run()
  }

  // 3. Upgrade summary matches with full-resolution GPS streams, newest first.
  while (!outOfTime()) {
    const { results: pending } = await db
      .prepare(`SELECT id, mode, city FROM activities WHERE user_id = ? AND status = 'summary' ORDER BY start_ts DESC LIMIT 25`)
      .bind(userId)
      .all<{ id: number; mode: Mode; city: string | null }>()
    if (pending.length === 0) break
    for (const [city, acts] of byCity(pending)) {
      if (outOfTime()) break
      if (!city) {
        // Its city is no longer enabled.
        for (const act of acts) await setActivityStatus(db, act.id, 'ignored')
        continue
      }
      const index = await loadCityIndex(db, city)
      for (const act of acts) {
        if (outOfTime()) break
        let track: [number, number][] | null = null
        try {
          track = await client.latlngStream(act.id)
        } catch (err) {
          if (!(err instanceof StravaError) || ![403, 404].includes(err.status)) throw err
        }
        if (!track || track.length < 2) {
          await setActivityStatus(db, act.id, 'error')
          continue
        }
        const masks = matchTrack(track, index.forMode[act.mode], index.project, STREAM_MAX_GAP_M)
        const firsts = await applyActivityCoverage(db, index, userId, act.id, act.mode, masks)
        await db
          .prepare(`UPDATE activities SET status = 'detailed', polyline = ?, new_segments = ?, updated_at = ? WHERE id = ?`)
          .bind(encodePolyline(track), firsts, Date.now(), act.id)
          .run()
        result.detailed++
      }
    }
  }
  await touch()
}

/**
 * Groups activities by city, keeping their order within each, so each city's index is loaded
 * once. Activities whose city isn't enabled come under null.
 */
function byCity<T extends { city: string | null }>(acts: T[]): Map<CityId | null, T[]> {
  const groups = new Map<CityId | null, T[]>()
  for (const a of acts) {
    const city = a.city !== null && Object.hasOwn(CITIES, a.city) ? (a.city as CityId) : null
    const group = groups.get(city)
    if (group) group.push(a)
    else groups.set(city, [a])
  }
  return groups
}

/**
 * Re-match progress for one city. `classify` first assigns ignored activities that fall in the
 * city (it may be new), then `match` re-credits the city's activities.
 */
type RematchCursor = { ts: number; id: number; phase?: 'classify' | 'match' }

/**
 * Re-credits each flagged city's activities against its current network, oldest first so each
 * segment's completing activity comes out right. A city's seed sets `rematch:<city>`, and this
 * clears it once the city is done. The older `rematch` key means every city.
 */
async function rematch(db: D1Database, outOfTime: () => boolean) {
  const { results: keys } = await db
    .prepare(`SELECT key FROM state WHERE key = 'rematch' OR key LIKE 'rematch:%'`)
    .all<{ key: string }>()
  if (keys.length === 0) return 0
  if (keys.some((k) => k.key === 'rematch')) {
    await db.batch([
      ...CITY_IDS.map((city) =>
        db
          .prepare(`INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
          .bind(`rematch:${city}`, JSON.stringify({ ts: 0, id: 0 }), Date.now()),
      ),
      db.prepare(`DELETE FROM state WHERE key = 'rematch'`),
    ])
    return rematch(db, outOfTime)
  }

  let done = 0
  for (const { key } of keys) {
    if (outOfTime()) break
    const city = key.slice('rematch:'.length)
    // A city's seed goes into production before the code that enables it, so leave its flag for then.
    if (!Object.hasOwn(CITIES, city)) continue
    done += await rematchCity(db, city as CityId, key, outOfTime)
  }
  return done
}

async function rematchCity(db: D1Database, city: CityId, key: string, outOfTime: () => boolean) {
  const cursor = (await getState<RematchCursor>(db, key)) ?? { ts: 0, id: 0 }

  if ((cursor.phase ?? 'classify') === 'classify') {
    while (!outOfTime()) {
      const { results } = await db
        .prepare(
          `SELECT id, start_ts, summary_polyline FROM activities
           WHERE status = 'ignored' AND mode IS NOT NULL AND user_id IS NOT NULL AND summary_polyline IS NOT NULL
             AND (start_ts > ? OR (start_ts = ? AND id > ?))
           ORDER BY start_ts, id LIMIT 200`,
        )
        .bind(cursor.ts, cursor.ts, cursor.id)
        .all<{ id: number; start_ts: number; summary_polyline: string }>()
      const found = results.filter((a) => cityForTrack(decodePolyline(a.summary_polyline)) === city)
      for (const ids of chunk(found.map((a) => a.id), MAX_PARAMS - 3)) {
        await db
          .prepare(`UPDATE activities SET city = ?, status = 'summary', updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
          .bind(city, Date.now(), ...ids)
          .run()
      }
      if (results.length === 0) {
        Object.assign(cursor, { ts: 0, id: 0, phase: 'match' })
        await setState(db, key, cursor)
        break
      }
      const last = results[results.length - 1]
      Object.assign(cursor, { ts: last.start_ts, id: last.id })
      await setState(db, key, cursor)
    }
    if (cursor.phase !== 'match') return 0
  }

  let done = 0
  const index = await loadCityIndex(db, city)
  while (!outOfTime()) {
    const { results } = await db
      .prepare(
        `SELECT id, user_id, mode, start_ts, polyline, summary_polyline FROM activities
         WHERE city = ? AND status != 'ignored' AND user_id IS NOT NULL AND (start_ts > ? OR (start_ts = ? AND id > ?))
         ORDER BY start_ts, id LIMIT 20`,
      )
      .bind(city, cursor.ts, cursor.ts, cursor.id)
      .all<ActivityTrack & { start_ts: number }>()
    if (results.length === 0) {
      await db.prepare('DELETE FROM state WHERE key = ?').bind(key).run()
      break
    }
    for (const a of results) {
      await recredit(db, index, a)
      cursor.ts = a.start_ts
      cursor.id = a.id
      done++
    }
    await setState(db, key, cursor)
  }
  return done
}

type ActivityTrack = { id: number; user_id: string; mode: Mode; polyline: string | null; summary_polyline: string | null }

/** Matches a stored activity again from its saved track (full GPS if fetched, else the summary). */
async function recredit(db: D1Database, index: CityIndex, a: ActivityTrack) {
  const detailed = a.polyline !== null
  const track = decodePolyline(a.polyline ?? a.summary_polyline ?? '')
  const masks = matchTrack(track, index.forMode[a.mode], index.project, detailed ? STREAM_MAX_GAP_M : SUMMARY_MAX_GAP_M)
  const firsts = await applyActivityCoverage(db, index, a.user_id, a.id, a.mode, masks)
  await db.prepare('UPDATE activities SET new_segments = ? WHERE id = ?').bind(firsts, a.id).run()
}

const toTs = (iso: string) => Math.floor(Date.parse(iso) / 1000)

function setActivityStatus(db: D1Database, id: number, status: string) {
  return db.prepare('UPDATE activities SET status = ?, updated_at = ? WHERE id = ?').bind(status, Date.now(), id).run()
}

/**
 * Stores new activities and immediately credits coverage from their summary polyline,
 * which costs no extra API requests. Returns the number of new activities.
 */
async function ingest(db: D1Database, userId: string, acts: StravaSummaryActivity[]) {
  const known = new Set<number>()
  for (const ids of chunk(acts.map((a) => a.id), MAX_PARAMS - 1)) {
    const marks = ids.map(() => '?').join(',')
    // Activities imported before accounts existed have no owner: they belong to this athlete.
    const { results: claimed } = await db
      .prepare(
        `UPDATE activities SET user_id = ? WHERE user_id IS NULL AND id IN (${marks})
         RETURNING id, user_id, mode, city, status, polyline, summary_polyline`,
      )
      .bind(userId, ...ids)
      .all<ActivityTrack & { city: string | null; status: string }>()
    try {
      for (const [city, group] of byCity(claimed.filter((a) => a.status !== 'ignored' && a.mode))) {
        if (!city) continue
        const index = await loadCityIndex(db, city)
        for (const a of group) await recredit(db, index, a)
      }
    } catch (err) {
      // These rows are already claimed and won't be listed as new again, so make sure the
      // next sync re-credits every stored track (no Strava requests) before giving up.
      await setState(db, 'rematch', { ts: 0, id: 0 })
      throw err
    }

    const { results } = await db
      .prepare(`SELECT id FROM activities WHERE id IN (${marks})`)
      .bind(...ids)
      .all<{ id: number }>()
    for (const r of results) known.add(r.id)
  }

  let added = 0
  const toMatch: { id: number; city: CityId; mode: Mode; track: [number, number][] }[] = []
  for (const a of acts) {
    if (known.has(a.id)) continue
    const mode = modeFor(a.sport_type)
    const summary = a.map?.summary_polyline || null
    const track = mode && summary ? decodePolyline(summary) : []
    const city = track.length >= 2 ? cityForTrack(track) : null
    await db
      .prepare(
        `INSERT INTO activities (id, user_id, name, sport_type, mode, start_date, start_ts, distance_m, moving_time_s, city, summary_polyline, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        a.id,
        userId,
        a.name,
        a.sport_type,
        mode,
        a.start_date,
        toTs(a.start_date),
        a.distance,
        a.moving_time,
        city,
        summary,
        city ? 'summary' : 'ignored',
        Date.now(),
      )
      .run()
    added++
    if (city && mode) toMatch.push({ id: a.id, city, mode, track })
  }

  for (const [city, group] of byCity(toMatch)) {
    const index = await loadCityIndex(db, city!)
    for (const a of group) {
      const masks = matchTrack(a.track, index.forMode[a.mode], index.project, SUMMARY_MAX_GAP_M)
      const firsts = await applyActivityCoverage(db, index, userId, a.id, a.mode, masks)
      await db.prepare('UPDATE activities SET new_segments = ? WHERE id = ?').bind(firsts, a.id).run()
    }
  }
  return added
}
