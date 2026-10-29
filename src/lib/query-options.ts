import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import {
  getCoverage,
  getLeaderboardFn,
  getMe,
  getNeighborhoods,
  getProfileFn,
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

export const leaderboardQuery = (mode: Mode) =>
  queryOptions({
    queryKey: ['leaderboard', mode],
    queryFn: () => getLeaderboardFn({ data: { mode } }),
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

export const coverageQuery = (mode: Mode) =>
  queryOptions({
    queryKey: ['coverage', mode],
    queryFn: () => getCoverage({ data: { mode } }),
    staleTime: 60_000,
  })

export const neighborhoodsQuery = (mode: Mode) =>
  queryOptions({
    queryKey: ['neighborhoods', mode],
    queryFn: () => getNeighborhoods({ data: { mode } }),
    staleTime: 60_000,
  })

export const STREET_PAGE = 50

/** Streets ranked by progress, fetched a page at a time as the list scrolls. */
export type RankSort = 'progress' | 'activities'

export const streetsQuery = (mode: Mode, q: string, sort: RankSort = 'progress') =>
  infiniteQueryOptions({
    queryKey: ['streets', mode, q, sort],
    queryFn: ({ pageParam }) => getStreets({ data: { mode, q, offset: pageParam, limit: STREET_PAGE, sort } }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    staleTime: 60_000,
  })

export const streetDetailQuery = (mode: Mode, target: { name: string } | { segmentId: number }) =>
  queryOptions({
    queryKey: ['street', mode, target],
    queryFn: () => getStreet({ data: { mode, ...target } }),
    staleTime: 60_000,
  })

export const syncStatusQuery = () =>
  queryOptions({
    queryKey: ['sync-status'],
    queryFn: () => getSyncStatus(),
    staleTime: 15_000,
  })
