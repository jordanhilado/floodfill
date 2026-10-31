import type { ModeTotals } from '../../scripts/totals'
import { CITIES, CITY_IDS, type CityId } from '../lib/cities'
import { decodePolyline } from '../lib/polyline'
import type { Mode } from './coverage/apply'
import { rasterize, type CoverageRaster } from './coverage/raster'
import { stravaCapacity } from './strava/capacity'
import { stravaConfigured } from './strava/client'
import { RateLimiter } from './strava/rate-limit'
import { rematchPending } from './sync'

// Every per-user query below is skipped for signed-out visitors (null), who see the city with zero
// progress without touching D1.

// Static totals of the street network, summed from the D1 seed at build time (scripts/totals.ts),
// so page views don't scan `segments`. Regenerated whenever the seed is. Each city's file loads
// the first time it's needed, so big cities don't slow every Worker start. JSON can't type the
// `names` tuples, hence the cast; src/lib/totals.test.ts checks each file against its seed.
const TOTALS_FILES = import.meta.glob('../lib/totals.*.json', { import: 'default' })

async function totalsFor(city: CityId, mode: Mode): Promise<ModeTotals> {
  const totals = (await TOTALS_FILES[`../lib/totals.${city}.json`]()) as Record<Mode, ModeTotals>
  return totals[mode]
}

export type CoverageData = Awaited<ReturnType<typeof getCoverageData>>

// "Full streets" only counts named streets; paths count toward distance only.
// Must match NAMED_STREET in scripts/totals.ts.
const NAMED_STREET = `kind = 'street' AND name IS NOT NULL`

export async function getCoverageData(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  const [totals, results, counted] = await Promise.all([
    totalsFor(city, mode),
    userId === null
      ? []
      : db
          .prepare(
            `SELECT s.id, CASE WHEN s.${NAMED_STREET} THEN s.name END AS street, s.length_m FROM coverage c JOIN segments s ON s.id = c.segment_id
             WHERE c.user_id = ? AND c.mode = ? AND c.completed = 1 AND s.city = ? AND s.${mode} = 1`,
          )
          .bind(userId, mode, city)
          .all<{ id: number; street: string | null; length_m: number }>()
          .then((r) => r.results),
    userId === null
      ? null
      : db
          .prepare(`SELECT COUNT(*) AS n FROM activities WHERE user_id = ? AND mode = ? AND city = ? AND status != 'ignored'`)
          .bind(userId, mode, city)
          .first<{ n: number }>(),
  ])

  const doneByStreet = new Map<string, number>()
  let meters = 0
  for (const r of results) {
    meters += r.length_m
    if (r.street) doneByStreet.set(r.street, (doneByStreet.get(r.street) ?? 0) + 1)
  }
  let streetsCompleted = 0
  for (const [name, n] of doneByStreet) if (Object.hasOwn(totals.streets, name) && totals.streets[name] === n) streetsCompleted++

  return {
    city,
    mode,
    totalMeters: totals.meters,
    completedMeters: meters,
    percent: totals.meters ? (meters / totals.meters) * 100 : 0,
    totalSegments: totals.segments,
    totalStreets: Object.keys(totals.streets).length,
    streetsCompleted,
    /** Your counted activities in this city and mode. */
    activities: counted?.n ?? 0,
    completedIds: results.map((r) => r.id),
  }
}

export type SyncStatus = Awaited<ReturnType<typeof getSyncStatusData>>

export async function getSyncStatusData(db: D1Database, env: Env, userId: string | null) {
  const [counts, lastRun, account, limiter, rematch, capacity] = await Promise.all([
    userId === null
      ? null
      : db
          .prepare(
            `SELECT
               COUNT(*) AS total,
               SUM(status IN ('summary', 'detailed', 'error')) AS counted,
               SUM(status = 'summary') AS awaiting_detail,
               SUM(status = 'detailed') AS detailed,
               SUM(status != 'ignored' AND mode = 'foot') AS foot,
               SUM(status != 'ignored' AND mode = 'bike') AS bike
             FROM activities WHERE user_id = ?`,
          )
          .bind(userId)
          .first<{ total: number; counted: number | null; awaiting_detail: number | null; detailed: number | null; foot: number | null; bike: number | null }>(),
    userId === null
      ? null
      : db
          .prepare('SELECT started_at, finished_at, stop_reason, error, requests FROM sync_runs WHERE user_id = ? ORDER BY id DESC LIMIT 1')
          .bind(userId)
          .first<{ started_at: number; finished_at: number | null; stop_reason: string | null; error: string | null; requests: number }>(),
    userId === null
      ? null
      : db
          .prepare('SELECT athlete_id, backfill_done, last_sync_at FROM strava_accounts WHERE user_id = ?')
          .bind(userId)
          .first<{ athlete_id: number; backfill_done: number; last_sync_at: number | null }>(),
    RateLimiter.load(db, env),
    rematchPending(db),
    stravaCapacity(env),
  ])
  return {
    /** The app has Strava API credentials. */
    configured: stravaConfigured(env),
    /** This user has connected their Strava account. */
    connected: account !== null,
    /** The app is at Strava's limit on connected athletes: new people import an export instead. */
    stravaFull: capacity.full,
    activities: {
      total: counts?.total ?? 0,
      counted: counts?.counted ?? 0,
      awaitingDetail: counts?.awaiting_detail ?? 0,
      detailed: counts?.detailed ?? 0,
      foot: counts?.foot ?? 0,
      bike: counts?.bike ?? 0,
    },
    backfillDone: account?.backfill_done === 1,
    lastSyncAt: account?.last_sync_at ?? null,
    /** The street network changed and stored tracks still need re-matching (free). */
    rematchPending: rematch,
    lastRun: lastRun ?? null,
    rate: limiter.snapshot(),
  }
}

