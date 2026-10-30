/**
 * Regenerates src/lib/totals.<city>.json from the existing seed, without fetching from Overpass.
 * scripts/build-streets.ts does this too after writing a new seed.
 *
 *   node scripts/build-totals.ts [cityId]
 */
import { CITIES, type CityId } from '../src/lib/cities.ts'
import { writeTotals } from './totals.ts'

const cityId = (process.argv[2] ?? 'sf') as CityId
if (!CITIES[cityId]) throw new Error(`Unknown city ${cityId}`)
console.log(`Wrote ${await writeTotals(cityId)}`)
