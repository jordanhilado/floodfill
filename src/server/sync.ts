import { CITIES, DEFAULT_CITY, type CityId } from '../lib/cities'
import { bboxIntersects, bboxOf } from '../lib/geo'
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
  opts: { trigger: 'manual' | 'cron'; timeBudgetMs: number; userId?: string; city?: CityId },
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
  const lockUntil = deadline + 60_000
  const lock = await db
    .prepare(
      `INSERT INTO state (key, value, updated_at) VALUES ('sync_lock', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE CAST(state.value AS INTEGER) < ?`,
    )
    .bind(String(lockUntil), started, started)
    .run()
  if (lock.meta.changes !== 1) return { ...result, stopReason: 'busy' }

  const run = await db
    .prepare('INSERT INTO sync_runs (trigger, started_at, user_id) VALUES (?, ?, ?) RETURNING id')
    .bind(opts.trigger, started, opts.userId ?? null)
    .first<{ id: number }>()

  const limiter = await RateLimiter.load(db, env)
  const city = opts.city ?? DEFAULT_CITY
  const index = await loadCityIndex(db, city)
  const outOfTime = () => Date.now() > deadline

  try {
    // 0. After the street network is rebuilt, re-match stored tracks. No API requests.
    result.rematched = await rematch(db, index, outOfTime)

    for (const account of accounts.results) {
      if (outOfTime()) break
      await syncAccount(db, env, limiter, index, city, account, outOfTime, result)
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
      db.prepare(`UPDATE state SET value = '0' WHERE key = 'sync_lock'`),
    ])
  }
  return result
}

/** One user's import: new activities, history backfill, then full GPS streams. */
async function syncAccount(
  db: D1Database,
  env: Env,
  limiter: RateLimiter,
  index: CityIndex,
  city: CityId,
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
      result.listed += await ingest(db, index, city, userId, acts)
      if (acts.length < PER_PAGE) break
    }
  }

  // 2. Backfill history, newest to oldest, one page (200 activities) per request.
  let { backfill_before: before, backfill_done: done } = account
  while (!done && !outOfTime()) {
    const acts = await client.listActivities(before ? { before } : {})
    result.listed += await ingest(db, index, city, userId, acts)
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
      .prepare(`SELECT id, mode FROM activities WHERE user_id = ? AND status = 'summary' ORDER BY start_ts DESC LIMIT 25`)
      .bind(userId)
      .all<{ id: number; mode: Mode }>()
    if (pending.length === 0) break
    for (const act of pending) {
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
  await touch()
}

type RematchCursor = { ts: number; id: number }

/**
 * Re-credits every counted activity against the current network, oldest first so each
 * segment's completing activity comes out right. Resumable via the `rematch` cursor,
 * which the street seed sets and this clears once everything has been re-matched.
 */
async function rematch(db: D1Database, index: CityIndex, outOfTime: () => boolean) {
  const cursor = await getState<RematchCursor>(db, 'rematch')
  if (!cursor) return 0
  let done = 0
  while (!outOfTime()) {
    const { results } = await db
      .prepare(
        `SELECT id, user_id, mode, start_ts, polyline, summary_polyline FROM activities
         WHERE status != 'ignored' AND user_id IS NOT NULL AND (start_ts > ? OR (start_ts = ? AND id > ?))
         ORDER BY start_ts, id LIMIT 20`,
      )
      .bind(cursor.ts, cursor.ts, cursor.id)
      .all<ActivityTrack & { start_ts: number }>()
    if (results.length === 0) {
      await db.prepare(`DELETE FROM state WHERE key = 'rematch'`).run()
      break
    }
    for (const a of results) {
      await recredit(db, index, a)
      cursor.ts = a.start_ts
      cursor.id = a.id
      done++
    }
    await setState(db, 'rematch', cursor)
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
async function ingest(db: D1Database, index: CityIndex, city: CityId, userId: string, acts: StravaSummaryActivity[]) {
  const known = new Set<number>()
  for (const ids of chunk(acts.map((a) => a.id), MAX_PARAMS - 1)) {
    const marks = ids.map(() => '?').join(',')
    // Activities imported before accounts existed have no owner: they belong to this athlete.
    const { results: claimed } = await db
      .prepare(
        `UPDATE activities SET user_id = ? WHERE user_id IS NULL AND id IN (${marks})
         RETURNING id, user_id, mode, status, polyline, summary_polyline`,
      )
      .bind(userId, ...ids)
      .all<ActivityTrack & { status: string }>()
    try {
      for (const a of claimed) if (a.status !== 'ignored' && a.mode) await recredit(db, index, a)
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

  const [[minLng, minLat], [maxLng, maxLat]] = CITIES[city].bounds
  const cityBox = { minLat, minLng, maxLat, maxLng }
  let added = 0
  for (const a of acts) {
    if (known.has(a.id)) continue
    const mode = modeFor(a.sport_type)
    const summary = a.map?.summary_polyline || null
    const track = mode && summary ? decodePolyline(summary) : []
    const relevant = track.length >= 2 && bboxIntersects(bboxOf(track), cityBox)
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
        relevant ? city : null,
        summary,
        relevant ? 'summary' : 'ignored',
        Date.now(),
      )
      .run()
    added++
    if (relevant && mode) {
      const masks = matchTrack(track, index.forMode[mode], index.project, SUMMARY_MAX_GAP_M)
      const firsts = await applyActivityCoverage(db, index, userId, a.id, mode, masks)
      await db.prepare('UPDATE activities SET new_segments = ? WHERE id = ?').bind(firsts, a.id).run()
    }
  }
  return added
}
