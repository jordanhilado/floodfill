import { queryOptions } from '@tanstack/react-query'
import type { CityId } from './cities'
import { haversine } from './geo'
import streetFiles from './street-files.json'

export type SegmentInfo = { id: number; name: string | null; path: boolean; foot: boolean; bike: boolean; hood: number | null; length: number }
export type StreetIndex = { byId: Map<number, SegmentInfo>; byName: Map<string, number[]> }

export type StreetFeature = {
  type: 'Feature'
  id: number
  properties: { n: string | null; k: number; f: number; b: number; h?: number }
  geometry: { type: 'LineString'; coordinates: [number, number][] }
}
export type StreetCollection = { type: 'FeatureCollection'; features: StreetFeature[] }

const loaded = new Map<CityId, Promise<StreetCollection>>()

/**
 * A city's streets, as drawn on the map. Big cities are split into several static files (see
 * scripts/build-streets.ts); this fetches them all once and joins them.
 */
export function loadStreets(city: CityId): Promise<StreetCollection> {
  let p = loaded.get(city)
  if (!p) {
    const count = (streetFiles as Record<string, { parts: number }>)[city]?.parts ?? 1
    p = Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const res = await fetch(`/data/${city}/streets-${i}.geojson`)
        if (!res.ok) throw new Error(`Couldn't load streets (${res.status})`)
        return ((await res.json()) as StreetCollection).features
      }),
    ).then((parts) => ({ type: 'FeatureCollection', features: parts.flat() }))
    p.catch(() => loaded.delete(city))
    loaded.set(city, p)
  }
  return p
}

/**
 * Segment lookup for tapping a street: which segments share its name, how long each is and
 * where it sits. Built from the same streets the map draws.
 */
export const streetIndexQuery = (city: CityId) =>
  queryOptions({
    queryKey: ['street-index', city],
    staleTime: Infinity,
    queryFn: async (): Promise<StreetIndex> => {
      const { features } = await loadStreets(city)
      const byId = new Map<number, SegmentInfo>()
      const byName = new Map<string, number[]>()
      for (const f of features) {
        const c = f.geometry.coordinates
        let length = 0
        for (let i = 1; i < c.length; i++) length += haversine([c[i - 1][1], c[i - 1][0]], [c[i][1], c[i][0]])
        const p = f.properties
        byId.set(f.id, { id: f.id, name: p.n, path: p.k === 1, foot: p.f === 1, bike: p.b === 1, hood: p.h ?? null, length })
        if (p.n) {
          const ids = byName.get(p.n)
          if (ids) ids.push(f.id)
          else byName.set(p.n, [f.id])
        }
      }
      return { byId, byName }
    },
  })

/** Every segment of the tapped segment's street (by name), or just the segment if unnamed. */
export function streetIds(index: StreetIndex, segmentId: number): number[] {
  const seg = index.byId.get(segmentId)
  if (!seg) return []
  return seg.name ? (index.byName.get(seg.name) ?? [segmentId]) : [segmentId]
}

export type StreetProgress = { done: number; total: number; percent: number; counted: boolean }

/** Distance done along a street's segments that count in this mode. */
export function streetProgress(index: StreetIndex, ids: number[], completed: Set<number>, mode: 'foot' | 'bike'): StreetProgress {
  let done = 0
  let total = 0
  for (const id of ids) {
    const s = index.byId.get(id)
    if (!s || !(mode === 'foot' ? s.foot : s.bike)) continue
    total += s.length
    if (completed.has(id)) done += s.length
  }
  return { done, total, percent: total ? (done / total) * 100 : 0, counted: total > 0 }
}
