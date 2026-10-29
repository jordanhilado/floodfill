/**
 * Builds the street + path network for a city from OpenStreetMap (Overpass API).
 *
 *   node scripts/build-streets.ts [cityId] [--refresh]
 *
 * Outputs:
 *   public/data/<city>/streets.geojson   – map geometry (static asset, cached by the CDN)
 *   db/seed/<city>-segments.sql          – D1 seed used by the coverage matcher
 *   public/data/<city>/neighborhoods.geojson + src/lib/neighborhoods.<city>.json
 *                                        – official neighborhood boundaries and their bounds
 *
 * Counted: public streets (no freeways or service roads) plus footways, paths,
 * cycleways, steps and tracks. Sidewalks and crossings are skipped because they
 * duplicate the street they run along. Ways are split at intersections and capped
 * at MAX_SEGMENT_M so that each segment roughly corresponds to one block face.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { CITIES, type CityId } from '../src/lib/cities.ts'
import { encodePolyline } from '../src/lib/polyline.ts'
import { haversine } from '../src/lib/geo.ts'
import { loadNeighborhoods, makeLocator, toGeoJSON } from './neighborhoods.ts'

const MAX_SEGMENT_M = 150
const MIN_SEGMENT_M = 20
const MERGE_BELOW_M = 25

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const STREETS = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian'])
const PATHS = new Set(['footway', 'path', 'cycleway', 'steps', 'track', 'bridleway'])
// Footways mapped alongside or across a street duplicate that street.
const SKIP_FOOTWAYS = new Set(['sidewalk', 'crossing', 'traffic_island', 'access_aisle', 'link'])

type OsmWay = {
  type: 'way'
  id: number
  nodes: number[]
  geometry: { lat: number; lon: number }[]
  tags: Record<string, string>
}
type OsmNode = { type: 'node'; id: number }
type Overpass = { elements: (OsmWay | OsmNode)[] }

type Kind = 'street' | 'path'

type Segment = {
  id: number
  wayId: number
  name: string | null
  highway: string
  kind: Kind
  neighborhood: string | null
  foot: 0 | 1
  bike: 0 | 1
  coords: [number, number][] // [lat, lng]
  length: number
}

const root = path.resolve(import.meta.dirname, '..')

async function fetchOverpass(cityId: CityId, refresh: boolean): Promise<Overpass> {
  const city = CITIES[cityId]
  const cacheFile = path.join(root, '.cache/osm', `${cityId}-ways.json`)
  if (!refresh && existsSync(cacheFile)) {
    console.log(`Using cached ${path.relative(root, cacheFile)}`)
    return JSON.parse(await readFile(cacheFile, 'utf8'))
  }

  // Everything routable; scripts/build-streets.ts decides per mode what counts.
  const query = `[out:json][timeout:300];
rel(${city.osmRelationId});map_to_area->.city;
way["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|abandoned|platform|raceway|elevator|corridor|bus_stop|rest_area|services)$"]["area"!="yes"](area.city)->.w;
.w out body geom qt;
node(w.w)(area.city);
out ids qt;`

  let delay = 5_000
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length]
    console.log(`Overpass attempt ${attempt + 1} → ${new URL(url).host}`)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'floodfill-prototype/0.1 (street coverage)',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(320_000),
      })
      const text = await res.text()
      if (res.ok && text.trimStart().startsWith('{')) {
        await mkdir(path.dirname(cacheFile), { recursive: true })
        await writeFile(cacheFile, text)
        return JSON.parse(text)
      }
      console.warn(`  ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`)
    } catch (err) {
      console.warn(`  ${(err as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, 60_000)
  }
  throw new Error('Overpass unavailable on all mirrors')
}

const isYes = (v?: string) => v === 'yes' || v === 'designated' || v === 'permissive'
const isNo = (v?: string) => v === 'no' || v === 'private'

/** Whether a way counts, as what, and for which modes. */
function classify(t: Record<string, string>): { kind: Kind; foot: 0 | 1; bike: 0 | 1 } | null {
  if (isNo(t.access) || t.indoor === 'yes') return null
  const hw = t.highway
  let kind: Kind
  if (STREETS.has(hw)) kind = 'street'
  else if (PATHS.has(hw) && !SKIP_FOOTWAYS.has(t.footway ?? '')) kind = 'path'
  else return null

  // Freeway-style trunks without sidewalks are tagged foot=no; trust the tag.
  const foot = !isNo(t.foot)
  let bike: boolean
  if (isNo(t.bicycle) || t.bicycle === 'dismount' || hw === 'steps') bike = false
  else if (hw === 'pedestrian' || hw === 'footway' || hw === 'bridleway') bike = isYes(t.bicycle)
  else bike = true
  if (!foot && !bike) return null
  return { kind, foot: foot ? 1 : 0, bike: bike ? 1 : 0 }
}

