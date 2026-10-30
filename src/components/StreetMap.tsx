import 'maplibre-gl/dist/maplibre-gl.css'
import * as maplibregl from 'maplibre-gl'
// Bundle MapLibre's worker (and the chunk it shares with the main thread) as one ES module.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useEffect, useRef, useState } from 'react'
import { CITIES, type CityId } from '../lib/cities'
import { NEIGHBORHOODS } from '../lib/neighborhoods'
import { formatPercent } from '../lib/prefs'
import type { Mode } from '../lib/query-options'
import { loadStreets, type StreetCollection } from '../lib/street-index'
import { MAP_THEME, SCHEMES, type ResolvedTheme, type Scheme } from '../lib/theme'

maplibregl.setWorkerUrl(workerUrl)
type MapLibreMap = maplibregl.Map

const SOURCE = 'streets'
/** "To go" lines; the progress bars' track uses the same color (bg-todo/90). */
const TODO_OPACITY = 0.9
const HOODS = 'neighborhoods'
/** How far (px) from the pointer a street can be and still be hovered or tapped. */
const HIT_RADIUS = { mouse: 12, touch: 22 }

const modeFilter = (mode: Mode): maplibregl.FilterSpecification => ['==', ['get', mode === 'foot' ? 'f' : 'b'], 1]

// Paths (k = 1) draw a little thinner than streets.
const width = (base: number): maplibregl.ExpressionSpecification => {
  const w = (v: number): maplibregl.ExpressionSpecification => ['*', v, ['case', ['==', ['get', 'k'], 1], 0.7, 1]]
  return ['interpolate', ['exponential', 1.6], ['zoom'], 11, w(base), 14, w(base * 2.4), 17, w(base * 6)]
}
const stateOpacity = (key: string, on = 1): maplibregl.ExpressionSpecification => [
  'case',
  ['boolean', ['feature-state', key], false],
  on,
  0,
]
/** Soft halo under completed lines so they stand out a little from the basemap. */
const GLOW = { width: 5, blur: ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 6] as maplibregl.ExpressionSpecification, opacity: 0.35 }

// Polygons vs. the label points that share the neighborhoods source.
const isArea: maplibregl.ExpressionSpecification = ['!', ['has', 'label']]
const namedArea = (name: string | undefined): maplibregl.FilterSpecification => [
  'all',
  isArea,
  ['==', ['get', 'name'], name ?? ''],
]
// Everything except the selection; matches nothing while no neighborhood is selected.
const otherAreas = (name: string | undefined): maplibregl.FilterSpecification =>
  name ? ['all', isArea, ['!=', ['get', 'name'], name]] : ['==', ['get', 'name'], '']

/**
 * Keeps a fitted area clear of the floating panels (left column on desktop, bottom sheet on
 * phones, at the height it's resting at or heading to). `streetCard` also clears the selected
 * street/neighborhood cards (top right on desktop, under the nav on phones); by default it
 * follows whether one is showing.
 */
const panelPadding = (streetCard = document.querySelector('[data-street-card]') !== null) => {
  if (window.innerWidth >= 640) return { top: streetCard ? 80 : 32, right: streetCard ? 372 : 32, bottom: 32, left: 412 }
  const sheet = Number(document.querySelector<HTMLElement>('[data-panels]')?.dataset.inset) || 180
  const top = streetCard ? 180 : 72
  return { top, right: 16, bottom: Math.min(sheet + 8, window.innerHeight - top - 88), left: 16 }
}

/** A map button that frames the whole city again, above the zoom buttons. */
class CenterControl implements maplibregl.IControl {
  private el: HTMLDivElement | null = null
  constructor(private readonly recenter: () => void) {}
  onAdd() {
    const el = document.createElement('div')
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group maplibregl-ctrl-center-group'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'maplibregl-ctrl-center'
    button.title = 'Show the whole city'
    button.setAttribute('aria-label', 'Show the whole city')
    // lucide "scan"
    button.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/></svg>'
    button.addEventListener('click', this.recenter)
    el.appendChild(button)
    this.el = el
    return el
  }
  onRemove() {
    this.el?.remove()
    this.el = null
  }
}

type Look = { theme: ResolvedTheme; scheme: Scheme }

