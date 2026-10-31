export type Credit = {
  /** What the source provides, in the app's terms. */
  what: string
  source: string
  url: string
  license?: { name: string; url: string }
}

const ODBL = { name: 'ODbL', url: 'https://opendatacommons.org/licenses/odbl/' }

export const OSM_STREETS: Credit = {
  what: 'Paths',
  source: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright',
  license: ODBL,
}

/** The basemap and renderer, shared by every city. */
export const MAP_CREDITS: Credit[] = [
  { what: 'Basemap tiles', source: 'OpenFreeMap', url: 'https://openfreemap.org' },
  { what: 'Basemap schema', source: '© OpenMapTiles', url: 'https://www.openmaptiles.org/' },
  {
    what: 'Basemap data',
    source: '© OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
    license: ODBL,
  },
  { what: 'Map rendering', source: 'MapLibre GL JS', url: 'https://maplibre.org' },
]

export const ACTIVITY_CREDITS: Credit[] = [{ what: 'Activities', source: 'Powered by Strava', url: 'https://www.strava.com' }]
