import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CITIES } from '../../lib/cities'
import { makeProjector } from '../../lib/geo'
import { decodePolyline, encodePolyline } from '../../lib/polyline'
import { isComplete, matchTrack, sampleSegment, type IndexedSegment } from './match'

type Feature = { id: number; properties: { n: string; f: number; b: number }; geometry: { coordinates: [number, number][] } }
const geo = JSON.parse(readFileSync(new URL('../../../public/data/sf/streets.geojson', import.meta.url), 'utf8')) as {
  features: Feature[]
}
const project = makeProjector(CITIES.sf.center[1])
const names = new Map<number, string>()
const segments: IndexedSegment[] = geo.features.map((f) => {
  const coords = f.geometry.coordinates.map(([ln, la]) => [la, ln] as [number, number])
  const lats = coords.map((c) => c[0])
  const lngs = coords.map((c) => c[1])
  names.set(f.id, f.properties.n)
  return {
    id: f.id,
    foot: f.properties.f === 1,
    bike: f.properties.b === 1,
    bbox: { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) },
    ...sampleSegment(coords, project),
  }
})

/** Densifies a straight line to ~1 point per 3 m with deterministic GPS-like jitter. */
function walk(from: [number, number], to: [number, number], jitterM = 4): [number, number][] {
  const steps = 400
  const out: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const j = (Math.sin(i * 12.9898) * jitterM) / 111_000
    out.push([from[0] + (to[0] - from[0]) * t + j, from[1] + (to[1] - from[1]) * t + j])
  }
  return out
}

function completedStreets(masks: Map<number, number>) {
  const done = new Map<string, number>()
  for (const [id, mask] of masks) {
    const seg = segments.find((s) => s.id === id)!
    if (isComplete(mask, seg.sampleCount)) done.set(names.get(id)!, (done.get(names.get(id)!) ?? 0) + 1)
  }
  return done
}

// Valencia St runs nearly straight from 16th St to 24th St in the Mission.
const VALENCIA_16TH: [number, number] = [37.76502, -122.42198]
const VALENCIA_24TH: [number, number] = [37.75223, -122.42068]

describe('matchTrack', () => {
  it('completes the street that was walked and not the cross streets', () => {
    const masks = matchTrack(walk(VALENCIA_16TH, VALENCIA_24TH), segments, project, 150)
    const done = completedStreets(masks)
    expect(done.get('Valencia Street')).toBeGreaterThanOrEqual(7)
    for (const cross of ['17th Street', '18th Street', '19th Street', '20th Street', '21st Street', '22nd Street', '23rd Street']) {
      expect(done.get(cross) ?? 0).toBe(0)
    }
  })

  it('does not credit a parallel street one block away', () => {
    const masks = matchTrack(walk(VALENCIA_16TH, VALENCIA_24TH), segments, project, 150)
    const done = completedStreets(masks)
    expect(done.get('Guerrero Street') ?? 0).toBe(0)
    expect(done.get('Mission Street') ?? 0).toBe(0)
  })

  it('gets the same result from a simplified (summary) polyline', () => {
    const summary = decodePolyline(encodePolyline([VALENCIA_16TH, VALENCIA_24TH]))
    const masks = matchTrack(summary, segments, project, 2000)
    expect(completedStreets(masks).get('Valencia Street')).toBeGreaterThanOrEqual(7)
  })

  it('ignores GPS dropouts longer than the max gap for streams', () => {
    const masks = matchTrack([VALENCIA_16TH, VALENCIA_24TH], segments, project, 150)
    expect(masks.size).toBe(0)
  })
})

describe('polyline', () => {
  it('round-trips Strava-precision coordinates', () => {
    const pts: [number, number][] = [
      [37.76502, -122.42198],
      [37.75223, -122.42068],
    ]
    expect(decodePolyline(encodePolyline(pts))).toEqual(pts)
  })
})
