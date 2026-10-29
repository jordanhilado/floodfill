import { CITIES, type CityId } from '../lib/cities'
import type { Mode } from './coverage/apply'
import { getState } from './db'
import { stravaConfigured } from './strava/client'

// Every query below is for one user. Signed-out visitors pass null and match nothing, so they
// see the city with zero progress.
const uid = (userId: string | null) => userId ?? ''
import { RateLimiter } from './strava/rate-limit'

export type CoverageData = Awaited<ReturnType<typeof getCoverageData>>

type Totals = { meters: number; segments: number; streets: Map<string, number> }

// "Full streets" only counts named streets; paths count toward distance only.
const NAMED_STREET = `kind = 'street' AND name IS NOT NULL`
const totalsCache = new Map<string, Promise<Totals>>()

function cityTotals(db: D1Database, city: CityId, mode: Mode) {
  const key = `${city}:${mode}`
  let p = totalsCache.get(key)
  if (!p) {
    p = db
      .prepare(
        `SELECT CASE WHEN ${NAMED_STREET} THEN name END AS street, COUNT(*) AS n, SUM(length_m) AS m
         FROM segments WHERE city = ? AND ${mode} = 1 GROUP BY street`,
      )
      .bind(city)
      .all<{ street: string | null; n: number; m: number }>()
      .then(({ results }) => ({
        meters: results.reduce((a, r) => a + r.m, 0),
        segments: results.reduce((a, r) => a + r.n, 0),
        streets: new Map(results.filter((r) => r.street !== null).map((r) => [r.street!, r.n])),
      }))
    p.catch(() => totalsCache.delete(key))
    totalsCache.set(key, p)
  }
  return p
}

export async function getCoverageData(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  const [totals, { results }] = await Promise.all([
    cityTotals(db, city, mode),
    db
      .prepare(
        `SELECT s.id, CASE WHEN s.${NAMED_STREET} THEN s.name END AS street, s.length_m FROM coverage c JOIN segments s ON s.id = c.segment_id
         WHERE c.user_id = ? AND c.mode = ? AND c.completed = 1 AND s.city = ? AND s.${mode} = 1`,
      )
      .bind(uid(userId), mode, city)
      .all<{ id: number; street: string | null; length_m: number }>(),
  ])

  const doneByStreet = new Map<string, number>()
  let meters = 0
  for (const r of results) {
    meters += r.length_m
    if (r.street) doneByStreet.set(r.street, (doneByStreet.get(r.street) ?? 0) + 1)
  }
  let streetsCompleted = 0
  for (const [name, n] of doneByStreet) if (totals.streets.get(name) === n) streetsCompleted++

  return {
    city,
    mode,
    totalMeters: totals.meters,
    completedMeters: meters,
    percent: totals.meters ? (meters / totals.meters) * 100 : 0,
    totalSegments: totals.segments,
    totalStreets: totals.streets.size,
    streetsCompleted,
    completedIds: results.map((r) => r.id),
  }
}

export type SyncStatus = Awaited<ReturnType<typeof getSyncStatusData>>

