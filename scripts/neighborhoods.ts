/**
 * Loads a city's official neighborhood polygons, simplifies them for the map and
 * assigns street segments to them by midpoint.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { City } from '../src/lib/cities.ts'
import { makeProjector } from '../src/lib/geo.ts'

type Ring = [number, number][] // [lng, lat]
type Polygon = Ring[] // outer ring, then holes
export type Neighborhood = {
  name: string
  /** Simplified, for drawing. */
  polygons: Polygon[]
  /** Full detail, for assigning segments (coastal paths sit near the simplified edge). */
  exact: Polygon[]
  bbox: [number, number, number, number] // minLng, minLat, maxLng, maxLat
  label: [number, number] // [lng, lat], inside the largest polygon
}

const SIMPLIFY_M = 10

export async function loadNeighborhoods(city: City, cacheDir: string, refresh: boolean): Promise<Neighborhood[]> {
  const cfg = city.neighborhoods
  if (!cfg) return []
  const cacheFile = path.join(cacheDir, `${city.id}-neighborhoods.geojson`)
  let text: string
  if (!refresh && existsSync(cacheFile)) {
    text = await readFile(cacheFile, 'utf8')
  } else {
    const res = await fetch(cfg.url, { headers: { 'user-agent': 'floodfill-prototype/0.1' } })
    text = await res.text()
    if (!res.ok || !text.trimStart().startsWith('{')) throw new Error(`Neighborhoods fetch failed: ${res.status}`)
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cacheFile, text)
  }

  const project = makeProjector(city.center[1])
  const data = JSON.parse(text) as {
    features: { properties: Record<string, string>; geometry: { type: string; coordinates: unknown } | null }[]
  }
  return data.features
    .filter((f) => f.geometry && f.properties[cfg.nameKey])
    .map((f) => {
      const g = f.geometry!
      const raw = (g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) as Polygon[]
      const polygons = raw.map((poly) => poly.map((ring) => simplifyRing(ring, project)))
      const pts = raw.flatMap((p) => p[0])
      const lngs = pts.map((p) => p[0])
      const lats = pts.map((p) => p[1])
      const largest = polygons.reduce((a, b) => (ringArea(b[0]) > ringArea(a[0]) ? b : a))
      return {
        name: f.properties[cfg.nameKey],
        polygons,
        exact: raw,
        bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
        label: labelPoint(largest),
      }
    })
}

/** Returns the neighborhood containing [lng, lat], or null. */
export function makeLocator(hoods: Neighborhood[]) {
  return (lng: number, lat: number) => {
    for (const h of hoods) {
      const [x0, y0, x1, y1] = h.bbox
      if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue
      if (h.exact.some((p) => inPolygon(lng, lat, p))) return h.name
    }
    return null
  }
}

export function toGeoJSON(hoods: Neighborhood[]) {
  const r = (v: number) => Math.round(v * 1e5) / 1e5
  return {
    type: 'FeatureCollection',
    features: [
      ...hoods.map((h) => ({
        type: 'Feature',
        properties: { name: h.name },
        geometry: { type: 'MultiPolygon', coordinates: h.polygons.map((p) => p.map((ring) => ring.map(([x, y]) => [r(x), r(y)]))) },
      })),
      // Separate label points so each neighborhood is named once, inside its shape.
      ...hoods.map((h) => ({
        type: 'Feature',
        properties: { name: h.name, label: 1 },
        geometry: { type: 'Point', coordinates: h.label.map(r) },
      })),
    ],
  }
}

function inRing(x: number, y: number, ring: Ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inPolygon(x: number, y: number, poly: Polygon) {
  return inRing(x, y, poly[0]) && !poly.slice(1).some((hole) => inRing(x, y, hole))
}

function ringArea(ring: Ring) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1])
  return Math.abs(a / 2)
}

/** Douglas–Peucker in projected meters. */
function simplifyRing(ring: Ring, project: (lat: number, lng: number) => [number, number]): Ring {
  if (ring.length <= 4) return ring
  const xy = ring.map(([lng, lat]) => project(lat, lng))
  const keep = new Uint8Array(ring.length)
  // Rings are closed (first point = last), so split at the vertex farthest from the
  // start; otherwise the first baseline has zero length.
  let far = 1
  for (let i = 1; i < ring.length - 1; i++) {
    if (Math.hypot(xy[i][0] - xy[0][0], xy[i][1] - xy[0][1]) > Math.hypot(xy[far][0] - xy[0][0], xy[far][1] - xy[0][1])) far = i
  }
  keep[0] = keep[far] = keep[ring.length - 1] = 1
  const stack: [number, number][] = [
    [0, far],
    [far, ring.length - 1],
  ]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ax, ay] = xy[a]
    const [bx, by] = xy[b]
    const len = Math.hypot(bx - ax, by - ay) || 1
    let max = 0
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - xy[i][1]) - (ax - xy[i][0]) * (by - ay)) / len
      if (d > max) [max, idx] = [d, i]
    }
    if (max > SIMPLIFY_M && idx > 0) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  const out = ring.filter((_, i) => keep[i])
  return out.length >= 4 ? out : ring
}

/** Grid search for the interior point farthest from the polygon's edges. */
function labelPoint(poly: Polygon): [number, number] {
  const outer = poly[0]
  const lngs = outer.map((p) => p[0])
  const lats = outer.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)]
  const edges = poly.flatMap((ring) => ring.slice(1).map((p, i) => [ring[i], p] as const))
  const distToEdges = (x: number, y: number) => {
    let best = Infinity
    for (const [[ax, ay], [bx, by]] of edges) {
      const dx = bx - ax
      const dy = by - ay
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
      best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y))
    }
    return best
  }
  let best: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2]
  let bestD = -1
  const N = 24
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const x = x0 + ((x1 - x0) * i) / N
      const y = y0 + ((y1 - y0) * j) / N
      if (!inPolygon(x, y, poly)) continue
      const d = distToEdges(x, y)
      if (d > bestD) [best, bestD] = [[x, y], d]
    }
  }
  return best
}