/** Splits a polyline into `n` pieces of equal length, interpolating cut points. */
function splitEvenly(coords: [number, number][], total: number, n: number): [number, number][][] {
  if (n <= 1) return [coords]
  const target = total / n
  const out: [number, number][][] = []
  let current: [number, number][] = [coords[0]]
  let acc = 0
  for (let i = 1; i < coords.length; i++) {
    let a = coords[i - 1]
    const b = coords[i]
    let d = haversine(a, b)
    while (acc + d >= target && out.length < n - 1) {
      const t = (target - acc) / d
      const cut: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      current.push(cut)
      out.push(current)
      current = [cut]
      d -= target - acc
      a = cut
      acc = 0
    }
    acc += d
    current.push(b)
  }
  out.push(current)
  return out
}

function lineLength(coords: [number, number][]) {
  let len = 0
  for (let i = 1; i < coords.length; i++) len += haversine(coords[i - 1], coords[i])
  return len
}

const round = (v: number) => Math.round(v * 1e6) / 1e6

function buildSegments(data: Overpass): Segment[] {
  const ways = data.elements.filter((e): e is OsmWay => e.type === 'way' && classify(e.tags) !== null)
  const inside = new Set(data.elements.filter((e) => e.type === 'node').map((e) => e.id))

  // A node referenced more than once across kept ways is an intersection.
  const refs = new Map<number, number>()
  for (const w of ways) for (const n of w.nodes) refs.set(n, (refs.get(n) ?? 0) + 1)

  const segments: Segment[] = []
  let nextId = 1
  for (const w of ways) {
    const { kind, foot, bike } = classify(w.tags)!

    // Pieces of one contiguous run of the way (split at intersections).
    let run: [number, number][][] = []
    let piece: [number, number][] = []
    const endPiece = () => {
      if (piece.length >= 2) run.push(piece)
    }
    const flushRun = () => {
      endPiece()
      // Merge pieces shorter than MERGE_BELOW_M into a neighbour. These are mostly
      // stubs inside intersections of divided roads, which would otherwise be
      // "completed" just by crossing the street.
      const merged: [number, number][][] = []
      for (const p of run) {
        const last = merged.at(-1)
        if (last && (lineLength(p) < MERGE_BELOW_M || lineLength(last) < MERGE_BELOW_M)) {
          merged[merged.length - 1] = [...last, ...p.slice(1)]
        } else merged.push(p)
      }
      for (const m of merged) {
        const len = lineLength(m)
        if (len < MIN_SEGMENT_M) continue
        for (const part of splitEvenly(m, len, Math.ceil(len / MAX_SEGMENT_M))) {
          const coords = part.map(([la, ln]) => [round(la), round(ln)] as [number, number])
          segments.push({
            id: nextId++,
            wayId: w.id,
            name: w.tags.name ?? null,
            highway: w.tags.highway,
            kind,
            neighborhood: null,
            foot,
            bike,
            coords,
            length: lineLength(coords),
          })
        }
      }
      run = []
      piece = []
    }

    for (let i = 0; i < w.nodes.length; i++) {
      const nodeId = w.nodes[i]
      const g = w.geometry[i]
      if (!g || !inside.has(nodeId)) {
        flushRun()
        continue
      }
      piece.push([g.lat, g.lon])
      const isEnd = i === 0 || i === w.nodes.length - 1
      if (!isEnd && (refs.get(nodeId) ?? 0) > 1) {
        endPiece()
        piece = [[g.lat, g.lon]]
      }
    }
    flushRun()
  }
  return segments
}

const sqlStr = (s: string | null) => (s === null ? 'NULL' : `'${s.replaceAll("'", "''")}'`)

