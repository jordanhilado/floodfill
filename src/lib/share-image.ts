import { DOMAIN } from './brand'
import type { CityId } from './cities'
import { CITIES } from './cities'
import { formatDistance, formatPercent, type Unit } from './prefs'
import type { Mode } from './query-options'
import { SCHEMES, UI, type ResolvedTheme, type Scheme } from './theme'

export type ShareLayout = 'portrait' | 'landscape'
export type ShareRankings = 'both' | 'neighborhoods' | 'streets'

/**
 * A "street passport", laid out in points and rendered at 3×. Portrait is a 9:16 story
 * (1080 × 1920) with the map on top; landscape is the 1.91:1 link-preview shape (1800 × 945)
 * with the map on the left. Each figure appears once. The palette's "done" color is the only
 * accent and marks progress alone; everything still to go is neutral ink.
 */
const LAYOUTS: Record<ShareLayout, { w: number; h: number }> = {
  portrait: { w: 360, h: 640 },
  landscape: { w: 600, h: 315 },
}
/** Rows per ranking column: one list fills both columns (1–3, 4–6), two lists take one each. */
const ROWS = 3
const SCALE = 3
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif'

export type ShareInput = {
  layout: ShareLayout
  /** Which top-three lists to show. */
  rankings: ShareRankings
  username: string | null
  city: CityId
  mode: Mode
  unit: Unit
  theme: ResolvedTheme
  scheme: Scheme
  percent: number
  completedMeters: number
  totalMeters: number
  streetsCompleted: number
  totalStreets: number
  activities: number | undefined
  completedIds: number[]
  /** Every neighborhood, highest completion first. */
  neighborhoods: { name: string; percent: number }[]
  /** Top streets by number of activities. */
  streets: { name: string; percent: number; activities: number }[]
}

type LineFeature = { id: number; properties: { f: number; b: number }; geometry: { coordinates: [number, number][] } }
type AreaFeature = { properties: { label?: number }; geometry: { type: string; coordinates: number[][][][] } }

export function shareFileName(city: CityId) {
  return `floodfill-${city}-${new Date().toISOString().slice(0, 10)}.png`
}

