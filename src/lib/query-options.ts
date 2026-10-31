import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { CityId } from './cities'
import {
  getCoverage,
  getLeaderboardFn,
  getMe,
  getNeighborhoods,
  getProfileFn,
  getProfileMapsFn,
  getStandings,
  getStreet,
  getStreets,
  getSyncStatus,
} from '../server/functions'

export type Mode = 'foot' | 'bike'

/** The signed-in user, or null. Everything else on the page depends on who this is. */
export const meQuery = () =>
  queryOptions({
    queryKey: ['me'],
    queryFn: () => getMe(),
    staleTime: 5 * 60_000,
  })

export const leaderboardQuery = (city: CityId, mode: Mode) =>
  queryOptions({
    queryKey: ['leaderboard', city, mode],
    queryFn: () => getLeaderboardFn({ data: { city, mode } }),
    staleTime: 60_000,
  })

export const standingsQuery = (mode: Mode) =>
  queryOptions({
    queryKey: ['standings', mode],
    queryFn: () => getStandings({ data: { mode } }),
    staleTime: 60_000,
  })

/** Anyone's profile by username (case-insensitive), or null when no one uses it. */
export const profileQuery = (username: string) =>
  queryOptions({
    queryKey: ['profile', username.toLowerCase()],
    queryFn: () => getProfileFn({ data: { username } }),
    staleTime: 60_000,
  })

/** Someone's completed paths in each city, drawn small for their profile. */
export const profileMapsQuery = (username: string, mode: Mode) =>
  queryOptions({
    queryKey: ['profile-maps', username.toLowerCase(), mode],
    queryFn: () => getProfileMapsFn({ data: { username, mode } }),
    staleTime: 60_000,
  })

export const coverageQuery = (city: CityId, mode: Mode) =>
  queryOptions({
    queryKey: ['coverage', city, mode],
    queryFn: () => getCoverage({ data: { city, mode } }),
    staleTime: 60_000,
  })

export const neighborhoodsQuery = (city: CityId, mode: Mode) =>
  queryOptions({
    queryKey: ['neighborhoods', city, mode],
    queryFn: () => getNeighborhoods({ data: { city, mode } }),
    staleTime: 60_000,
  })

export const STREET_PAGE = 50

/** Streets ranked by progress, fetched a page at a time as the list scrolls. */
export type RankSort = 'progress' | 'activities'

export const streetsQuery = (city: CityId, mode: Mode, q: string, sort: RankSort = 'progress') =>
  infiniteQueryOptions({
    queryKey: ['streets', city, mode, q, sort],
    queryFn: ({ pageParam }) => getStreets({ data: { city, mode, q, offset: pageParam, limit: STREET_PAGE, sort } }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    staleTime: 60_000,
  })

export const streetDetailQuery = (city: CityId, mode: Mode, target: { name: string } | { segmentId: number }) =>
  queryOptions({
    queryKey: ['street', city, mode, target],
    queryFn: () => getStreet({ data: { city, mode, ...target } }),
    staleTime: 60_000,
  })

export const syncStatusQuery = () =>
  queryOptions({
    queryKey: ['sync-status'],
    queryFn: () => getSyncStatus(),
    staleTime: 15_000,
  })
