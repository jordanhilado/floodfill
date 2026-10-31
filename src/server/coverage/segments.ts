import type { CityId } from '../../lib/cities'
import { CITIES, ID_SPAN } from '../../lib/cities'
import { makeProjector } from '../../lib/geo'
import { decodePolyline } from '../../lib/polyline'
import streetFiles from '../../lib/street-files.json'
import { sampleSegment, type IndexedSegment, type Projector } from './match'

type SegmentRow = {
  id: number
  foot: number
  bike: number
  name: string | null
  neighborhood: string | null
  min_lat: number
  min_lng: number
  max_lat: number
  max_lng: number
  coords: string
}

export type CityIndex = {
  city: CityId
  project: Projector
  segments: IndexedSegment[]
  byId: Map<number, IndexedSegment>
  forMode: Record<'foot' | 'bike', IndexedSegment[]>
}

// The street network is static, so keep decoded indexes for the isolate's lifetime. A big city's
// index takes tens of MB of the Worker's 128 MB, so the cache holds at most this many segments
// across cities (LA or New York alone, or several smaller cities) and drops the least recently used.
const MAX_CACHED_SEGMENTS = 160_000
// Rows per query while building, so the raw rows of a big city never sit in memory all at once.
const PAGE = 20_000

// Most recently used last.
const cache = new Map<CityId, Promise<CityIndex>>()

const segmentCount = (city: CityId) => (streetFiles as Record<string, { segments: number }>)[city]?.segments ?? 0

/**
 * A city's index, built on first use. Callers should let go of one city's index before loading
 * another, since an evicted index stays in memory while anything still holds it.
 */
export function loadCityIndex(db: D1Database, city: CityId): Promise<CityIndex> {
  let p = cache.get(city)
  if (p) {
    cache.delete(city)
  } else {
    // Make room first: two big indexes at once don't fit.
    let total = segmentCount(city)
    for (const id of cache.keys()) total += segmentCount(id)
    for (const id of [...cache.keys()]) {
      if (total <= MAX_CACHED_SEGMENTS) break
      cache.delete(id)
      total -= segmentCount(id)
    }
    p = build(db, city)
    p.catch(() => cache.delete(city))
  }
  cache.set(city, p)
  return p
}

async function build(db: D1Database, city: CityId): Promise<CityIndex> {
  const { center, idBase } = CITIES[city]
  const project = makeProjector(center[1])
  // Names repeat along a street, so share one string per name.
  const strings = new Map<string, string>()
  const intern = (s: string | null) => {
    if (s === null) return null
    const known = strings.get(s)
    if (known !== undefined) return known
    strings.set(s, s)
    return s
  }
  const segments: IndexedSegment[] = []
  // Each city's ids are one range of the primary key (see City.idBase), so pages are cheap.
  for (let after = idBase; ; ) {
    const { results } = await db
      .prepare(
        `SELECT id, foot, bike, name, neighborhood, min_lat, min_lng, max_lat, max_lng, coords FROM segments
         WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`,
      )
      .bind(after, idBase + ID_SPAN, PAGE)
      .all<SegmentRow>()
    for (const r of results) {
      const { samples, sampleCount, length } = sampleSegment(decodePolyline(r.coords, 6), project)
      segments.push({
        id: r.id,
        length,
        foot: r.foot === 1,
        bike: r.bike === 1,
        name: intern(r.name),
        neighborhood: intern(r.neighborhood),
        bbox: { minLat: r.min_lat, minLng: r.min_lng, maxLat: r.max_lat, maxLng: r.max_lng },
        samples,
        sampleCount,
      })
    }
    if (results.length < PAGE) break
    after = results[results.length - 1].id
  }
  return {
    city,
    project,
    segments,
    byId: new Map(segments.map((s) => [s.id, s])),
    forMode: { foot: segments.filter((s) => s.foot), bike: segments.filter((s) => s.bike) },
  }
}
