import type { ModeTotals } from '../../scripts/totals'
import { CITIES, type CityId } from '../lib/cities'
import sfTotals from '../lib/totals.sf.json'
import type { Mode } from './coverage/apply'
import { getState } from './db'
import { stravaConfigured } from './strava/client'
import { RateLimiter } from './strava/rate-limit'

// Every per-user query below is skipped for signed-out visitors (null), who see the city with zero
// progress without touching D1.

// Static totals of the street network, summed from the D1 seed at build time (scripts/totals.ts),
// so page views don't scan `segments`. Regenerated whenever the seed is. JSON can't type the
// `names` tuples, hence the cast; src/lib/totals.test.ts checks the file against the seed.
const TOTALS = { sf: sfTotals } as unknown as Record<CityId, Record<Mode, ModeTotals>>

export type CoverageData = Awaited<ReturnType<typeof getCoverageData>>

// "Full streets" only counts named streets; paths count toward distance only.
// Must match NAMED_STREET in scripts/totals.ts.
const NAMED_STREET = `kind = 'street' AND name IS NOT NULL`

export async function getCoverageData(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  const totals = TOTALS[city][mode]
  const results =
    userId === null
      ? []
      : (
          await db
            .prepare(
              `SELECT s.id, CASE WHEN s.${NAMED_STREET} THEN s.name END AS street, s.length_m FROM coverage c JOIN segments s ON s.id = c.segment_id
               WHERE c.user_id = ? AND c.mode = ? AND c.completed = 1 AND s.city = ? AND s.${mode} = 1`,
            )
            .bind(userId, mode, city)
            .all<{ id: number; street: string | null; length_m: number }>()
        ).results

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
    completedIds: results.map((r) => r.id),
  }
}

export type SyncStatus = Awaited<ReturnType<typeof getSyncStatusData>>

export async function getSyncStatusData(db: D1Database, env: Env, userId: string | null) {
  const [counts, lastRun, account, limiter, rematch] = await Promise.all([
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

/** Progress per neighborhood for one mode, highest completion first. */
export async function getNeighborhoodData(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  const [done, activities] =
    userId === null
      ? [new Map<string, number>(), new Map<string, number>()]
      : await Promise.all([
          completedMeters(db, city, mode, userId, 'neighborhood'),
          activityCounts(db, city, mode, userId, 'neighborhood'),
        ])
  return Object.entries(TOTALS[city][mode].neighborhoods)
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
  const rows = TOTALS[city][mode].names.map(([name, total, x0, y0, x1, y1, isStreet]) => ({
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
 * Everyone with a username and a connected Strava account, ranked by the share of the city
 * done in this mode, then by activities. Returns the top of the board plus your own row.
 */
export async function getLeaderboard(db: D1Database, city: CityId, mode: Mode, userId: string | null) {
  const totals = TOTALS[city][mode]
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
      return {
        city,
        name: CITIES[city].name,
        rank: me?.rank ?? null,
        players: board.players,
        percent: me?.percent ?? 0,
        meters: me?.meters ?? 0,
        totalMeters: TOTALS[city][mode].meters,
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
