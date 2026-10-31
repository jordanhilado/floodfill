import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { seededDatabase } from '../../scripts/totals'
import { getCoverageData, getLeaderboard, getNeighborhoodData, getStreetDetail, getStreetPage, type RankSort } from './queries'

/** D1's statement API over an in-memory SQLite database. */
function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...(args as [])) }),
    first: async () => db.prepare(sql).all(...(args as []))[0] ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as [])).changes) } }),
  })
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database
}

/** A database that fails the test if anything queries it. */
const untouchable = {
  prepare: () => {
    throw new Error('queried D1')
  },
} as unknown as D1Database

describe('signed-out visitors', () => {
  it('get zero progress without querying D1', async () => {
    const coverage = await getCoverageData(untouchable, 'sf', 'foot', null)
    expect(coverage.completedMeters).toBe(0)
    expect(coverage.completedIds).toEqual([])
    expect(coverage.totalMeters).toBeGreaterThan(0)

    const hoods = await getNeighborhoodData(untouchable, 'sf', 'bike', null)
    expect(hoods.length).toBeGreaterThan(0)
    expect(hoods.every((h) => h.completedMeters === 0 && h.activities === 0)).toBe(true)

    const page = await getStreetPage(untouchable, 'sf', 'foot', null, { q: '', offset: 0, limit: 50, sort: 'progress' })
    expect(page.rows).toHaveLength(50)
    expect(page.rows.every((r) => r.completedMeters === 0)).toBe(true)

    await getStreetDetail(untouchable, 'sf', 'foot', null, { name: 'Market Street' })
    await getStreetDetail(untouchable, 'sf', 'foot', null, { segmentId: 1 })
  })
})

