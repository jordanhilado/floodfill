import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import { syncNow } from '../server/functions'

const SYNC = ['sync']

/**
 * Imports Strava activities for the signed-in user. Each server call is a bounded batch; keep
 * going while the server stopped only for time, refreshing everything after each batch so the
 * map fills in live. Shared by the Settings button and the post-connect import.
 */
export function useSync() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: SYNC,
    mutationFn: async () => {
      let result
      do {
        result = await syncNow()
        await queryClient.invalidateQueries()
      } while (result.stopReason === 'time')
      return result
    },
  })
}

/** True while a sync started anywhere on the page is running. */
export const useIsSyncing = () => useIsMutating({ mutationKey: SYNC }) > 0
