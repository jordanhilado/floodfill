/**
 * Static per-city totals, computed from the D1 seed so the app doesn't scan `segments` on every
 * page view. Written by scripts/build-streets.ts after the seed; regenerate on its own with
 *
 *   node scripts/build-totals.ts [cityId]
 *
 * The seed is loaded into an in-memory SQLite database and summed with the same SQL the app used
 * to run against D1, so every number (including floating-point sums) matches D1 exactly.
 */
import { DatabaseSync } from 'node:sqlite'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CityId } from '../src/lib/cities.ts'

const root = path.resolve(import.meta.dirname, '..')
const MODES = ['foot', 'bike'] as const

// Must match NAMED_STREET in src/server/queries.ts.
const NAMED_STREET = `kind = 'street' AND name IS NOT NULL`

export type ModeTotals = {
  /** Length of every segment in this mode. */
  meters: number
  segments: number
  /** Segments per named street (NAMED_STREET), for "full streets". */
  streets: Record<string, number>
  /** Meters per neighborhood. */
  neighborhoods: Record<string, number>
  /**
   * Every named street or path, in SQLite's BINARY order of names (the ranking's last tiebreak):
   * [name, meters, minLng, minLat, maxLng, maxLat, isStreet].
   */
  names: [string, number, number, number, number, number, number][]
}
export type CityTotals = Record<(typeof MODES)[number], ModeTotals>

/** A fresh in-memory database with every migration and the city's segment seed applied. */
export async function seededDatabase(cityId: CityId) {
  const db = new DatabaseSync(':memory:')
  const dir = path.join(root, 'migrations')
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) db.exec(await readFile(path.join(dir, f), 'utf8'))
  db.exec(await readFile(path.join(root, 'db/seed', `${cityId}-segments.sql`), 'utf8'))
  return db
}

export function computeTotals(db: DatabaseSync, cityId: CityId): CityTotals {
  const totals = (mode: (typeof MODES)[number]): ModeTotals => {
    const byStreet = db
      .prepare(
        `SELECT CASE WHEN ${NAMED_STREET} THEN name END AS street, COUNT(*) AS n, SUM(length_m) AS m
         FROM segments WHERE city = ? AND ${mode} = 1 GROUP BY street`,
      )
      .all(cityId) as { street: string | null; n: number; m: number }[]
    const byHood = db
      .prepare(
        `SELECT neighborhood, SUM(length_m) AS m FROM segments
         WHERE city = ? AND ${mode} = 1 AND neighborhood IS NOT NULL GROUP BY neighborhood`,
      )
      .all(cityId) as { neighborhood: string; m: number }[]
    const byName = db
      .prepare(
        `SELECT name, SUM(length_m) AS m,
                MIN(min_lng) AS x0, MIN(min_lat) AS y0, MAX(max_lng) AS x1, MAX(max_lat) AS y1,
                MAX(kind = 'street') AS is_street
         FROM segments WHERE city = ? AND ${mode} = 1 AND name IS NOT NULL GROUP BY name ORDER BY name`,
      )
      .all(cityId) as { name: string; m: number; x0: number; y0: number; x1: number; y1: number; is_street: number }[]
    return {
      // Summed in the same order as the app used to, so the floating-point result is identical.
      meters: byStreet.reduce((a, r) => a + r.m, 0),
      segments: byStreet.reduce((a, r) => a + r.n, 0),
      streets: Object.fromEntries(byStreet.filter((r) => r.street !== null).map((r) => [r.street, r.n])),
      neighborhoods: Object.fromEntries(byHood.map((r) => [r.neighborhood, r.m])),
      names: byName.map((r) => [r.name, r.m, r.x0, r.y0, r.x1, r.y1, r.is_street]),
    }
  }
  return { foot: totals('foot'), bike: totals('bike') }
}

/** One entry per line, so a rebuilt network diffs readably. */
function format(t: CityTotals) {
  const obj = (o: Record<string, unknown>, indent: string) =>
    `{\n${Object.entries(o).map(([k, v]) => `${indent}  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n${indent}}`
  const mode = (m: ModeTotals) =>
    `{\n    "meters": ${m.meters},\n    "segments": ${m.segments},\n` +
    `    "streets": ${obj(m.streets, '    ')},\n    "neighborhoods": ${obj(m.neighborhoods, '    ')},\n` +
    `    "names": [\n${m.names.map((n) => `      ${JSON.stringify(n)}`).join(',\n')}\n    ]\n  }`
  return `{\n  "foot": ${mode(t.foot)},\n  "bike": ${mode(t.bike)}\n}\n`
}

/** Writes src/lib/totals.<city>.json from db/seed/<city>-segments.sql. */
export async function writeTotals(cityId: CityId) {
  const db = await seededDatabase(cityId)
  const totals = computeTotals(db, cityId)
  db.close()
  const file = path.join(root, 'src/lib', `totals.${cityId}.json`)
  await writeFile(file, format(totals))
  return path.relative(root, file)
}