export type NeighborhoodProgress = Awaited<ReturnType<typeof getNeighborhoodData>>[number]

/** Progress per neighborhood for one mode, highest completion first. */
export async function getNeighborhoodData(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  const [done, activities] =
    userId === null
      ? [new Map<string, number>(), new Map<string, number>()]
      : await Promise.all([
          completedMeters(db, city, mode, userId, 'neighborhood'),
          activityCounts(db, city, mode, userId, 'neighborhood'),
        ])
  return Object.entries((await totalsFor(city, mode)).neighborhoods)
    .map(([name, totalMeters]) => {
      const completedMeters = done.get(name) ?? 0
      return {
        name,
        totalMeters,
        completedMeters,
        percent: (completedMeters / totalMeters) * 100,
        activities: activities.get(name) ?? 0,
      }
    })
    // Progress first; equal progress goes to the neighborhood with more activities.
    .sort((a, b) => b.percent - a.percent || b.activities - a.activities || a.name.localeCompare(b.name))
}

// The two queries below start from the user's own rows (CROSS JOIN keeps that join order), so
// they read only what this user has done rather than every segment in the city.

/** Meters completed in each group: a neighborhood, or a street name. */
async function completedMeters(db: D1Database, city: CityId, mode: Mode, userId: string, by: 'neighborhood' | 'name') {
  const { results } = await db
    .prepare(
      `SELECT s.${by} AS k, SUM(s.length_m) AS m
       FROM coverage c
       CROSS JOIN segments s ON s.id = c.segment_id
       WHERE c.user_id = ? AND c.mode = ? AND c.completed = 1 AND s.city = ? AND s.${mode} = 1 AND s.${by} IS NOT NULL
       GROUP BY s.${by}`,
    )
    .bind(userId, mode, city)
    .all<{ k: string; m: number }>()
  return new Map(results.map((r) => [r.k, r.m]))
}

/**
 * Distinct activities (of this mode) that touched each group: a neighborhood, or a street name.
 * Reads activity_groups, one row per activity and group, rather than every matched segment. An
 * activity only matches segments of its own mode in its own city, so those filters come from the
 * activity.
 */
async function activityCounts(db: D1Database, city: CityId, mode: Mode, userId: string, by: 'neighborhood' | 'name') {
  const { results } = await db
    .prepare(
      `SELECT g.key AS k, COUNT(*) AS n
       FROM activities act
       CROSS JOIN activity_groups g ON g.activity_id = act.id AND g.kind = ?
       WHERE act.user_id = ? AND act.mode = ? AND act.city = ?
       GROUP BY g.key`,
    )
    .bind(by, userId, mode, city)
    .all<{ k: string; n: number }>()
  return new Map(results.map((r) => [r.k, r.n]))
}

export type RankSort = 'progress' | 'activities'

/**
 * Every named street or path in this mode, with distance done, activities, and its rank:
 * by progress then activities (default), or by activities then progress.
 */
