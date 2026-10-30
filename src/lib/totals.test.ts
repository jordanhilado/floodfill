import { describe, expect, it } from 'vitest'
import { seededDatabase, type CityTotals } from '../../scripts/totals'
import { CITY_IDS } from './cities'

const files = import.meta.glob<CityTotals>('./totals.*.json', { eager: true, import: 'default' })

// The queries the app ran against D1 before these totals were precomputed. Each committed JSON must
// match them exactly on its committed seed (run `pnpm totals <city>` after changing the seed).
for (const city of CITY_IDS) {
  describe(`totals.${city}.json`, async () => {
    const db = await seededDatabase(city)
    const all = files[`./totals.${city}.json`]

    for (const mode of ['foot', 'bike'] as const) {
      it(`matches the seed for ${mode}`, () => {
        const byStreet = db
          .prepare(
            `SELECT CASE WHEN kind = 'street' AND name IS NOT NULL THEN name END AS street, COUNT(*) AS n, SUM(length_m) AS m
             FROM segments WHERE city = ? AND ${mode} = 1 GROUP BY street`,
          )
          .all(city) as { street: string | null; n: number; m: number }[]
        const totals = all[mode]
        expect(totals.meters).toBe(byStreet.reduce((a, r) => a + r.m, 0))
        expect(totals.segments).toBe(byStreet.reduce((a, r) => a + r.n, 0))
        expect(new Map(Object.entries(totals.streets))).toEqual(
          new Map(byStreet.filter((r) => r.street !== null).map((r) => [r.street, r.n])),
        )

        const byHood = db
          .prepare(
            `SELECT neighborhood, SUM(length_m) AS m FROM segments
             WHERE city = ? AND ${mode} = 1 AND neighborhood IS NOT NULL GROUP BY neighborhood`,
          )
          .all(city) as { neighborhood: string; m: number }[]
        expect(new Map(Object.entries(totals.neighborhoods))).toEqual(new Map(byHood.map((r) => [r.neighborhood, r.m])))

        const byName = db
          .prepare(
            `SELECT s.name AS name, SUM(s.length_m) AS total,
                    MIN(s.min_lng) AS x0, MIN(s.min_lat) AS y0, MAX(s.max_lng) AS x1, MAX(s.max_lat) AS y1,
                    MAX(s.kind = 'street') AS is_street
             FROM segments s WHERE s.city = ? AND s.${mode} = 1 AND s.name IS NOT NULL
             GROUP BY s.name ORDER BY s.name`,
          )
          .all(city) as { name: string; total: number; x0: number; y0: number; x1: number; y1: number; is_street: number }[]
        expect(totals.names).toEqual(byName.map((r) => [r.name, r.total, r.x0, r.y0, r.x1, r.y1, r.is_street]))
      })
    }
  })
}
