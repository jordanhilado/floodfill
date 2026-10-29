import { queryOptions } from '@tanstack/react-query'
import type { CityId } from './cities'
import { haversine } from './geo'

export type SegmentInfo = { id: number; name: string | null; path: boolean; foot: boolean; bike: boolean; hood: number | null; length: number }
export type StreetIndex = { byId: Map<number, SegmentInfo>; byName: Map<string, number[]> }

type Feature = {
  id: number
  properties: { n: string | null; k: number; f: number; b: number; h?: number }
  geometry: { coordinates: [number, number][] }
}

/**
 * Segment lookup for tapping a street: which segments share its name, how long each is and
 * where it sits. Built from the same static GeoJSON the map draws (a cache hit after the map loads).
 */
export const streetIndexQuery = (city: CityId) =>
  queryOptions({
    queryKey: ['street-index', city],
    staleTime: Infinity,
    queryFn: async (): Promise<StreetIndex> => {
      const res = await fetch(`/data/${city}/streets.geojson`)
      const { features } = (await res.json()) as { features: Feature[] }
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