/** Adds the street and neighborhood layers. Runs on every style load, since a basemap swap drops them. */
function install(map: MapLibreMap, city: CityId, streets: StreetCollection, { theme, scheme }: Look) {
  const c = SCHEMES[scheme][theme]
  const t = MAP_THEME[theme]
  // Streets go above every basemap road but under the labels that follow them, so names
  // stay legible. (Some styles put a water label before the roads, so "first symbol" is too low.)
  const layers = map.getStyle().layers
  const lastLine = layers.map((l) => l.type).lastIndexOf('line')
  const firstSymbol = layers.slice(lastLine + 1).find((l) => l.type === 'symbol')?.id
  map.addSource(SOURCE, { type: 'geojson', data: streets })
  const line = (id: string, paint: maplibregl.LineLayerSpecification['paint']) =>
    map.addLayer(
      { id, type: 'line', source: SOURCE, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint },
      firstSymbol,
    )
  line('streets-todo', { 'line-color': c.todo, 'line-width': width(1.4), 'line-opacity': TODO_OPACITY })
  line('streets-done-glow', {
    'line-color': c.done,
    'line-width': width(GLOW.width),
    'line-blur': GLOW.blur,
    'line-opacity': stateOpacity('done', GLOW.opacity),
  })
  line('streets-done', { 'line-color': c.done, 'line-width': width(1.6), 'line-opacity': stateOpacity('done') })
  line('streets-selected', { 'line-color': c.selected, 'line-width': width(1.4), 'line-opacity': stateOpacity('selected') })

  map.addSource(HOODS, { type: 'geojson', data: `/data/${city}/neighborhoods.geojson` })
  // Spotlight: wash out the streets in every other neighborhood.
  map.addLayer({
    id: 'hoods-dim',
    type: 'fill',
    source: HOODS,
    filter: otherAreas(undefined),
    paint: { 'fill-color': t.dim, 'fill-opacity': t.dimOpacity },
  })
  map.addLayer({
    id: 'hoods-line',
    type: 'line',
    source: HOODS,
    filter: isArea,
    paint: { 'line-color': t.ink, 'line-opacity': 0.35, 'line-width': 1, 'line-dasharray': [3, 2] },
  })
  map.addLayer({
    id: 'hoods-selected-casing',
    type: 'line',
    source: HOODS,
    filter: namedArea(undefined),
    layout: { 'line-join': 'round' },
    paint: { 'line-color': t.halo, 'line-width': 7 },
  })
  map.addLayer({
    id: 'hoods-selected-line',
    type: 'line',
    source: HOODS,
    filter: namedArea(undefined),
    layout: { 'line-join': 'round' },
    paint: { 'line-color': t.ink, 'line-width': 3 },
  })
  map.addLayer({
    id: 'hoods-label',
    type: 'symbol',
    source: HOODS,
    filter: ['has', 'label'],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-letter-spacing': -0.01,
      'text-max-width': 8,
    },
    paint: { 'text-color': t.label, 'text-halo-color': t.halo, 'text-halo-width': 1.5 },
  })
}

/** The street nearest the pointer within the hit radius, measured on screen. */
function pick(map: MapLibreMap, point: maplibregl.Point, radius: number) {
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [point.x - radius, point.y - radius],
    [point.x + radius, point.y + radius],
  ]
  let best: maplibregl.MapGeoJSONFeature | null = null
  let bestD = Infinity
  for (const f of map.queryRenderedFeatures(box, { layers: ['streets-todo'] })) {
    if (f.geometry.type !== 'LineString') continue
    const pts = (f.geometry.coordinates as [number, number][]).map((c) => map.project(c))
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
      const d = Math.hypot(a.x + t * dx - point.x, a.y + t * dy - point.y)
      if (d < bestD) [best, bestD] = [f, d]
    }
  }
  return bestD <= radius ? best : null
}

/** Mirrors a set of segment ids into a boolean feature state; a style reload re-applies it all. */
function useSegmentState(map: MapLibreMap | null, dataVersion: number, key: string, ids: number[]) {
  const applied = useRef<{ version: number; ids: number[] }>({ version: 0, ids: [] })
  useEffect(() => {
    if (!dataVersion || !map) return
    if (applied.current.version === dataVersion) {
      const next = new Set(ids)
      for (const id of applied.current.ids) if (!next.has(id)) map.setFeatureState({ source: SOURCE, id }, { [key]: false })
    }
    for (const id of ids) map.setFeatureState({ source: SOURCE, id }, { [key]: true })
    applied.current = { version: dataVersion, ids }
  }, [map, dataVersion, key, ids])
}

type Hover = {
  x: number
  y: number
  name: string
  hood: string | null
  /** Share of the whole street done, or null until the street index has loaded. */
  percent: number | null
  /** This segment's own state, the fallback before the index loads. */
  done: boolean
}

