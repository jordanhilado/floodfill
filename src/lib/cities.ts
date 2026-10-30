import { OSM_STREETS, type Credit } from './credits.ts'

export type CityId = 'sf' | 'la' | 'nyc' | 'seattle'

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
  la: {
    id: 'la',
    name: 'Los Angeles',
    state: 'CA',
    osmRelationId: 207359,
    center: [-118.4117, 34.0207],
    zoom: 10,
    bounds: [
      [-118.6682, 33.7037],
      [-118.1553, 34.3373],
    ],
    idBase: 10_000_000,
    neighborhoods: {
      source: 'Los Angeles Times Mapping L.A.',
      url: 'https://services5.arcgis.com/7nsPwEMP38bSkCjy/arcgis/rest/services/LA_Times_Neighborhoods/FeatureServer/0/query?where=1%3D1&outFields=name&outSR=4326&f=geojson',
      nameKey: 'name',
    },
    credits: [
      OSM_STREETS,
      {
        what: 'Neighborhood boundaries',
        source: 'Los Angeles Times, Mapping L.A., via City of Los Angeles GeoHub',
        url: 'https://geohub.lacity.org/datasets/d6c55385a0e749519f238b77135eafac',
        license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
      },
    ],
  },
  nyc: {
    id: 'nyc',
    name: 'New York',
    state: 'NY',
    osmRelationId: 175905,
    center: [-73.9442, 40.6971],
    zoom: 10.3,
    bounds: [
      [-74.2588, 40.4766],
      [-73.7002, 40.9176],
    ],
    idBase: 20_000_000,
    neighborhoods: {
      source: 'NYC Department of City Planning 2020 Neighborhood Tabulation Areas',
      url: 'https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$select=ntaname,the_geom&$limit=5000',
      nameKey: 'ntaname',
    },
    credits: [
      OSM_STREETS,
      {
        what: 'Neighborhood boundaries',
        source: 'NYC Department of City Planning, 2020 Neighborhood Tabulation Areas, via NYC Open Data',
        url: 'https://data.cityofnewyork.us/City-Government/2020-Neighborhood-Tabulation-Areas-NTAs-/9nt8-h7nd',
      },
    ],
  },
  seattle: {
    id: 'seattle',
    name: 'Seattle',
    state: 'WA',
    osmRelationId: 237385,
    center: [-122.335, 47.6076],
    zoom: 11.3,
    bounds: [
      [-122.4597, 47.481],
      [-122.2244, 47.7342],
    ],
    idBase: 30_000_000,
    neighborhoods: {
      source: 'City of Seattle Neighborhood Map Atlas',
      url: 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/nma_nhoods_sub/FeatureServer/0/query?where=1%3D1&outFields=S_HOOD&outSR=4326&f=geojson',
      nameKey: 'S_HOOD',
    },
    credits: [
      OSM_STREETS,
      {
        what: 'Neighborhood boundaries',
        source: 'City of Seattle, Neighborhood Map Atlas',
        url: 'https://data-seattlecitygis.opendata.arcgis.com/datasets/b4a142f592e94d39a3bf787f3c112c1d',
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
