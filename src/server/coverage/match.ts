import { makeProjector, type BBox } from '../../lib/geo'

export const MATCH = {
  /** A sample point counts as visited when the track passes within this distance. */
  radiusM: 20,
  /** Samples skip the ends of a segment so crossing an intersection doesn't count. */
  insetM: 12,
  spacingM: 10,
  maxSamples: 30,
  /** Share of a segment's sample points that must be visited to complete it. */
  completeFraction: 0.7,
  cellM: 50,
}

// Reference latitude for the local projection. Good enough for any single city.
export type Projector = ReturnType<typeof makeProjector>

export type IndexedSegment = {
  id: number
  length: number
  foot: boolean
  bike: boolean
  /** Street name and neighborhood, for the per-activity groups (see apply.ts). */
  name?: string | null
  neighborhood?: string | null
  bbox: BBox
  /** Projected sample points [x, y] in meters. */
  samples: Float64Array
  sampleCount: number
}

export function sampleSegment(coords: [number, number][], project: Projector) {
  const pts = coords.map(([la, ln]) => project(la, ln))
  const cum = [0]
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  }
  const length = cum[cum.length - 1]
  const usable = length - 2 * MATCH.insetM
  const n = usable <= 0 ? 1 : Math.min(MATCH.maxSamples, Math.floor(usable / MATCH.spacingM) + 1)
  const out = new Float64Array(n * 2)
  let j = 1
  for (let k = 0; k < n; k++) {
    const d = n === 1 ? length / 2 : MATCH.insetM + (k * usable) / (n - 1)
    while (j < cum.length - 1 && cum[j] < d) j++
    const seg = cum[j] - cum[j - 1] || 1
    const t = Math.min(1, Math.max(0, (d - cum[j - 1]) / seg))
    out[k * 2] = pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t
    out[k * 2 + 1] = pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t
  }
  return { samples: out, sampleCount: n, length }
}

const cellKey = (cx: number, cy: number) => (cx + 1e6) * 4e6 + (cy + 1e6)

/**
 * Returns, for every segment the track passes, a bitmask of visited sample points.
 * `maxGapM` drops track edges longer than this (GPS dropouts); summary polylines
 * are simplified so they need a much larger value than full-resolution streams.
 */
export function matchTrack(
  track: [number, number][],
  segments: IndexedSegment[],
  project: Projector,
  maxGapM: number,
): Map<number, number> {
  const result = new Map<number, number>()
  if (track.length < 2) return result

  const xy = track.map(([la, ln]) => project(la, ln))
  const r = MATCH.radiusM
  const r2 = r * r
  const cell = MATCH.cellM
  const grid = new Map<number, number[]>()
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity

  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1]
    const [bx, by] = xy[i]
    if (Math.hypot(bx - ax, by - ay) > maxGapM) continue
    const x0 = Math.floor((Math.min(ax, bx) - r) / cell)
    const x1 = Math.floor((Math.max(ax, bx) + r) / cell)
    const y0 = Math.floor((Math.min(ay, by) - r) / cell)
    const y1 = Math.floor((Math.max(ay, by) + r) / cell)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = cellKey(cx, cy)
        const list = grid.get(k)
        if (list) list.push(i)
        else grid.set(k, [i])
      }
    }
    for (const [la, ln] of [track[i - 1], track[i]]) {
      if (la < minLat) minLat = la
      if (la > maxLat) maxLat = la
      if (ln < minLng) minLng = ln
      if (ln > maxLng) maxLng = ln
    }
  }
  if (grid.size === 0) return result

  // ~0.0003° ≈ 30 m of slack around the track bbox
  const pad = 0.0003
  for (const s of segments) {
    const b = s.bbox
    if (b.maxLat < minLat - pad || b.minLat > maxLat + pad || b.maxLng < minLng - pad || b.minLng > maxLng + pad) {
      continue
    }
    let mask = 0
    for (let k = 0; k < s.sampleCount; k++) {
      const px = s.samples[k * 2]
      const py = s.samples[k * 2 + 1]
      const edges = grid.get(cellKey(Math.floor(px / cell), Math.floor(py / cell)))
      if (!edges) continue
      for (const i of edges) {
        const [ax, ay] = xy[i - 1]
        const [bx, by] = xy[i]
        const dx = bx - ax
        const dy = by - ay
        const len2 = dx * dx + dy * dy
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
        const ex = ax + t * dx - px
        const ey = ay + t * dy - py
        if (ex * ex + ey * ey <= r2) {
          mask |= 1 << k
          break
        }
      }
    }
    if (mask) result.set(s.id, mask)
  }
  return result
}

export function popcount(n: number) {
  n = n - ((n >>> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

export function isComplete(mask: number, sampleCount: number) {
  return popcount(mask) >= Math.ceil(sampleCount * MATCH.completeFraction)
}