async function rankStreets(db: D1Database, city: CityId, mode: Mode, userId: string | null, sort: RankSort) {
  const [done, acts] =
    userId === null
      ? [new Map<string, number>(), new Map<string, number>()]
      : await Promise.all([completedMeters(db, city, mode, userId, 'name'), activityCounts(db, city, mode, userId, 'name')])
  const rows = (await totalsFor(city, mode)).names.map(([name, total, x0, y0, x1, y1, isStreet]) => ({
    name,
    total,
    done: done.get(name) ?? 0,
    activities: acts.get(name) ?? 0,
    bbox: [x0, y0, x1, y1] as [number, number, number, number],
    path: isStreet === 0,
  }))
  const progress = (r: (typeof rows)[number]) => r.done / r.total
  // Names come in SQLite's BINARY order and the sort is stable, so ties end ordered by name.
  rows.sort((a, b) =>
    sort === 'activities'
      ? b.activities - a.activities || progress(b) - progress(a) || b.done - a.done
      : progress(b) - progress(a) || b.activities - a.activities || b.done - a.done,
  )
  return rows.map((r, i) => ({ ...r, rank: i + 1 }))
}

// SQLite's LIKE: a substring match that ignores case for ASCII letters only.
const likeFold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

export type StreetProgressRow = Awaited<ReturnType<typeof getStreetPage>>['rows'][number]

/** One page of streets ranked by progress; `q` filters by name but keeps the overall rank. */
export async function getStreetPage(
  db: D1Database,
  city: CityId,
  mode: Mode,
  userId: string | null,
  { q, offset, limit, sort }: { q: string; offset: number; limit: number; sort: RankSort },
) {
  const ranked = await rankStreets(db, city, mode, userId, sort)
  const needle = likeFold(q)
  const matching = q ? ranked.filter((r) => likeFold(r.name).includes(needle)) : ranked
  const page = matching.slice(offset, offset + limit)
  return {
    rows: page.map((r) => ({
      name: r.name,
      rank: r.rank,
      path: r.path,
      totalMeters: r.total,
      completedMeters: r.done,
      percent: (r.done / r.total) * 100,
      activities: r.activities,
      bbox: r.bbox,
    })),
    /** Streets ranked in this mode (independent of the search). */
    ranked: ranked.length,
    matches: matching.length,
    nextOffset: offset + page.length < matching.length ? offset + page.length : null,
  }
}

