import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { rematchNow, syncNow } from '../server/functions'

const SYNC = ['sync']
const REMATCH = ['rematch']
/** How long to wait while another sync or rematch holds the lock. */
const BUSY_RETRY_MS = 10_000

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

/**
 * Re-matches stored activities while `pending` (a city just opened or its streets were rebuilt),
 * so everyone's progress there shows without waiting for the cron or pressing Sync. Batches
 * refresh the map as they land. When another run holds the lock it is doing the same work: wait
 * for it, then refresh.
 */
export function useRematch(pending: boolean) {
  const queryClient = useQueryClient()
  const { mutate, isIdle } = useMutation({
    mutationKey: REMATCH,
    mutationFn: async () => {
      for (;;) {
        const result = await rematchNow()
        if (result.stopReason === 'busy') {
          await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS))
          continue
        }
        await queryClient.invalidateQueries()
        if (result.stopReason === 'complete') return result
      }
    },
  })
  useEffect(() => {
    if (pending && isIdle) mutate()
  }, [pending, isIdle, mutate])
}
