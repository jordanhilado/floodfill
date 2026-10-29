import type { CityId } from '../../lib/cities'
import { CITIES } from '../../lib/cities'
import { makeProjector } from '../../lib/geo'
import { decodePolyline } from '../../lib/polyline'
import { sampleSegment, type IndexedSegment, type Projector } from './match'

type SegmentRow = {
  id: number
  foot: number
  bike: number
  min_lat: number
  min_lng: number
  max_lat: number
  max_lng: number
  coords: string
}

export type CityIndex = {
  project: Projector
  segments: IndexedSegment[]
  byId: Map<number, IndexedSegment>
  forMode: Record<'foot' | 'bike', IndexedSegment[]>
}

// The street network is static, so keep the decoded index for the isolate's lifetime.
const cache = new Map<CityId, Promise<CityIndex>>()

export function loadCityIndex(db: D1Database, city: CityId): Promise<CityIndex> {
  let p = cache.get(city)
  if (!p) {
    p = build(db, city)
    p.catch(() => cache.delete(city))
    cache.set(city, p)
  }
  return p
}

async function build(db: D1Database, city: CityId): Promise<CityIndex> {
  const project = makeProjector(CITIES[city].center[1])
  const { results } = await db
    .prepare('SELECT id, foot, bike, min_lat, min_lng, max_lat, max_lng, coords FROM segments WHERE city = ?')
    .bind(city)
    .all<SegmentRow>()
  const segments = results.map((r): IndexedSegment => {
    const { samples, sampleCount, length } = sampleSegment(decodePolyline(r.coords, 6), project)
    return {
      id: r.id,
      length,
      foot: r.foot === 1,
      bike: r.bike === 1,
      bbox: { minLat: r.min_lat, minLng: r.min_lng, maxLat: r.max_lat, maxLng: r.max_lng },
      samples,
      sampleCount,
    }
  })
  return {
    project,
    segments,
    byId: new Map(segments.map((s) => [s.id, s])),
    forMode: { foot: segments.filter((s) => s.foot), bike: segments.filter((s) => s.bike) },
  }
}
