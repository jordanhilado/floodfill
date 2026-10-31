export type Mode = 'foot' | 'bike'

const FOOT = new Set(['Run', 'TrailRun', 'Walk', 'Hike'])
const BIKE = new Set(['Ride', 'MountainBikeRide', 'GravelRide', 'EBikeRide', 'EMountainBikeRide'])

/** Which progress a Strava sport type counts toward, or null for one that isn't counted. */
export function modeFor(sportType: string): Mode | null {
  if (FOOT.has(sportType)) return 'foot'
  if (BIKE.has(sportType)) return 'bike'
  return null
}