export async function renderShareImage(input: ShareInput): Promise<Blob> {
  const { city, mode, unit, theme } = input
  const { w: W, h: H } = LAYOUTS[input.layout]
  const portrait = input.layout === 'portrait'
  const dark = theme === 'dark'
  const ui = UI[theme]
  const accent = SCHEMES[input.scheme][theme].done
  // Neutral "to go": map lines, bar tracks and empty stamps all recede behind the accent.
  const base = dark ? '#FFFFFF' : ui.ink
  const toGoLine = withAlpha(base, dark ? 0.15 : 0.16)
  const track = withAlpha(base, dark ? 0.12 : 0.09)
  // Empty stamps and the "to go" key need a touch more weight than a track to read as marks.
  const empty = withAlpha(base, dark ? 0.2 : 0.16)

  const logo = new Image()
  logo.src = `/logo-${theme}.png`
  const [streets, hoods] = await Promise.all([
    fetch(`/data/${city}/streets.geojson`).then((r) => r.json() as Promise<{ features: LineFeature[] }>),
    fetch(`/data/${city}/neighborhoods.geojson`).then((r) => r.json() as Promise<{ features: AreaFeature[] }>),
    logo.decode(),
    document.fonts?.ready,
  ])

  const canvas = document.createElement('canvas')
  canvas.width = W * SCALE
  canvas.height = H * SCALE
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D & { letterSpacing: string }
  ctx.scale(SCALE, SCALE)

  type TextOpts = { weight?: 400 | 500; align?: CanvasTextAlign }
  const font = (size: number, weight: 400 | 500 = 400) => {
    ctx.font = `${weight} ${size}px ${FONT}`
    // The app's -0.15px tracking, tightened for display sizes (-0.05em, as on the progress card).
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${size >= 40 ? -0.05 * size : size >= 20 ? -0.4 : -0.15}px`
  }
  const text = (s: string, x: number, y: number, size: number, color: string, o: TextOpts = {}) => {
    font(size, o.weight)
    ctx.fillStyle = color
    ctx.textAlign = o.align ?? 'left'
    ctx.fillText(s, x, y)
    return ctx.measureText(s).width
  }
  const width = (s: string, size: number, weight: 400 | 500 = 400) => {
    font(size, weight)
    return ctx.measureText(s).width
  }
  const ellipsize = (s: string, size: number, max: number) => {
    if (width(s, size) <= max) return s
    while (s.length > 1 && width(`${s}…`, size) > max) s = s.slice(0, -1)
    return `${s}…`
  }
  /** Runs of [text, color, weight] set on one baseline, like an inline sentence. */
  const runs = (parts: [string, string, (400 | 500)?][], x: number, y: number, size: number, align: 'left' | 'right' = 'left') => {
    let cx = align === 'right' ? x - parts.reduce((w, [s, , wt]) => w + width(s, size, wt), 0) : x
    for (const [s, color, wt] of parts) cx += text(s, cx, y, size, color, { weight: wt })
  }
  const bar = (x: number, y: number, w: number, h: number, pct: number) => {
    ctx.fillStyle = track
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, h / 2)
    ctx.fill()
    if (pct > 0) {
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.roundRect(x, y, Math.max(h, (w * Math.min(100, pct)) / 100), h, h / 2)
      ctx.fill()
    }
  }
  const dot = (x: number, y: number, r: number, color: string) => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const perforation = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.strokeStyle = withAlpha(base, dark ? 0.2 : 0.18)
    ctx.lineWidth = 1
    ctx.setLineDash([2, 4])
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // ── Layout ──────────────────────────────────────────────────────────────────
  const PAD = portrait ? 24 : 20
  // Portrait gives the map nearly the full width and the top of the page; the header sits on it.
  const map = portrait ? { x: 12, y: 8, w: W - 24, h: 320 } : { x: PAD, y: PAD, w: 236, h: 236 }
  const panel = portrait ? { x: PAD, w: W - PAD * 2 } : { x: 300, w: W - 300 - PAD }
  const right = panel.x + panel.w

  // Page: the app's canvas with a faint wash of the accent at the top.
  const pageTop = dark ? mix(ui.canvas, accent, 0.12) : mix('#FFFFFF', accent, 0.05)
  const page = ctx.createLinearGradient(0, 0, 0, H)
  page.addColorStop(0, pageTop)
  page.addColorStop(0.55, dark ? ui.canvas : '#FFFFFF')
  ctx.fillStyle = page
  ctx.fillRect(0, 0, W, H)

  // ── Header: the mark and whose passport this is ─────────────────────────────
  // Portrait stacks it in the open water at the map's top-left (Treasure Island holds the
  // top-right), with a halo of the page color so map lines never cut through the letters.
  const header = () => {
    const headY = portrait ? 34 : 38
    // The app icon for this theme; an opaque tile, so it needs no halo over the map.
    const LOGO = 20
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(logo, panel.x, headY - 15, LOGO, LOGO)
    const handle = input.username ? `@${input.username}` : null
    if (portrait) {
      haloText(DOMAIN, panel.x + LOGO + 7, headY, 14, ui.ink, 500)
      if (handle) haloText(ellipsize(handle, 14, panel.w / 2), panel.x, headY + 20, 14, ui['ink-2'], 500)
    } else {
      const brandW = text(DOMAIN, panel.x + LOGO + 7, headY, 14, ui.ink, { weight: 500 })
      if (handle) text(ellipsize(handle, 14, panel.w - LOGO - 7 - brandW - 16), right, headY, 14, ui.ink, { weight: 500, align: 'right' })
    }
  }
  const haloText = (str: string, x: number, y: number, size: number, color: string, weight: 400 | 500) => {
    font(size, weight)
    ctx.textAlign = 'left'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = pageTop
    ctx.lineWidth = 7
    ctx.strokeText(str, x, y)
    ctx.fillStyle = color
    ctx.fillText(str, x, y)
  }
  if (!portrait) header()

  // ── Map: city land, every path in neutral ink, done ones in the accent with a soft glow ──
  const areas = hoods.features.filter((f) => !f.properties.label && f.geometry.type === 'MultiPolygon')
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const a of areas) for (const poly of a.geometry.coordinates) for (const [lng, lat] of poly[0]) {
    minX = Math.min(minX, lng)
    maxX = Math.max(maxX, lng)
    minY = Math.min(minY, lat)
    maxY = Math.max(maxY, lat)
  }
  const kx = Math.cos((((minY + maxY) / 2) * Math.PI) / 180)
  const s = Math.min(map.w / ((maxX - minX) * kx), map.h / (maxY - minY))
  const ox = map.x + (map.w - (maxX - minX) * kx * s) / 2
  const oy = map.y + (map.h - (maxY - minY) * s) / 2
  const px = (lng: number) => ox + (lng - minX) * kx * s
  const py = (lat: number) => oy + (maxY - lat) * s

  const land = new Path2D()
  for (const a of areas) for (const poly of a.geometry.coordinates) for (const ring of poly) {
    ring.forEach(([lng, lat], i) => (i ? land.lineTo(px(lng), py(lat)) : land.moveTo(px(lng), py(lat))))
    land.closePath()
  }
  ctx.fillStyle = withAlpha(base, dark ? 0.04 : 0.035)
  ctx.fill(land, 'evenodd')

  const done = new Set(input.completedIds)
  const todoPath = new Path2D()
  const donePath = new Path2D()
  const flag = mode === 'foot' ? 'f' : 'b'
  for (const f of streets.features) {
    if (f.properties[flag] !== 1) continue
    const p = done.has(f.id) ? donePath : todoPath
    f.geometry.coordinates.forEach(([lng, lat], i) => (i ? p.lineTo(px(lng), py(lat)) : p.moveTo(px(lng), py(lat))))
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = toGoLine
  ctx.lineWidth = portrait ? 0.4 : 0.3
  ctx.stroke(todoPath)
  ctx.strokeStyle = withAlpha(accent, dark ? 0.28 : 0.2)
  ctx.lineWidth = 2.4
  ctx.stroke(donePath)
  ctx.strokeStyle = accent
  ctx.lineWidth = 0.8
  ctx.stroke(donePath)
  if (portrait) header()

  // ── Neighborhood stamps: one per neighborhood, filled as far as it's done ──
  const hoodsStarted = input.neighborhoods.filter((h) => h.percent > 0).length
  const n = input.neighborhoods.length
  const stampsLabelY = map.y + map.h + (portrait ? 18 : 20)
  text('Neighborhoods', map.x, stampsLabelY, 12, ui['ink-2'])
  runs(
    [
      [String(hoodsStarted), ui.ink, 500],
      [` of ${n}`, ui['ink-2']],
    ],
    map.x + map.w,
    stampsLabelY,
    12,
    'right',
  )
  const stampsY = stampsLabelY + (portrait ? 16 : 13)
  const step = n > 0 ? map.w / n : 0
  const r = Math.min(portrait ? 3.6 : 2.6, step * 0.42)
  input.neighborhoods.forEach((hood, i) => {
    const cx = map.x + step * (i + 0.5)
    dot(cx, stampsY, r, empty)
    if (hood.percent <= 0) return
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.moveTo(cx, stampsY)
    ctx.arc(cx, stampsY, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.min(100, hood.percent)) / 100)
    ctx.closePath()
    ctx.fill()
  })

  // Perforation: across the page under the stamps, or down the fold in landscape.
  if (portrait) perforation(0, stampsY + 18, W, stampsY + 18)
  else perforation(278, PAD, 278, H - PAD)

  // ── Progress, in the progress card's own pattern ────────────────────────────
  let y = portrait ? stampsY + 72 : 96
  const hero = portrait ? 56 : 46
  const pct = formatPercent(input.percent).replace('%', '')
  const pctW = text(pct, panel.x, y, hero, ui.ink, { weight: 500 })
  text('%', panel.x + pctW + 2, y, Math.round(hero * 0.5), ui['ink-2'], { weight: 500 })
  y += portrait ? 22 : 20
  text(`of ${CITIES[city].name} paths, ${mode === 'foot' ? 'on foot' : 'by bike'}`, panel.x, y, 13, ui['ink-2'])
  y += 12
  bar(panel.x, y, panel.w, 4, input.percent)
  y += 22
  dot(panel.x + 3, y - 4, 3, accent)
  runs(
    [
      [`${formatDistance(input.completedMeters, unit)} ${unit}`, ui.ink, 500],
      [' done', ui['ink-2']],
    ],
    panel.x + 11,
    y,
    12,
  )
  const toGo = `${formatDistance(input.totalMeters - input.completedMeters, unit)} ${unit} to go`
  const toGoW = text(toGo, right, y, 12, ui['ink-2'], { align: 'right' })
  dot(right - toGoW - 8, y - 4, 3, empty)
  y += portrait ? 24 : 22
  runs(
    [
      [input.activities === undefined ? '–' : num(input.activities), ui.ink, 500],
      [input.activities === 1 ? ' activity' : ' activities', ui['ink-2']],
      ['  ·  ', ui['ink-3']],
      [num(input.streetsCompleted), ui.ink, 500],
      [` of ${num(input.totalStreets)} streets complete`, ui['ink-2']],
    ],
    panel.x,
    y,
    13,
  )

  // ── Rankings: two lists side by side, or one list across both columns ──────
  y += 34
  const gap = 16
  const colW = (panel.w - gap) / 2
  const rowH = portrait ? 18 : 17
  const column = <T extends { name: string; percent: number }>(
    x: number,
    title: string,
    items: T[],
    value: (item: T) => string,
    from = 0,
  ) => {
    if (title) text(title, x, y, 12, ui['ink-2'])
    items.slice(from, from + ROWS).forEach((item, i) => {
      const rowY = y + rowH + i * rowH
      text(String(from + i + 1), x, rowY, 12, ui['ink-3'])
      const v = value(item)
      const vW = width(v, 12)
      text(ellipsize(item.name, 12, colW - 14 - vW - 6), x + 14, rowY, 12, ui.ink)
      text(v, x + colW, rowY, 12, ui['ink-2'], { align: 'right' })
      bar(x + 14, rowY + 4.5, colW - 14, 2, item.percent)
    })
  }
  const second = panel.x + colW + gap
  const hoodPct = (h: { percent: number }) => formatPercent(h.percent)
  const streetActs = (st: { activities: number }) => num(st.activities)
  if (input.rankings === 'both') {
    column(panel.x, 'Top neighborhoods', input.neighborhoods, hoodPct)
    column(second, 'Top paths', input.streets, streetActs)
  } else if (input.rankings === 'neighborhoods') {
    column(panel.x, 'Top neighborhoods', input.neighborhoods, hoodPct)
    column(second, '', input.neighborhoods, hoodPct, ROWS)
  } else {
    column(panel.x, 'Top paths', input.streets, streetActs)
    column(second, '', input.streets, streetActs, ROWS)
  }

  // ── Footer: OpenStreetMap's required notice and the date ───────────────────
  const footY = H - (portrait ? 14 : 12)
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  text('© OpenStreetMap contributors', panel.x, footY, 10, ui['ink-2'])
  text(date, right, footY, 10, ui['ink-2'], { align: 'right' })

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create image'))), 'image/png'),
  )
}

const num = (n: number) => n.toLocaleString('en-US')

function withAlpha(hex: string, alpha: number) {
  const [r, g, b] = rgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** `a` blended toward `b` by `t` (0–1), as a hex color. */
function mix(a: string, b: string, t: number) {
  const ca = rgb(a)
  const cb = rgb(b)
  return `#${ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
