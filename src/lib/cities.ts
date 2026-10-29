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
  /** [[minLng, minLat], [maxLng, maxLat]] — mainland + Treasure Island */
  bounds: [[number, number], [number, number]]
  /** Official neighborhood polygons (GeoJSON) and the property holding the name. */
  neighborhoods?: { source: string; url: string; nameKey: string }
  /** Sources of this city's data, shown in the credits popover. */
  credits: Credit[]
}

// Only San Francisco is enabled for now. Adding a city = add an entry here,
// run `pnpm streets <id>`, and seed D1.
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

/** The ten largest US cities by population (US Census Bureau 2023 estimates). Not available yet. */
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
