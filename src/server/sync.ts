import { CITIES, CITY_IDS, cityForTrack, type CityId } from '../lib/cities'
import { decodePolyline, encodePolyline } from '../lib/polyline'
import { modeFor } from '../lib/sports'
import { applyActivityCoverage, type Mode } from './coverage/apply'
import { matchTrack } from './coverage/match'
import { loadCityIndex, type CityIndex } from './coverage/segments'
import { chunk, getState, MAX_PARAMS, setState } from './db'
import { StravaAuthError, StravaClient, StravaError, stravaConfigured, type StravaAccount, type StravaSummaryActivity } from './strava/client'
import { RateBudgetExhausted, RateLimiter } from './strava/rate-limit'

/** Summary polylines are simplified, so long straight edges are expected. */
const SUMMARY_MAX_GAP_M = 2000
/** Full-resolution streams sample every ~1 s; longer jumps are GPS dropouts. */
const STREAM_MAX_GAP_M = 150
const PER_PAGE = 200
/** With webhooks on, accounts with no events are still listed this often, in case one was missed. */
const WEBHOOK_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000
/** How long sync_runs rows are kept. */
const RUN_LOG_MS = 30 * 24 * 60 * 60 * 1000

/** Strava webhooks are set up (see routes/api/strava/webhook.ts), so new activities arrive as events. */
export const webhooksEnabled = (env: Env) => Boolean(env.STRAVA_WEBHOOK_TOKEN)

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
  // The cron lists every account each run unless webhooks say who has something new. Strava's
  // read budget (2,000 a day by default) can't poll more than a few dozen accounts every 15
  // minutes, so with many users webhooks are what keeps everyone current.
  const accounts = opts.userId
    ? await db.prepare('SELECT * FROM strava_accounts WHERE user_id = ?').bind(opts.userId).all<StravaAccount>()
    : webhooksEnabled(env)
      ? await db
          .prepare(
            `SELECT * FROM strava_accounts WHERE pending_sync = 1 OR backfill_done = 0 OR COALESCE(last_sync_at, 0) < ?
             ORDER BY COALESCE(last_sync_at, 0)`,
          )
          .bind(Date.now() - WEBHOOK_FALLBACK_MS)
          .all<StravaAccount>()
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

    if (opts.trigger === 'cron') {
      await db.prepare('DELETE FROM sync_runs WHERE started_at < ?').bind(started - RUN_LOG_MS).run()
      await applyDeletions(db, env, limiter, outOfTime)
    }

    for (const account of accounts.results) {
      if (outOfTime()) break
      try {
        await syncAccount(db, env, limiter, account, outOfTime, result)
      } catch (err) {
        // The rate budget is shared, so running out stops everyone. A manual sync reports its error.
        if (err instanceof RateBudgetExhausted || opts.userId) throw err
        // One account's trouble mustn't stop the run for everyone after it, or keep it first in
        // line for the next run.
        console.error(`sync failed for ${account.user_id}`, err)
        await db.prepare('UPDATE strava_accounts SET last_sync_at = ? WHERE user_id = ?').bind(Date.now(), account.user_id).run()
        result.error = err instanceof Error ? err.message : String(err)
      }
    }
    if (outOfTime()) result.stopReason = 'time'
  } catch (err) {
    if (err instanceof RateBudgetExhausted) {
      result.stopReason = 'rate_limit'
      result.resumeAt = err.resetAt
    } else if (err instanceof StravaAuthError) {
      result.stopReason = 'error'
      result.error = 'Strava access was revoked. Connect Strava again from Settings.'
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
  try {
    await listAndMatch(db, client, account, outOfTime, result)
  } catch (err) {
    if (!(err instanceof StravaAuthError)) throw err
    // Access was revoked: drop the dead tokens so the account frees its place under Strava's
    // athlete limit and the app asks to connect again. Activities and progress stay.
    console.warn(`strava access revoked for ${userId}; disconnecting`)
    await db.prepare('DELETE FROM strava_accounts WHERE user_id = ?').bind(userId).run()
    throw err
  }
  await db.prepare('UPDATE strava_accounts SET last_sync_at = ? WHERE user_id = ?').bind(Date.now(), userId).run()
}

async function listAndMatch(db: D1Database, client: StravaClient, account: StravaAccount, outOfTime: () => boolean, result: SyncResult) {
  const userId = account.user_id
  // Cleared before listing, so an event that arrives meanwhile flags the account again.
  await db.prepare('UPDATE strava_accounts SET pending_sync = 0 WHERE user_id = ?').bind(userId).run()

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
}

/**
 * Removes activities that Strava's webhook says were deleted. Webhook calls aren't signed, so each
 * deletion is checked with Strava first: one request each, and deletions are rare.
 */
async function applyDeletions(db: D1Database, env: Env, limiter: RateLimiter, outOfTime: () => boolean) {
  const { results } = await db
    .prepare(
      `SELECT d.activity_id, a.mode, a.city, sa.* FROM strava_deletions d
       LEFT JOIN activities a ON a.id = d.activity_id
       LEFT JOIN strava_accounts sa ON sa.athlete_id = d.athlete_id AND sa.user_id = a.user_id
       ORDER BY d.received_at LIMIT 50`,
    )
    .all<{ activity_id: number; mode: Mode | null; city: string | null } & Partial<StravaAccount>>()
  for (const d of results) {
    if (outOfTime()) break
    // Only the Strava owner's own copy, and only once Strava confirms it's gone.
    if (d.user_id && d.access_token) {
      const account = d as StravaAccount
      if (!(await new StravaClient(db, env, limiter, account).activityExists(d.activity_id))) {
        if (d.city && d.mode && Object.hasOwn(CITIES, d.city)) {
          // With no matches, this clears the activity's segments and recomputes the owner's coverage.
          await applyActivityCoverage(db, await loadCityIndex(db, d.city as CityId), account.user_id, d.activity_id, d.mode, new Map())
        }
        await db.prepare('DELETE FROM activities WHERE id = ? AND user_id = ?').bind(d.activity_id, account.user_id).run()
      }
    }
    await db.prepare('DELETE FROM strava_deletions WHERE activity_id = ?').bind(d.activity_id).run()
  }
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
        // Imported activities only have the full track.
        .prepare(
          `SELECT id, start_ts, COALESCE(summary_polyline, polyline) AS track FROM activities
           WHERE status = 'ignored' AND mode IS NOT NULL AND user_id IS NOT NULL
             AND (summary_polyline IS NOT NULL OR polyline IS NOT NULL)
             AND (start_ts > ? OR (start_ts = ? AND id > ?))
           ORDER BY start_ts, id LIMIT 200`,
        )
        .bind(cursor.ts, cursor.ts, cursor.id)
        .all<{ id: number; start_ts: number; track: string }>()
      const found = results.filter((a) => cityForTrack(decodePolyline(a.track)) === city)
      for (const ids of chunk(found.map((a) => a.id), MAX_PARAMS - 3)) {
        // A full track needs nothing more from Strava.
        await db
          .prepare(
            `UPDATE activities SET city = ?, status = CASE WHEN polyline IS NULL THEN 'summary' ELSE 'detailed' END, updated_at = ?
             WHERE id IN (${ids.map(() => '?').join(',')})`,
          )
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
export async function ingest(db: D1Database, userId: string, acts: StravaSummaryActivity[]) {
  const known = new Set<number>()
  for (const ids of chunk(acts.map((a) => a.id), MAX_PARAMS - 1)) {
    const marks = ids.map(() => '?').join(',')
    await releaseForeign(db, userId, ids, marks)
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

/**
 * Strava lists an activity only to the athlete who owns it, so a row another user holds under
 * the same id came from an export import with a borrowed id. Undo that user's credit for it and
 * drop the row, so the owner's copy goes in fresh.
 */
async function releaseForeign(db: D1Database, userId: string, ids: number[], marks: string) {
  const { results } = await db
    .prepare(`SELECT id, user_id, mode, city FROM activities WHERE user_id IS NOT NULL AND user_id != ? AND id IN (${marks})`)
    .bind(userId, ...ids)
    .all<{ id: number; user_id: string; mode: Mode | null; city: CityId | null }>()
  for (const a of results) {
    console.warn(`[floodfill] activity ${a.id} held by ${a.user_id} returned to its Strava owner ${userId}`)
    // With no matches, this clears the activity's segments and recomputes the holder's coverage.
    if (a.city && a.mode && CITIES[a.city]) await applyActivityCoverage(db, await loadCityIndex(db, a.city), a.user_id, a.id, a.mode, new Map())
    await db.prepare('DELETE FROM activities WHERE id = ? AND user_id = ?').bind(a.id, a.user_id).run()
  }
}

/** One activity from a Strava export (see src/lib/strava-export.ts), with its full GPS track. */
export type ImportedActivity = {
  id: number
  name: string
  sportType: string
  startDate: string
  distanceM: number
  movingTimeS: number
  /** Precision 5, like Strava's own polylines. */
  polyline: string
}

/**
 * Stores activities from someone's Strava export and credits them from their full tracks, for
 * people who can't connect Strava (see strava/capacity.ts). No Strava requests. Activities
 * already stored (by an earlier import or the API) are skipped. Returns how many were new.
 */
export async function importActivities(db: D1Database, userId: string, acts: ImportedActivity[]) {
  const known = new Set<number>()
  for (const ids of chunk(acts.map((a) => a.id), MAX_PARAMS)) {
    const { results } = await db
      .prepare(`SELECT id FROM activities WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ id: number }>()
    for (const r of results) known.add(r.id)
  }

  let added = 0
  const toMatch: { id: number; city: CityId; mode: Mode; track: [number, number][] }[] = []
  for (const a of acts) {
    if (known.has(a.id)) continue
    known.add(a.id)
    const mode = modeFor(a.sportType)
    const track = decodePolyline(a.polyline)
    const city = mode && track.length >= 2 ? cityForTrack(track) : null
    await db
      .prepare(
        `INSERT INTO activities (id, user_id, name, sport_type, mode, start_date, start_ts, distance_m, moving_time_s, city, polyline, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        a.id,
        userId,
        a.name,
        a.sportType,
        mode,
        a.startDate,
        toTs(a.startDate),
        a.distanceM,
        a.movingTimeS,
        city,
        // Kept outside every city too, so a city that opens later can credit it.
        mode && track.length >= 2 ? a.polyline : null,
        city ? 'detailed' : 'ignored',
        Date.now(),
      )
      .run()
    added++
    if (city && mode) toMatch.push({ id: a.id, city, mode, track })
  }

  for (const [city, group] of byCity(toMatch)) {
    const index = await loadCityIndex(db, city!)
    for (const a of group) {
      const masks = matchTrack(a.track, index.forMode[a.mode], index.project, STREAM_MAX_GAP_M)
      const firsts = await applyActivityCoverage(db, index, userId, a.id, a.mode, masks)
      await db.prepare('UPDATE activities SET new_segments = ? WHERE id = ?').bind(firsts, a.id).run()
    }
  }
  return added
}
