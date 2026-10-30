import { chunk, MAX_PARAMS } from '../db'
import { isComplete } from './match'
import type { CityIndex } from './segments'

export type Mode = 'foot' | 'bike'

/**
 * Replaces an activity's contribution and recomputes coverage for every segment
 * it touches (before or after). Returns how many segments this activity completed first.
 * The activity row must already exist so its mode/start time can be joined.
 */
export async function applyActivityCoverage(
  db: D1Database,
  index: CityIndex,
  userId: string,
  activityId: number,
  mode: Mode,
  masks: Map<number, number>,
): Promise<number> {
  const { results: previous } = await db
    .prepare('SELECT segment_id FROM activity_segments WHERE activity_id = ?')
    .bind(activityId)
    .all<{ segment_id: number }>()

  const writes: D1PreparedStatement[] = [
    db.prepare('DELETE FROM activity_segments WHERE activity_id = ?').bind(activityId),
    db.prepare('DELETE FROM activity_groups WHERE activity_id = ?').bind(activityId),
  ]
  for (const rows of chunk([...masks], Math.floor(MAX_PARAMS / 3))) {
    writes.push(
      db
        .prepare(`INSERT INTO activity_segments (activity_id, segment_id, mask) VALUES ${rows.map(() => '(?,?,?)').join(',')}`)
        .bind(...rows.flatMap(([segmentId, mask]) => [activityId, segmentId, mask])),
    )
  }
  // The streets and neighborhoods it touched, so activity counts per street or neighborhood
  // don't have to read every matched segment (see activityCounts in queries.ts).
  const groups = new Map<string, [kind: string, key: string]>()
  for (const segmentId of masks.keys()) {
    const seg = index.byId.get(segmentId)
    if (seg?.name) groups.set(`name:${seg.name}`, ['name', seg.name])
    if (seg?.neighborhood) groups.set(`neighborhood:${seg.neighborhood}`, ['neighborhood', seg.neighborhood])
  }
  for (const rows of chunk([...groups.values()], Math.floor(MAX_PARAMS / 3))) {
    writes.push(
      db
        .prepare(`INSERT INTO activity_groups (activity_id, kind, key) VALUES ${rows.map(() => '(?,?,?)').join(',')}`)
        .bind(...rows.flatMap(([kind, key]) => [activityId, kind, key])),
    )
  }
  await db.batch(writes)

  const affected = [...new Set([...previous.map((r) => r.segment_id), ...masks.keys()])]
  if (affected.length === 0) return 0

  type Row = { segment_id: number; mask: number; activity_id: number; start_date: string }
  const contributions: Row[] = []
  // Two parameters (user, mode) plus the ids must fit in D1's 100-parameter limit.
  for (const ids of chunk(affected, MAX_PARAMS - 2)) {
    const { results } = await db
      .prepare(
        `SELECT s.segment_id, s.mask, a.id AS activity_id, a.start_date
         FROM activity_segments s JOIN activities a ON a.id = s.activity_id
         WHERE a.user_id = ? AND a.mode = ? AND s.segment_id IN (${ids.map(() => '?').join(',')})
         ORDER BY a.start_ts`,
      )
      .bind(userId, mode, ...ids)
      .all<Row>()
    contributions.push(...results)
  }

  // Walk contributions chronologically so we know which activity completed each segment.
  const state = new Map<number, { mask: number; completedBy: Row | null }>()
  for (const id of affected) state.set(id, { mask: 0, completedBy: null })
  for (const row of contributions) {
    const s = state.get(row.segment_id)!
    s.mask |= row.mask
    const seg = index.byId.get(row.segment_id)
    if (!s.completedBy && seg && isComplete(s.mask, seg.sampleCount)) s.completedBy = row
  }

  const upserts: D1PreparedStatement[] = []
  let firsts = 0
  for (const [segmentId, s] of state) {
    if (s.mask === 0) {
      upserts.push(
        db.prepare('DELETE FROM coverage WHERE user_id = ? AND segment_id = ? AND mode = ?').bind(userId, segmentId, mode),
      )
      continue
    }
    if (s.completedBy?.activity_id === activityId) firsts++
    upserts.push(
      db
        .prepare(
          `INSERT INTO coverage (user_id, segment_id, mode, mask, completed, first_activity_id, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, segment_id, mode) DO UPDATE SET
             mask = excluded.mask, completed = excluded.completed,
             first_activity_id = excluded.first_activity_id, completed_at = excluded.completed_at`,
        )
        .bind(
          userId,
          segmentId,
          mode,
          s.mask,
          s.completedBy ? 1 : 0,
          s.completedBy?.activity_id ?? null,
          s.completedBy?.start_date ?? null,
        ),
    )
  }
  for (const batch of chunk(upserts, 500)) await db.batch(batch)
  return firsts
}
