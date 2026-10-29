const R = 6371008.8

/** Great-circle distance in meters between [lat, lng] points. */
export function haversine(a: [number, number], b: [number, number]) {
  const toRad = Math.PI / 180
  const dLat = (b[0] - a[0]) * toRad
  const dLng = (b[1] - a[1]) * toRad
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export type BBox = { minLat: number; minLng: number; maxLat: number; maxLng: number }

export function bboxOf(coords: [number, number][]): BBox {
  let minLat = Infinity
  let minLng = Infinity
  let maxLat = -Infinity
  let maxLng = -Infinity
  for (const [la, ln] of coords) {
    if (la < minLat) minLat = la
    if (la > maxLat) maxLat = la
    if (ln < minLng) minLng = ln
    if (ln > maxLng) maxLng = ln
  }
  return { minLat, minLng, maxLat, maxLng }
}

export function bboxIntersects(a: BBox, b: BBox) {
  return a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLng <= b.maxLng && a.maxLng >= b.minLng
}

/** Equirectangular projection to local meters around a reference latitude. */
export function makeProjector(refLat: number) {
  const kx = (Math.PI / 180) * R * Math.cos((refLat * Math.PI) / 180)
  const ky = (Math.PI / 180) * R
  return (lat: number, lng: number): [number, number] => [lng * kx, lat * ky]
}