async function main() {
  const args = process.argv.slice(2)
  const cityId = (args.find((a) => !a.startsWith('--')) ?? 'sf') as CityId
  if (!CITIES[cityId]) throw new Error(`Unknown city ${cityId}`)
  const refresh = args.includes('--refresh')
  const data = await fetchOverpass(cityId, refresh)
  const segments = buildSegments(data)

  const hoods = await loadNeighborhoods(CITIES[cityId], path.join(root, '.cache/osm'), refresh)
  const locate = makeLocator(hoods)
  for (const s of segments) {
    const [lat, lng] = s.coords[Math.floor(s.coords.length / 2)]
    const [lat2, lng2] = s.coords[Math.ceil(s.coords.length / 2) - 1]
    s.neighborhood = locate((lng + lng2) / 2, (lat + lat2) / 2)
  }
  if (hoods.length) {
    await mkdir(path.join(root, 'public/data', cityId), { recursive: true })
    await writeFile(path.join(root, 'public/data', cityId, 'neighborhoods.geojson'), JSON.stringify(toGeoJSON(hoods)))
    await writeFile(
      path.join(root, 'src/lib', `neighborhoods.${cityId}.json`),
      `[\n${hoods.map((h) => JSON.stringify({ name: h.name, bbox: h.bbox.map((v) => Math.round(v * 1e5) / 1e5) })).join(',\n')}\n]\n`,
    )
  }

  // h: index into src/lib/neighborhoods.<city>.json, so the client can name a segment's neighborhood.
  const hoodIndex = new Map(hoods.map((h, i) => [h.name, i]))
  const geojson = {
    type: 'FeatureCollection',
    features: segments.map((s) => ({
      type: 'Feature',
      id: s.id,
      // k: 1 for paths, so the map can draw them thinner than streets
      properties: {
        n: s.name,
        k: s.kind === 'path' ? 1 : 0,
        f: s.foot,
        b: s.bike,
        ...(s.neighborhood !== null && { h: hoodIndex.get(s.neighborhood) }),
      },
      geometry: {
        type: 'LineString',
        coordinates: s.coords.map(([la, ln]) => [Math.round(ln * 1e5) / 1e5, Math.round(la * 1e5) / 1e5]),
      },
    })),
  }
  const geoPath = path.join(root, 'public/data', cityId, 'streets.geojson')
  await mkdir(path.dirname(geoPath), { recursive: true })
  await writeFile(geoPath, JSON.stringify(geojson))

  const lines = [
    `-- Generated by scripts/build-streets.ts from OpenStreetMap (© OpenStreetMap contributors, ODbL)`,
    // Segment ids change on every build, so drop derived coverage and ask the next
    // sync to re-match stored tracks (no Strava requests needed).
    `DELETE FROM coverage WHERE segment_id IN (SELECT id FROM segments WHERE city = ${sqlStr(cityId)});`,
    `DELETE FROM activity_segments WHERE segment_id IN (SELECT id FROM segments WHERE city = ${sqlStr(cityId)});`,
    `DELETE FROM segments WHERE city = ${sqlStr(cityId)};`,
    `INSERT INTO state (key, value, updated_at) VALUES ('rematch', '{"ts":0,"id":0}', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
  ]
  const BATCH = 200
  for (let i = 0; i < segments.length; i += BATCH) {
    const rows = segments.slice(i, i + BATCH).map((s) => {
      const lats = s.coords.map((c) => c[0])
      const lngs = s.coords.map((c) => c[1])
      return `(${s.id},${sqlStr(cityId)},${s.wayId},${sqlStr(s.name)},${sqlStr(s.highway)},${sqlStr(s.kind)},${sqlStr(s.neighborhood)},${s.length.toFixed(1)},${s.foot},${s.bike},${Math.min(...lats)},${Math.min(...lngs)},${Math.max(...lats)},${Math.max(...lngs)},${sqlStr(encodePolyline(s.coords, 6))})`
    })
    lines.push(
      `INSERT INTO segments (id,city,way_id,name,highway,kind,neighborhood,length_m,foot,bike,min_lat,min_lng,max_lat,max_lng,coords) VALUES\n${rows.join(',\n')};`,
    )
  }
  const sqlPath = path.join(root, 'db/seed', `${cityId}-segments.sql`)
  await mkdir(path.dirname(sqlPath), { recursive: true })
  await writeFile(sqlPath, lines.join('\n') + '\n')

  const km = (sel: (s: Segment) => boolean) =>
    (segments.filter(sel).reduce((a, s) => a + s.length, 0) / 1000).toFixed(1)
  const streets = new Set(segments.filter((s) => s.kind === 'street' && s.name).map((s) => s.name)).size
  console.log(
    `${segments.length} segments · ${streets} named streets · foot ${km((s) => s.foot === 1)} km (streets ${km((s) => s.foot === 1 && s.kind === 'street')}, paths ${km((s) => s.foot === 1 && s.kind === 'path')}) · bike ${km((s) => s.bike === 1)} km`,
  )
  if (hoods.length) {
    const outside = segments.filter((s) => s.foot && !s.neighborhood).reduce((a, s) => a + s.length, 0)
    console.log(`${hoods.length} neighborhoods · ${(outside / 1000).toFixed(1)} km on foot outside every neighborhood`)
  }
  console.log(`Wrote ${path.relative(root, geoPath)} and ${path.relative(root, sqlPath)}`)
}

await main()
