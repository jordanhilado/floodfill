import { queryOptions } from '@tanstack/react-query'
import { rasterFrame } from '../server/coverage/raster'
import type { CityId } from './cities'

type Ring = [number, number][] // [lng, lat]
type Area = { geometry: { type: string; coordinates: unknown } | null }

/** Room around a city's frame, in raster pixels, so its outline isn't cut off at the bounds. */
export const OUTLINE_PAD = 4
/** Drawn finer than the coverage raster so the line stays crisp. */
const SCALE = 3
/** The outline's width, and the seams it closes between neighboring polygons, in canvas pixels. */
const LINE = 5
const SEAM = 1.5

/**
 * A city's outline as a PNG mask, framed like its coverage raster plus OUTLINE_PAD on every
 * side. Drawn from the neighborhood polygons: a wide stroke around all of them, minus their
 * insides, leaves only the line around the city.
 */
export async function cityOutlineMask(city: CityId): Promise<string | null> {
  const res = await fetch(`/data/${city}/neighborhoods.geojson`)
  if (!res.ok) throw new Error(`Neighborhoods fetch failed: ${res.status}`)
  const { features } = (await res.json()) as { features: Area[] }
  const { width, height, project } = rasterFrame(city)
  const canvas = document.createElement('canvas')
  canvas.width = (width + 2 * OUTLINE_PAD) * SCALE
  canvas.height = (height + 2 * OUTLINE_PAD) * SCALE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const shape = new Path2D()
  for (const { geometry: g } of features) {
    // The file also holds label points.
    const polygons = g?.type === 'MultiPolygon' ? (g.coordinates as Ring[][]) : g?.type === 'Polygon' ? [g.coordinates as Ring[]] : []
    for (const ring of polygons.flat()) {
      ring.forEach(([lng, lat], i) => {
        const [x, y] = project(lat, lng)
        const px = (x + OUTLINE_PAD) * SCALE
        const py = (y + OUTLINE_PAD) * SCALE
        if (i) shape.lineTo(px, py)
        else shape.moveTo(px, py)
      })
      shape.closePath()
    }
  }
  ctx.lineJoin = 'round'
  ctx.lineWidth = (LINE + SEAM) * 2
  ctx.stroke(shape)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fill(shape)
  ctx.lineWidth = SEAM * 2
  ctx.stroke(shape)
  return canvas.toDataURL()
}

export const cityOutlineQuery = (city: CityId) =>
  queryOptions({
    queryKey: ['city-outline', city],
    queryFn: () => cityOutlineMask(city),
    staleTime: Infinity,
  })