export default function StreetMap({
  city,
  mode,
  completedIds,
  selectedNeighborhood,
  selectedStreetIds,
  streetFocus,
  onPickStreet,
  streetPercent,
  theme,
  scheme,
}: {
  city: CityId
  mode: Mode
  completedIds: number[]
  selectedNeighborhood: string | undefined
  /** Segments of the tapped street, drawn in the palette's selection color. */
  selectedStreetIds: number[]
  /** A street picked from the list: frame it, as a neighborhood selection does. */
  streetFocus: { key: string; bbox: [number, number, number, number] } | null
  /** A tapped segment id, or null for a tap on empty map. */
  onPickStreet: (segmentId: number | null) => void
  /** Percent done of the street a segment belongs to, in the current mode. */
  streetPercent: (segmentId: number) => number | null
  theme: ResolvedTheme
  scheme: Scheme
}) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  // Bumped after each style (re)load once our layers exist, so every effect below re-applies.
  const [styleVersion, setStyleVersion] = useState(0)
  // Same, but only once the street data has loaded (feature state needs the features).
  const [dataVersion, setDataVersion] = useState(0)
  const [hover, setHover] = useState<Hover | null>(null)
  const onPickRef = useRef(onPickStreet)
  onPickRef.current = onPickStreet
  const percentRef = useRef(streetPercent)
  percentRef.current = streetPercent
  const themeRef = useRef(theme)
  // The neighborhood the camera last framed (a link can open with one selected).
  const framed = useRef<string | undefined>(undefined)
  const lookRef = useRef<Look>({ theme, scheme })
  lookRef.current = { theme, scheme }

  useEffect(() => {
    const c = CITIES[city]
    framed.current = undefined
    const map = new maplibregl.Map({
      container: container.current!,
      style: MAP_THEME[themeRef.current].style,
      bounds: c.bounds,
      fitBoundsOptions: { padding: 24 },
      // Generous, so the city can still be framed above the bottom panels on phones.
      maxBounds: [
        [c.bounds[0][0] - 0.6, c.bounds[0][1] - 0.5],
        [c.bounds[1][0] + 0.6, c.bounds[1][1] + 0.5],
      ],
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    })
    map.touchZoomRotate.disableRotation()
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    // Added after the zoom buttons, so it stacks above them.
    map.addControl(new CenterControl(() => map.fitBounds(c.bounds, { padding: panelPadding(), duration: 700 })), 'bottom-right')
    mapRef.current = map

    map.once('load', () => {
      // Frame the city in the area the panels leave visible, unless a neighborhood already was.
      if (!framed.current) map.fitBounds(c.bounds, { padding: panelPadding(), duration: 0 })
      // Phones: start the attribution collapsed to its info button (MapLibre collapses it on
      // first interaction anyway) so it doesn't run under the "Built by" credit.
      if (window.innerWidth < 640) container.current?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show')
    })

    // Counts style loads, so streets that arrive after another basemap swap skip the stale style.
    let styleLoads = 0
    map.on('style.load', () => {
      const load = ++styleLoads
      void loadStreets(city).then((streets) => {
        if (mapRef.current !== map || load !== styleLoads) return
        install(map, city, streets, lookRef.current)
        setStyleVersion((v) => v + 1)
        map.on('sourcedata', function onData(e) {
          if (e.sourceId === SOURCE && map.isSourceLoaded(SOURCE)) {
            map.off('sourcedata', onData)
            setDataVersion((v) => v + 1)
          }
        })
      })
    })

    let frame = 0
    map.on('mousemove', (e) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!map.getLayer('streets-todo')) return
        const f = pick(map, e.point, HIT_RADIUS.mouse)
        map.getCanvas().style.cursor = f ? 'pointer' : ''
        if (!f) return setHover(null)
        const p = f.properties as { n?: string; k?: number; h?: number }
        setHover({
          x: e.point.x,
          y: e.point.y,
          name: p.n ?? (p.k === 1 ? 'Path' : 'Unnamed street'),
          hood: p.h !== undefined ? (NEIGHBORHOODS[city][p.h]?.name ?? null) : null,
          percent: percentRef.current(Number(f.id)),
          done: Boolean(map.getFeatureState({ source: SOURCE, id: f.id })?.done),
        })
      })
    })
    map.on('mouseout', () => setHover(null))
    map.on('click', (e) => {
      if (!map.getLayer('streets-todo')) return
      const touch = (e.originalEvent as PointerEvent).pointerType === 'touch'
      const f = pick(map, e.point, touch ? HIT_RADIUS.touch : HIT_RADIUS.mouse)
      onPickRef.current(f ? Number(f.id) : null)
    })

    return () => {
      cancelAnimationFrame(frame)
      map.remove()
      mapRef.current = null
    }
  }, [city])

  // Light/dark swaps the basemap; style.load then reinstalls our layers.
  useEffect(() => {
    const map = mapRef.current
    if (!map || themeRef.current === theme) return
    themeRef.current = theme
    setHover(null)
    map.setStyle(MAP_THEME[theme].style, { diff: false })
  }, [theme])

  // Colors for the current palette and theme.
  useEffect(() => {
    const map = mapRef.current
    if (!styleVersion || !map) return
    const c = SCHEMES[scheme][theme]
    const t = MAP_THEME[theme]
    map.setPaintProperty('streets-todo', 'line-color', c.todo)
    map.setPaintProperty('streets-done', 'line-color', c.done)
    map.setPaintProperty('streets-done-glow', 'line-color', c.done)
    map.setPaintProperty('streets-selected', 'line-color', c.selected)
    map.setPaintProperty('hoods-dim', 'fill-color', t.dim)
    map.setPaintProperty('hoods-dim', 'fill-opacity', t.dimOpacity)
    map.setPaintProperty('hoods-line', 'line-color', t.ink)
    map.setPaintProperty('hoods-selected-casing', 'line-color', t.halo)
    map.setPaintProperty('hoods-selected-line', 'line-color', t.ink)
    map.setPaintProperty('hoods-label', 'text-halo-color', t.halo)
  }, [styleVersion, scheme, theme])

  useEffect(() => {
    const map = mapRef.current
    if (!styleVersion || !map) return
    for (const id of ['streets-todo', 'streets-done-glow', 'streets-done', 'streets-selected']) map.setFilter(id, modeFilter(mode))
  }, [styleVersion, mode])

  // Highlight the selected neighborhood and frame it; "All" frames the whole city again.
  useEffect(() => {
    const map = mapRef.current
    if (!styleVersion || !map) return
    const t = MAP_THEME[theme]
    map.setFilter('hoods-selected-line', namedArea(selectedNeighborhood))
    map.setFilter('hoods-selected-casing', namedArea(selectedNeighborhood))
    map.setFilter('hoods-dim', otherAreas(selectedNeighborhood))
    map.setPaintProperty('hoods-label', 'text-color', [
      'case',
      ['==', ['get', 'name'], selectedNeighborhood ?? ''],
      t.ink,
      t.label,
    ])
    if (framed.current === selectedNeighborhood) return
    framed.current = selectedNeighborhood
    const b = NEIGHBORHOODS[city].find((n) => n.name === selectedNeighborhood)?.bbox
    const bounds: maplibregl.LngLatBoundsLike = b ? [[b[0], b[1]], [b[2], b[3]]] : CITIES[city].bounds
    map.fitBounds(bounds, { padding: panelPadding(), duration: 700, maxZoom: 16 })
  }, [styleVersion, selectedNeighborhood, city, theme])

  // A street picked from the list gets framed once, like a neighborhood.
  const focusedStreet = useRef<string | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!streetFocus) focusedStreet.current = null
    if (!styleVersion || !map || !streetFocus || focusedStreet.current === streetFocus.key) return
    focusedStreet.current = streetFocus.key
    const [x0, y0, x1, y1] = streetFocus.bbox
    map.fitBounds(
      [
        [x0, y0],
        [x1, y1],
      ],
      { padding: panelPadding(true), duration: 700, maxZoom: 17 },
    )
  }, [styleVersion, streetFocus])

  useSegmentState(mapRef.current, dataVersion, 'done', completedIds)
  useSegmentState(mapRef.current, dataVersion, 'selected', selectedStreetIds)

  const colors = SCHEMES[scheme][theme]
  return (
    <div className="absolute inset-0">
      {/* maplibre-gl.css sets position: relative on the container, so size it explicitly */}
      <div ref={container} className="h-full w-full" />
      {hover && (
        <div
          className="surface pointer-events-none absolute z-10 min-w-36 whitespace-nowrap rounded-[8px] px-2 py-1.5 text-12 text-ink"
          style={{ left: hover.x + 14, top: hover.y + 14 }}
        >
          {/* Neighborhood, then the street, then its progress line with the percent at the end. */}
          {hover.hood && <div className="text-ink-2">{hover.hood}</div>}
          <div className="font-medium">{hover.name}</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: colors.todo }} aria-hidden>
              <span
                className="block h-full rounded-full"
                style={{ width: `${hover.percent ?? (hover.done ? 100 : 0)}%`, background: colors.done }}
              />
            </span>
            <span className="shrink-0 tabular-nums text-ink-2">
              {hover.percent === null ? (hover.done ? 'Done' : 'To go') : formatPercent(hover.percent)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