export async function getSyncStatusData(db: D1Database, env: Env, userId: string | null) {
  const [counts, lastRun, account, limiter, rematch] = await Promise.all([
    db
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
      .bind(uid(userId))
      .first<{ total: number; counted: number | null; awaiting_detail: number | null; detailed: number | null; foot: number | null; bike: number | null }>(),
    db
      .prepare('SELECT started_at, finished_at, stop_reason, error, requests FROM sync_runs WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .bind(uid(userId))
      .first<{ started_at: number; finished_at: number | null; stop_reason: string | null; error: string | null; requests: number }>(),
    db
      .prepare('SELECT athlete_id, backfill_done, last_sync_at FROM strava_accounts WHERE user_id = ?')
      .bind(uid(userId))
      .first<{ athlete_id: number; backfill_done: number; last_sync_at: number | null }>(),
    RateLimiter.load(db, env),
    getState(db, 'rematch'),
  ])
  return {
    /** The app has Strava API credentials. */
    configured: stravaConfigured(env),
    /** This user has connected their Strava account. */
    connected: account !== null,
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
    rematchPending: rematch !== null,
    lastRun: lastRun ?? null,
    rate: limiter.snapshot(),
  }
}

export type NeighborhoodProgress = Awaited<ReturnType<typeof getNeighborhoodData>>[number]

const hoodTotalsCache = new Map<string, Promise<Map<string, number>>>()

/** Progress per neighborhood for one mode, highest completion first. */
export async function getNeighborhoodData(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  const key = `${city}:${mode}`
  let totals = hoodTotalsCache.get(key)
  if (!totals) {
    totals = db
      .prepare(
        `SELECT neighborhood, SUM(length_m) AS m FROM segments
         WHERE city = ? AND ${mode} = 1 AND neighborhood IS NOT NULL GROUP BY neighborhood`,
      )
      .bind(city)
      .all<{ neighborhood: string; m: number }>()
      .then(({ results }) => new Map(results.map((r) => [r.neighborhood, r.m])))
    totals.catch(() => hoodTotalsCache.delete(key))
    hoodTotalsCache.set(key, totals)
  }
  const [byHood, { results }] = await Promise.all([
    totals,
    db
      .prepare(
        `SELECT s.neighborhood, SUM(s.length_m) AS m FROM coverage c JOIN segments s ON s.id = c.segment_id
         WHERE c.user_id = ? AND c.mode = ? AND c.completed = 1 AND s.city = ? AND s.${mode} = 1 AND s.neighborhood IS NOT NULL
         GROUP BY s.neighborhood`,
      )
      .bind(uid(userId), mode, city)
      .all<{ neighborhood: string; m: number }>(),
  ])
  const done = new Map(results.map((r) => [r.neighborhood, r.m]))
  const activities = await activityCounts(db, city, mode, userId, 'neighborhood')
  return [...byHood]
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

/**
 * Distinct activities (of this mode) that touched each group: a neighborhood, or a street name.
 * `names` limits a street lookup to the rows being shown.
 */
async function activityCounts(
  db: D1Database,
  city: CityId,
  mode: Mode,
  userId: string | null,
  by: 'neighborhood' | 'name',
  names?: string[],
): Promise<Map<string, number>> {
  if (names && names.length === 0) return new Map()
  const { results } = await db
    .prepare(
      `SELECT s.${by} AS k, COUNT(DISTINCT a.activity_id) AS n
       FROM activity_segments a
       JOIN segments s ON s.id = a.segment_id
       JOIN activities act ON act.id = a.activity_id
       WHERE act.user_id = ? AND act.mode = ? AND s.city = ? AND s.${mode} = 1 AND s.${by} IS NOT NULL
       ${names ? `AND s.${by} IN (${names.map(() => '?').join(',')})` : ''}
       GROUP BY s.${by}`,
    )
    .bind(uid(userId), mode, city, ...(names ?? []))
    .all<{ k: string; n: number }>()
  return new Map(results.map((r) => [r.k, r.n]))
}

export type RankSort = 'progress' | 'activities'

// Every named street or path in this mode, with distance done, activities, and its rank:
// by progress then activities (default), or by activities then progress.
const RANKED_STREETS = (mode: Mode, sort: RankSort) => `
  WITH acts AS (
    SELECT s.name AS name, COUNT(DISTINCT a.activity_id) AS n
    FROM activity_segments a
    JOIN segments s ON s.id = a.segment_id
    JOIN activities act ON act.id = a.activity_id
    WHERE act.user_id = ?3 AND act.mode = ?1 AND s.city = ?2 AND s.${mode} = 1 AND s.name IS NOT NULL
    GROUP BY s.name
  ),
  st AS (
    SELECT s.name AS name,
           SUM(s.length_m) AS total,
           SUM(CASE WHEN c.completed = 1 THEN s.length_m ELSE 0 END) AS done,
           MIN(s.min_lng) AS x0, MIN(s.min_lat) AS y0, MAX(s.max_lng) AS x1, MAX(s.max_lat) AS y1,
           MAX(s.kind = 'street') AS is_street
    FROM segments s LEFT JOIN coverage c ON c.segment_id = s.id AND c.mode = ?1 AND c.user_id = ?3
    WHERE s.city = ?2 AND s.${mode} = 1 AND s.name IS NOT NULL
    GROUP BY s.name
  )
  SELECT st.*, COALESCE(acts.n, 0) AS activities,
         ROW_NUMBER() OVER (ORDER BY ${
           sort === 'activities'
             ? 'COALESCE(acts.n, 0) DESC, st.done / st.total DESC'
             : 'st.done / st.total DESC, COALESCE(acts.n, 0) DESC'
         }, st.done DESC, st.name) AS rank,
         COUNT(*) OVER () AS ranked
  FROM st LEFT JOIN acts ON acts.name = st.name`

type StreetRow = {
  name: string
  total: number
  done: number
  x0: number
  y0: number
  x1: number
  y1: number
  is_street: number
  activities: number
  rank: number
  ranked: number
}

export type StreetProgressRow = Awaited<ReturnType<typeof getStreetPage>>['rows'][number]

/** One page of streets ranked by progress; `q` filters by name but keeps the overall rank. */
export async function getStreetPage(
  db: D1Database,
  city: CityId,
  mode: Mode,
  userId: string | null,
  { q, offset, limit, sort }: { q: string; offset: number; limit: number; sort: RankSort },
) {
  const { results } = await db
    .prepare(
      `SELECT *, COUNT(*) OVER () AS matches FROM (${RANKED_STREETS(mode, sort)})
       WHERE ?4 = '' OR name LIKE ?4 ESCAPE '\\'
       ORDER BY rank LIMIT ?5 OFFSET ?6`,
    )
    .bind(mode, city, uid(userId), q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : '', limit, offset)
    .all<StreetRow & { matches: number }>()
  const matches = results[0]?.matches ?? 0
  return {
    rows: results.map((r) => ({
      name: r.name,
      rank: r.rank,
      path: r.is_street === 0,
      totalMeters: r.total,
      completedMeters: r.done,
      percent: (r.done / r.total) * 100,
      activities: r.activities,
      bbox: [r.x0, r.y0, r.x1, r.y1] as [number, number, number, number],
    })),
    /** Streets ranked in this mode (independent of the search). */
    ranked: results[0]?.ranked ?? (await countRanked(db, city, mode)),
    matches,
    nextOffset: offset + results.length < matches ? offset + results.length : null,
  }
}

async function countRanked(db: D1Database, city: CityId, mode: Mode) {
  const row = await db
    .prepare(`SELECT COUNT(DISTINCT name) AS n FROM segments WHERE city = ? AND ${mode} = 1 AND name IS NOT NULL`)
    .bind(city)
    .first<{ n: number }>()
  return row?.n ?? 0
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
    const row = await db
      .prepare(`SELECT rank, ranked, activities FROM (${RANKED_STREETS(mode, 'progress')}) WHERE name = ?4`)
      .bind(mode, city, uid(userId), target.name)
      .first<{ rank: number; ranked: number; activities: number }>()
    return { rank: row?.rank ?? null, ranked: row?.ranked ?? null, activities: row?.activities ?? 0 }
  }
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT a.activity_id) AS n FROM activity_segments a JOIN activities act ON act.id = a.activity_id
       WHERE a.segment_id = ? AND act.mode = ? AND act.user_id = ?`,
    )
    .bind(target.segmentId, mode, uid(userId))
    .first<{ n: number }>()
  return { rank: null, ranked: null, activities: row?.n ?? 0 }
}

export type LeaderboardRow = { rank: number; username: string; percent: number; meters: number; activities: number; you: boolean }

const LEADERBOARD_SIZE = 50

/**
 * Everyone with a username and a connected Strava account, ranked by the share of the city
 * done in this mode, then by activities. Returns the top of the board plus your own row.
 */
export async function getLeaderboard(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  const totals = await cityTotals(db, city, mode)
  const { results } = await db
    .prepare(
      `WITH done AS (
         SELECT c.user_id, SUM(s.length_m) AS m FROM coverage c JOIN segments s ON s.id = c.segment_id
         WHERE c.mode = ?1 AND c.completed = 1 AND s.city = ?2 AND s.${mode} = 1
         GROUP BY c.user_id
       ),
       acts AS (
         SELECT user_id, COUNT(*) AS n FROM activities
         WHERE mode = ?1 AND city = ?2 AND status != 'ignored' AND user_id IS NOT NULL
         GROUP BY user_id
       )
       SELECT u.id, u.username, COALESCE(done.m, 0) AS m, COALESCE(acts.n, 0) AS n,
              ROW_NUMBER() OVER (ORDER BY COALESCE(done.m, 0) DESC, COALESCE(acts.n, 0) DESC, u.username) AS rank,
              COUNT(*) OVER () AS players
       FROM users u
       JOIN strava_accounts sa ON sa.user_id = u.id
       LEFT JOIN done ON done.user_id = u.id
       LEFT JOIN acts ON acts.user_id = u.id
       WHERE u.username IS NOT NULL
       ORDER BY rank`,
    )
    .bind(mode, city)
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
    rows: results.slice(0, LEADERBOARD_SIZE).map(toRow),
    /** Your row when you're below the top of the board. */
    you: me && me.rank > LEADERBOARD_SIZE ? toRow(me) : null,
  }
}

export type CityStanding = Awaited<ReturnType<typeof getPersonalStandings>>[number]

/** Your standing in every city Floodfill covers, for one mode. */
export async function getPersonalStandings(db: D1Database, mode: Mode, userId: string) {
  return Promise.all(
    (Object.keys(CITIES) as CityId[]).map(async (city) => {
      const board = await getLeaderboard(db, city, mode, userId)
      const me = board.rows.find((r) => r.you) ?? board.you
      const totals = await cityTotals(db, city, mode)
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
