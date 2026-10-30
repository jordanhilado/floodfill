import { OSM_STREETS, type Credit } from './credits.ts'

export type CityId = 'sf'

export type City = {
  id: CityId
  name: string
  state: string
  /** OSM relation for the administrative boundary. */
  osmRelationId: number
  center: [number, number] // [lng, lat]
  zoom: number
  /** [[minLng, minLat], [maxLng, maxLat]] around the city limits */
  bounds: [[number, number], [number, number]]
  /**
   * The city's segment ids run from idBase + 1 to idBase + ID_SPAN. Segment ids are unique
   * across every city, so each city gets its own range.
   */
  idBase: number
  /** Official neighborhood polygons (GeoJSON) and the property holding the name. */
  neighborhoods?: { source: string; url: string; nameKey: string }
  /** Sources of this city's data, shown in the credits popover. */
  credits: Credit[]
}

export const ID_SPAN = 10_000_000

// Adding a city: add an entry here with the next free idBase, run `pnpm streets <id>`, and seed
// D1 (see CONTRIBUTING.md).
export const CITIES: Record<CityId, City> = {
  sf: {
    id: 'sf',
    name: 'San Francisco',
    state: 'CA',
    osmRelationId: 111968,
    center: [-122.4376, 37.7577],
    zoom: 12.2,
    bounds: [
      [-122.5155, 37.7034],
      [-122.357, 37.8337],
    ],
    idBase: 0,
    neighborhoods: {
      source: 'DataSF Analysis Neighborhoods',
      url: 'https://data.sf.gov/resource/j2bu-swwd.geojson?$limit=500',
      nameKey: 'nhood',
    },
    credits: [
      OSM_STREETS,
      {
        what: 'Neighborhood boundaries',
        source: 'DataSF, Analysis Neighborhoods',
        url: 'https://data.sf.gov/d/p5b7-5n3h',
        license: { name: 'PDDL', url: 'https://opendatacommons.org/licenses/pddl/1-0/' },
      },
    ],
  },
}

export const DEFAULT_CITY: CityId = 'sf'

export const CITY_IDS = Object.keys(CITIES) as [CityId, ...CityId[]]

/**
 * The city an activity counts toward: the one whose bounds hold the most of its track
 * ([lat, lng] points). A simplified track can cross a city without a point inside it, so
 * failing that, the first city whose bounds its bounding box overlaps. Null when it misses
 * every city.
 */
export function cityForTrack(track: [number, number][]): CityId | null {
  if (track.length === 0) return null
  let best: CityId | null = null
  let bestCount = 0
  let minLat = Infinity
  let minLng = Infinity
  let maxLat = -Infinity
  let maxLng = -Infinity
  for (const [lat, lng] of track) {
    minLat = Math.min(minLat, lat)
    minLng = Math.min(minLng, lng)
    maxLat = Math.max(maxLat, lat)
    maxLng = Math.max(maxLng, lng)
  }
  let overlapping: CityId | null = null
  for (const id of CITY_IDS) {
    const [[x0, y0], [x1, y1]] = CITIES[id].bounds
    if (minLat > y1 || maxLat < y0 || minLng > x1 || maxLng < x0) continue
    overlapping ??= id
    let count = 0
    for (const [lat, lng] of track) if (lat >= y0 && lat <= y1 && lng >= x0 && lng <= x1) count++
    if (count > bestCount) [best, bestCount] = [id, count]
  }
  return best ?? overlapping
}

/** The largest US cities by population (US Census Bureau 2023 estimates). Shown as coming soon until enabled. */
export const UPCOMING_CITIES: { name: string; state: string }[] = [
  { name: 'New York', state: 'NY' },
  { name: 'Los Angeles', state: 'CA' },
  { name: 'Chicago', state: 'IL' },
  { name: 'Houston', state: 'TX' },
  { name: 'Phoenix', state: 'AZ' },
  { name: 'Philadelphia', state: 'PA' },
  { name: 'San Antonio', state: 'TX' },
  { name: 'San Diego', state: 'CA' },
  { name: 'Dallas', state: 'TX' },
  { name: 'Jacksonville', state: 'FL' },
]
