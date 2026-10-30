import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { seededDatabase } from '../../scripts/totals'
import { getCoverageData, getNeighborhoodData, getStreetDetail, getStreetPage, type RankSort } from './queries'

/** D1's statement API over an in-memory SQLite database. */
function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...(args as [])) }),
    first: async () => db.prepare(sql).all(...(args as []))[0] ?? null,
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
