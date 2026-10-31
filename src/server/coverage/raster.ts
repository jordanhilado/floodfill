import { CITIES, type CityId } from '../../lib/cities'

/** A one-bit image of the streets someone has completed: set bits are covered pixels. */
export type CoverageRaster = { width: number; height: number; /** Row-major bits, base64. */ bits: string }

/** The longer side of a city's image, in pixels: about one per device pixel where a profile draws it. */
export const RASTER_SIZE = 192

/**
 * How a city's image is framed: its size, with the longer side `size` pixels, and where a
 * [lat, lng] point lands in it. Shared with the outline drawn under the image on profiles.
 */
export function rasterFrame(city: CityId, size = RASTER_SIZE) {
  const [[minLng, minLat], [maxLng, maxLat]] = CITIES[city].bounds
  // Equirectangular, which is close enough over a city.
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
  const spanX = (maxLng - minLng) * kx
  const spanY = maxLat - minLat
  const scale = (size - 1) / Math.max(spanX, spanY)
  return {
    width: Math.round(spanX * scale) + 1,
    height: Math.round(spanY * scale) + 1,
    project: (lat: number, lng: number): [number, number] => [(lng - minLng) * kx * scale, (maxLat - lat) * scale],
  }
}

/**
 * Draws tracks ([lat, lng] polylines) into the city's bounds, scaled so the longer side is `size`
 * pixels. Small enough to send with a profile, and drawn on the client as a mask.
 */
export function rasterize(city: CityId, tracks: Iterable<[number, number][]>, size = RASTER_SIZE): CoverageRaster {
  const { width, height, project } = rasterFrame(city, size)
  const bytes = new Uint8Array(Math.ceil((width * height) / 8))

  const set = (x: number, y: number) => {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= width || py >= height) return
    const i = py * width + px
    bytes[i >> 3] |= 1 << (i & 7)
  }
  for (const track of tracks) {
    let prev: [number, number] | null = null
    for (const [lat, lng] of track) {
      const p = project(lat, lng)
      if (!prev) set(p[0], p[1])
      else {
        // Step a pixel at a time along the line so it has no gaps.
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(p[0] - prev[0]), Math.abs(p[1] - prev[1]))))
        for (let s = 1; s <= steps; s++) set(prev[0] + ((p[0] - prev[0]) * s) / steps, prev[1] + ((p[1] - prev[1]) * s) / steps)
      }
      prev = p
    }
  }

  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return { width, height, bits: btoa(binary) }
}