/** Rank and activity count for one street (by name) or one unnamed segment. */
export async function getStreetDetail(
  db: D1Database,
  city: CityId,
  mode: Mode,
  userId: string | null,
  target: { name: string } | { segmentId: number },
) {
  if ('name' in target) {
    const ranked = await rankStreets(db, city, mode, userId, 'progress')
    const row = ranked.find((r) => r.name === target.name)
    return { rank: row?.rank ?? null, ranked: row ? ranked.length : null, activities: row?.activities ?? 0 }
  }
  if (userId === null) return { rank: null, ranked: null, activities: 0 }
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT a.activity_id) AS n FROM activity_segments a JOIN activities act ON act.id = a.activity_id
       WHERE a.segment_id = ? AND act.mode = ? AND act.user_id = ?`,
    )
    .bind(target.segmentId, mode, userId)
    .first<{ n: number }>()
  return { rank: null, ranked: null, activities: row?.n ?? 0 }
}

export type LeaderboardRow = { rank: number; username: string; percent: number; meters: number; activities: number; you: boolean }

const LEADERBOARD_SIZE = 50

/**
 * Recomputes the totals of users whose coverage changed since they were last read. Usually there
 * are none, and finding that out is one indexed read.
 */
export async function refreshUserStats(db: D1Database) {
  if (!(await db.prepare('SELECT 1 AS x FROM user_stats WHERE stale = 1 LIMIT 1').first())) return
  await db
    .prepare(
      `UPDATE user_stats SET
         meters = COALESCE((
           SELECT SUM(s.length_m) FROM coverage c CROSS JOIN segments s ON s.id = c.segment_id
           WHERE c.user_id = user_stats.user_id AND c.mode = user_stats.mode AND c.completed = 1
             AND s.city = user_stats.city AND (CASE user_stats.mode WHEN 'bike' THEN s.bike ELSE s.foot END) = 1
         ), 0),
         activities = (
           SELECT COUNT(*) FROM activities a
           WHERE a.user_id = user_stats.user_id AND a.mode = user_stats.mode AND a.city = user_stats.city AND a.status != 'ignored'
         ),
         stale = 0
       WHERE stale = 1`,
    )
    .run()
}

/**
 * Everyone with a username and a connected Strava account or imported activities, ranked by the share of the city
 * done in this mode, then by activities. Returns the top of the board plus your own row.
 */
export async function getLeaderboard(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  await refreshUserStats(db)
  return leaderboard(db, city, mode, userId)
}

/** The leaderboard from user_stats as it stands: call refreshUserStats first. */
async function leaderboard(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  const totals = await totalsFor(city, mode)
  // One row per player from user_stats; only the top of the board and your own row come back.
  const { results } = await db
    .prepare(
      `WITH board AS (
         SELECT u.id, u.username, COALESCE(st.meters, 0) AS m, COALESCE(st.activities, 0) AS n,
                ROW_NUMBER() OVER (ORDER BY COALESCE(st.meters, 0) DESC, COALESCE(st.activities, 0) DESC, u.username) AS rank,
                COUNT(*) OVER () AS players
         FROM users u
         LEFT JOIN user_stats st ON st.user_id = u.id AND st.city = ?2 AND st.mode = ?1
         WHERE u.username IS NOT NULL
           AND (EXISTS (SELECT 1 FROM strava_accounts sa WHERE sa.user_id = u.id)
             OR EXISTS (SELECT 1 FROM activities a WHERE a.user_id = u.id))
       )
       SELECT * FROM board WHERE rank <= ?3 OR id = ?4 ORDER BY rank`,
    )
    .bind(mode, city, LEADERBOARD_SIZE, userId)
    .all<{ id: string; username: string; m: number; n: number; rank: number; players: number }>()
  const toRow = (r: (typeof results)[number]): LeaderboardRow => ({
    rank: r.rank,
    username: r.username,
    meters: r.m,
    percent: totals.meters ? (r.m / totals.meters) * 100 : 0,
    activities: r.n,
    you: r.id === userId,
  })
  const me = results.find((r) => r.id === userId)
  return {
    city,
    players: results[0]?.players ?? 0,
    rows: results.filter((r) => r.rank <= LEADERBOARD_SIZE).map(toRow),
    /** Your row when you're below the top of the board. */
    you: me && me.rank > LEADERBOARD_SIZE ? toRow(me) : null,
  }
}

export type CityStanding = Awaited<ReturnType<typeof getPersonalStandings>>[number]

/** Your standing in every city Floodfill covers, for one mode. */
export async function getPersonalStandings(db: D1Database, mode: Mode, userId: string) {
  await refreshUserStats(db)
  return Promise.all(
    CITY_IDS.map(async (city) => {
      const [board, totals] = await Promise.all([leaderboard(db, city, mode, userId), totalsFor(city, mode)])
      const me = board.rows.find((r) => r.you) ?? board.you
      return {
        city,
        name: CITIES[city].name,
        rank: me?.rank ?? null,
        players: board.players,
        percent: me?.percent ?? 0,
        meters: me?.meters ?? 0,
        totalMeters: totals.meters,
        activities: me?.activities ?? 0,
      }
    }),
  )
}

export type Profile = NonNullable<Awaited<ReturnType<typeof getProfile>>>

/** Anyone's public profile: their username and standing in every city, on foot and by bike. */
export async function getProfile(db: D1Database, username: string) {
  const user = await db
    .prepare(
      `SELECT u.id, u.username, u.created_at, u.x_username, CASE WHEN u.show_strava = 1 THEN sa.athlete_id END AS athlete_id
       FROM users u LEFT JOIN strava_accounts sa ON sa.user_id = u.id WHERE u.username = ?`,
    )
    .bind(username)
    .first<{ id: string; username: string; created_at: number; x_username: string | null; athlete_id: number | null }>()
  if (!user) return null
  const [foot, bike] = await Promise.all([getPersonalStandings(db, 'foot', user.id), getPersonalStandings(db, 'bike', user.id)])
  // Formatted here (in UTC) so the server and browser render the same month.
  const joined = new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  return {
    username: user.username,
    joined,
    /** Links the person chose to show. */
    x: user.x_username,
    strava: user.athlete_id ? `https://www.strava.com/athletes/${user.athlete_id}` : null,
    foot,
    bike,
  }
}

export type ProfileMaps = Awaited<ReturnType<typeof getProfileMaps>>

/**
 * An image of the paths someone has completed in each city, for one mode: null in cities where
 * they haven't completed any, and empty when no one uses the username.
 */
export async function getProfileMaps(db: D1Database, username: string, mode: Mode) {
  const maps: Partial<Record<CityId, CoverageRaster | null>> = {}
  const user = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: string }>()
  if (!user) return maps
  await Promise.all(
    CITY_IDS.map(async (city) => {
      const { results } = await db
        .prepare(
          `SELECT s.coords FROM coverage c JOIN segments s ON s.id = c.segment_id
           WHERE c.user_id = ? AND c.mode = ? AND c.completed = 1 AND s.city = ? AND s.${mode} = 1`,
        )
        .bind(user.id, mode, city)
        .all<{ coords: string }>()
      maps[city] = results.length ? rasterize(city, results.map((r) => decodePolyline(r.coords, 6))) : null
    }),
  )
  return maps
}
