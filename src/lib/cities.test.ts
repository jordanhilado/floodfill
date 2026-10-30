import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { seededDatabase } from '../../scripts/totals'
import { CITIES, CITY_IDS, cityForTrack, ID_SPAN } from './cities'
import streetFiles from './street-files.json'

const root = new URL('../../', import.meta.url)
const files = streetFiles as Record<string, { parts: number; segments: number }>

describe('cityForTrack', () => {
  it('finds the city a track runs through', () => {
    // Market Street, San Francisco ([lat, lng]).
    expect(cityForTrack([[37.7749, -122.4194], [37.7897, -122.3972]])).toBe('sf')
  })

  it('ignores tracks outside every city', () => {
    // Chicago's lakefront.
    expect(cityForTrack([[41.8917, -87.6086], [41.8676, -87.6136]])).toBeNull()
    expect(cityForTrack([])).toBeNull()
  })

  it('counts a simplified track that crosses a city without a point inside', () => {
    const [[x0, y0], [x1, y1]] = CITIES.sf.bounds
    const midLat = (y0 + y1) / 2
    expect(cityForTrack([[midLat, x0 - 0.05], [midLat, x1 + 0.05]])).toBe('sf')
  })
})

it('gives each city its own range of segment ids', () => {
  const bases = CITY_IDS.map((id) => CITIES[id].idBase)
  expect(new Set(bases).size).toBe(bases.length)
  for (const b of bases) expect(b % ID_SPAN).toBe(0)
})

describe.each(CITY_IDS)('%s data files', async (city) => {
  const { idBase } = CITIES[city]

  it('lists every map part, each within Cloudflare’s 25 MiB file limit', () => {
    const dir = new URL(`public/data/${city}/`, root)
    const parts = readdirSync(dir).filter((f) => /^streets(-\d+)?\.geojson$/.test(f))
    expect(parts.sort()).toEqual(Array.from({ length: files[city].parts }, (_, i) => `streets-${i}.geojson`).sort())
    for (const p of parts) expect(statSync(new URL(p, dir)).size).toBeLessThan(25 * 1024 * 1024)
    expect(existsSync(new URL('neighborhoods.geojson', dir))).toBe(true)
  })

  it('matches its seed', async () => {
    const db = await seededDatabase(city)
    const row = db.prepare('SELECT COUNT(*) AS n, MIN(id) AS lo, MAX(id) AS hi FROM segments WHERE city = ?').get(city) as {
      n: number
      lo: number
      hi: number
    }
    expect(row.n).toBe(files[city].segments)
    expect(row.lo).toBeGreaterThan(idBase)
    expect(row.hi).toBeLessThanOrEqual(idBase + ID_SPAN)

    // The map draws the same segments the server matches against.
    let features = 0
    for (let i = 0; i < files[city].parts; i++) {
      const part = JSON.parse(readFileSync(new URL(`public/data/${city}/streets-${i}.geojson`, root), 'utf8')) as { features: unknown[] }
      features += part.features.length
    }
    expect(features).toBe(row.n)
  })
})
