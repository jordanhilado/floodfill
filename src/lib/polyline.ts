// Google encoded polyline format (used by Strava, precision 5).
// Segments are stored with precision 6 to keep ~0.1 m accuracy.

export function decodePolyline(str: string, precision = 5): [number, number][] {
  const factor = 10 ** precision
  const out: [number, number][] = []
  let index = 0
  let lat = 0
  let lng = 0
  while (index < str.length) {
    for (let k = 0; k < 2; k++) {
      let result = 0
      let shift = 0
      let byte: number
      do {
        byte = str.charCodeAt(index++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      const delta = result & 1 ? ~(result >> 1) : result >> 1
      if (k === 0) lat += delta
      else lng += delta
    }
    out.push([lat / factor, lng / factor])
  }
  return out
}

function encodeValue(v: number) {
  let n = v < 0 ? ~(v << 1) : v << 1
  let s = ''
  while (n >= 0x20) {
    s += String.fromCharCode((0x20 | (n & 0x1f)) + 63)
    n >>= 5
  }
  return s + String.fromCharCode(n + 63)
}

export function encodePolyline(coords: [number, number][], precision = 5): string {
  const factor = 10 ** precision
  let prevLat = 0
  let prevLng = 0
  let s = ''
  for (const [la, ln] of coords) {
    const lat = Math.round(la * factor)
    const lng = Math.round(ln * factor)
    s += encodeValue(lat - prevLat) + encodeValue(lng - prevLng)
    prevLat = lat
    prevLng = lng
  }
  return s
}
