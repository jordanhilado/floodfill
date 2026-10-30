import { describe, expect, it } from 'vitest'
import { CITIES } from '../../lib/cities'
import { rasterize } from './raster'

const covered = (r: ReturnType<typeof rasterize>) => {
  const bytes = atob(r.bits)
  let n = 0
  for (let i = 0; i < r.width * r.height; i++) if (bytes.charCodeAt(i >> 3) & (1 << (i & 7))) n++
  return n
}
const pixel = (r: ReturnType<typeof rasterize>, x: number, y: number) => {
  const i = y * r.width + x
  return (atob(r.bits).charCodeAt(i >> 3) >> (i & 7)) & 1
}

describe('rasterize', () => {
  const [[minLng, minLat], [maxLng, maxLat]] = CITIES.sf.bounds

  it('fits the city bounds with the longer side at the requested size', () => {
    const r = rasterize('sf', [], 100)
    expect(Math.max(r.width, r.height)).toBe(100)
    expect(covered(r)).toBe(0)
  })

  it('draws a line without gaps, corner to corner', () => {
    const r = rasterize('sf', [[[maxLat, minLng], [maxLat, maxLng]]], 100)
    // Along the top edge, every pixel of the row.
    expect(covered(r)).toBe(r.width)
    expect(pixel(r, 0, 0)).toBe(1)
    expect(pixel(r, r.width - 1, 0)).toBe(1)
  })

  it('skips points outside the city', () => {
    const r = rasterize('sf', [[[minLat - 1, minLng - 1]]], 100)
    expect(covered(r)).toBe(0)
  })
})