// The street ranking as one SQL query, as it ran before totals were precomputed.
const RANKED_STREETS = (mode: 'foot' | 'bike', sort: RankSort) => `
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

describe('street ranking', async () => {
  const db = await seededDatabase('sf')
  // Two users with overlapping activity; u1's progress leaves plenty of ties to break.
  const insAct = db.prepare(
    `INSERT INTO activities (id, mode, city, start_date, start_ts, status, updated_at, user_id) VALUES (?, ?, 'sf', '', 0, 'detailed', 0, ?)`,
  )
  const insSeg = db.prepare('INSERT OR IGNORE INTO activity_segments (activity_id, segment_id, mask) VALUES (?, ?, 1)')
  const insCov = db.prepare(`INSERT OR IGNORE INTO coverage (user_id, segment_id, mode, mask, completed) VALUES (?, ?, ?, 1, ?)`)
  for (let a = 1; a <= 60; a++) insAct.run(a, a % 4 === 0 ? 'bike' : 'foot', a <= 50 ? 'u1' : 'u2')
  const segs = db.prepare('SELECT id, foot, bike FROM segments WHERE id <= 9000').all() as { id: number; foot: number; bike: number }[]
  for (const { id, foot, bike } of segs) {
    const a = 1 + (id % 60)
    const mode = a % 4 === 0 ? 'bike' : 'foot'
    // Like the matcher, an activity only covers segments open to its own mode.
    if ((mode === 'foot' ? foot : bike) === 1) insSeg.run(a, id)
    insCov.run(a <= 50 ? 'u1' : 'u2', id, mode, id % 7 === 0 ? 0 : 1)
  }
  // The streets and neighborhoods each activity touched, as migrations/0007 backfills them.
  db.exec(`
    INSERT INTO activity_groups (activity_id, kind, key)
    SELECT DISTINCT a.activity_id, 'neighborhood', s.neighborhood FROM activity_segments a JOIN segments s ON s.id = a.segment_id
    WHERE s.neighborhood IS NOT NULL;
    INSERT INTO activity_groups (activity_id, kind, key)
    SELECT DISTINCT a.activity_id, 'name', s.name FROM activity_segments a JOIN segments s ON s.id = a.segment_id
    WHERE s.name IS NOT NULL;`)
  const D1 = d1(db)

  it('counts activities per neighborhood like the SQL over every matched segment', async () => {
    for (const mode of ['foot', 'bike'] as const) {
      const old = db
        .prepare(
          `SELECT s.neighborhood AS k, COUNT(DISTINCT a.activity_id) AS n
           FROM activities act JOIN activity_segments a ON a.activity_id = act.id JOIN segments s ON s.id = a.segment_id
           WHERE act.user_id = 'u1' AND act.mode = ? AND s.city = 'sf' AND s.${mode} = 1 AND s.neighborhood IS NOT NULL
           GROUP BY s.neighborhood`,
        )
        .all(mode) as { k: string; n: number }[]
      expect(old.length).toBeGreaterThan(0)
      const hoods = await getNeighborhoodData(D1, 'sf', mode, 'u1')
      expect(Object.fromEntries(hoods.filter((h) => h.activities > 0).map((h) => [h.name, h.activities]))).toEqual(
        Object.fromEntries(old.map((r) => [r.k, r.n])),
      )
    }
  })

  for (const mode of ['foot', 'bike'] as const)
    for (const sort of ['progress', 'activities'] as const)
      for (const [user, q, offset] of [
        ['u1', '', 0],
        ['u1', '', 50],
        ['u1', 'street', 50],
        ['u1', 'ST_', 0],
        [null, '', 0],
      ] as const)
        it(`matches the SQL ranking (${mode}, ${sort}, ${user}, '${q}', ${offset})`, async () => {
          const old = db
            .prepare(
              `SELECT *, COUNT(*) OVER () AS matches FROM (${RANKED_STREETS(mode, sort)})
               WHERE ?4 = '' OR name LIKE ?4 ESCAPE '\\' ORDER BY rank LIMIT ?5 OFFSET ?6`,
            )
            .all(mode, 'sf', user ?? '', q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : '', 50, offset) as Record<string, number>[]
          const page = await getStreetPage(D1, 'sf', mode, user, { q, offset, limit: 50, sort })
          expect(page.rows).toEqual(
            old.map((r) => ({
              name: r.name,
              rank: r.rank,
              path: r.is_street === 0,
              totalMeters: r.total,
              completedMeters: r.done,
              percent: (r.done / r.total) * 100,
              activities: r.activities,
              bbox: [r.x0, r.y0, r.x1, r.y1],
            })),
          )
          expect(page.matches).toBe(old[0]?.matches ?? 0)
          if (old.length) expect(page.ranked).toBe(old[0].ranked)
        })

  it('ranks one street the same way', async () => {
    for (const name of ['Market Street', '15', 'No Such Street']) {
      const old = db.prepare(`SELECT rank, ranked, activities FROM (${RANKED_STREETS('foot', 'progress')}) WHERE name = ?4`).get('foot', 'sf', 'u1', name) as
        | { rank: number; ranked: number; activities: number }
        | undefined
      expect(await getStreetDetail(D1, 'sf', 'foot', 'u1', { name })).toEqual({
        rank: old?.rank ?? null,
        ranked: old?.ranked ?? null,
        activities: old?.activities ?? 0,
      })
    }
  })
})

// The leaderboard as one SQL query over every completed segment, as it ran before user_stats.
const FULL_LEADERBOARD = (mode: 'foot' | 'bike') => `
  WITH done AS (
    SELECT c.user_id, SUM(s.length_m) AS m FROM coverage c JOIN segments s ON s.id = c.segment_id
    WHERE c.mode = ?1 AND c.completed = 1 AND s.city = ?2 AND s.${mode} = 1
    GROUP BY c.user_id
  ),
  acts AS (
    SELECT user_id, COUNT(*) AS n FROM activities
    WHERE mode = ?1 AND city = ?2 AND status != 'ignored' AND user_id IS NOT NULL
    GROUP BY user_id
  )
  SELECT u.username, COALESCE(done.m, 0) AS m, COALESCE(acts.n, 0) AS n,
         ROW_NUMBER() OVER (ORDER BY COALESCE(done.m, 0) DESC, COALESCE(acts.n, 0) DESC, u.username) AS rank
  FROM users u
  LEFT JOIN done ON done.user_id = u.id
  LEFT JOIN acts ON acts.user_id = u.id
  WHERE u.username IS NOT NULL
    AND (EXISTS (SELECT 1 FROM strava_accounts sa WHERE sa.user_id = u.id)
      OR EXISTS (SELECT 1 FROM activities a WHERE a.user_id = u.id))
  ORDER BY rank`

describe('leaderboard', async () => {
  const db = await seededDatabase('sf')
  const insUser = db.prepare(`INSERT INTO users (id, email, username, created_at) VALUES (?, ?, ?, 0)`)
  for (const u of ['u1', 'u2', 'u3', 'u4']) insUser.run(u, `${u}@example.com`, u === 'u4' ? null : `name_${u}`)
  // u3 has connected Strava but has no activities yet; u4 has no username and isn't ranked.
  db.prepare(`INSERT INTO strava_accounts (user_id, athlete_id, access_token, refresh_token, expires_at, connected_at) VALUES ('u3', 3, '', '', 0, 0)`).run()
  const insAct = db.prepare(
    `INSERT INTO activities (id, mode, city, start_date, start_ts, status, updated_at, user_id) VALUES (?, ?, 'sf', '', 0, ?, 0, ?)`,
  )
  for (let a = 1; a <= 40; a++) insAct.run(a, a % 3 === 0 ? 'bike' : 'foot', a % 10 === 0 ? 'ignored' : 'detailed', a <= 25 ? 'u1' : a <= 38 ? 'u2' : 'u4')
  const insCov = db.prepare(`INSERT OR IGNORE INTO coverage (user_id, segment_id, mode, mask, completed) VALUES (?, ?, ?, 1, ?)`)
  for (let id = 1; id <= 6000; id++) {
    insCov.run(id % 2 ? 'u1' : 'u2', id, id % 5 === 0 ? 'bike' : 'foot', id % 7 === 0 ? 0 : 1)
    if (id % 3 === 0) insCov.run('u4', id, 'foot', 1)
  }
  // As migrations/0009 fills it: every user and city they have activities in, to be computed.
  db.exec(`INSERT INTO user_stats (user_id, city, mode) SELECT DISTINCT user_id, city, mode FROM activities
           WHERE user_id IS NOT NULL AND city IS NOT NULL AND mode IS NOT NULL`)
  const D1 = d1(db)

  it('ranks like the query over every completed segment', async () => {
    for (const mode of ['foot', 'bike'] as const) {
      const expected = db.prepare(FULL_LEADERBOARD(mode)).all(mode, 'sf') as { username: string; m: number; n: number; rank: number }[]
      const board = await getLeaderboard(D1, 'sf', mode, 'u2')
      expect(board.players).toBe(expected.length)
      expect(board.rows.map((r) => [r.username, r.rank, r.activities, Math.round(r.meters)])).toEqual(
        expected.map((r) => [r.username, r.rank, r.n, Math.round(r.m)]),
      )
      expect(board.rows.find((r) => r.you)?.username).toBe('name_u2')
    }
  })

  it('picks up new coverage once a row is marked stale', async () => {
    const before = (await getLeaderboard(D1, 'sf', 'foot', null)).rows.find((r) => r.username === 'name_u1')!.meters
    db.prepare(`UPDATE coverage SET completed = 1 WHERE user_id = 'u1' AND mode = 'foot'`).run()
    expect((await getLeaderboard(D1, 'sf', 'foot', null)).rows.find((r) => r.username === 'name_u1')!.meters).toBe(before)
    db.prepare(`UPDATE user_stats SET stale = 1 WHERE user_id = 'u1'`).run()
    const after = (await getLeaderboard(D1, 'sf', 'foot', null)).rows.find((r) => r.username === 'name_u1')!.meters
    expect(after).toBeGreaterThan(before)
  })
})
