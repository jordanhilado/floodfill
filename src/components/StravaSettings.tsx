import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { syncStatusQuery } from '../lib/query-options'
import { useIsSyncing, useSync } from '../lib/use-sync'
import { startStravaConnect } from '../server/functions'
import { StravaFull } from './StravaImport'

const num = (n: number) => n.toLocaleString('en-US')
const time = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/** Starts Strava OAuth; the callback brings the person back to the map. */
export function useConnectStrava() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const { url } = await startStravaConnect()
      window.location.assign(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach Strava.')
      setBusy(false)
    }
  }
  return { connect, busy, error }
}

export function ConnectStravaButton({ className = '' }: { className?: string }) {
  const { connect, busy, error } = useConnectStrava()
  return (
    <>
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className={`flex h-9 items-center justify-center gap-1.5 rounded-full bg-[#FC4C02] px-4 text-13 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60 ${className}`}
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        Connect with Strava
      </button>
      {error && <p className="mt-2 text-12 text-[#C0392B]">{error}</p>}
    </>
  )
}

/** Strava connection, import status, API budget and the Sync button (lives in Settings). */
export function StravaSettings() {
  const sync = useSync()
  const syncing = useIsSyncing()
  const { data: status } = useQuery({ ...syncStatusQuery(), refetchInterval: syncing ? 3000 : false })
  if (!status) return null

  if (!status.configured) {
    return (
      <p className="text-12 text-ink-2">
        Add <code>STRAVA_CLIENT_ID</code> and <code>STRAVA_CLIENT_SECRET</code> to <code>.dev.vars</code>, then restart the
        dev server.
      </p>
    )
  }
  if (!status.connected) {
    const a = status.activities
    return (
      <div>
        {a.total > 0 && (
          <p className="mb-3 text-12 tabular-nums text-ink-2">
            {num(a.total)} imported {a.total === 1 ? 'activity' : 'activities'} · {num(a.counted)} in Floodfill cities
          </p>
        )}
        {status.stravaFull ? (
          <StravaFull />
        ) : (
          <>
            <p className="text-12 text-ink-2">Connect Strava to import your runs, walks, hikes and rides.</p>
            <ConnectStravaButton className="mt-3 w-full" />
          </>
        )}
      </div>
    )
  }

  const last = sync.data ?? (status.lastRun ? { stopReason: status.lastRun.stop_reason, error: status.lastRun.error } : null)
  // Re-matching stored tracks after a network rebuild needs no API budget.
  const rateLimited =
    !status.rematchPending &&
    (status.rate.read15 >= status.rate.budget.read15 || status.rate.readDay >= status.rate.budget.readDay)
  const resumeAt = status.rate.readDay >= status.rate.budget.readDay ? status.rate.dayResetAt : status.rate.windowResetAt
  const a = status.activities

  let headline: string
  if (syncing) headline = 'Syncing…'
  else if (status.rematchPending) headline = 'Map data updated'
  else if (a.total === 0) headline = 'Ready to import'
  else if (!status.backfillDone || a.awaitingDetail > 0) headline = 'Import in progress'
  else headline = 'Up to date'

  return (
    <div>
      <p className="flex items-center gap-1.5 text-13 text-ink">
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${last?.stopReason === 'error' ? 'bg-[#C0392B]' : syncing ? 'bg-done' : 'bg-[#2E9E5B]'}`}
        />
        {headline}
      </p>
      <p className="mt-1 text-12 tabular-nums text-ink-2">
        {num(a.total)} activities · {num(a.counted)} in the city · {num(a.detailed)} with full GPS
      </p>
      {status.rematchPending && !syncing && (
        <p className="mt-2 text-12 text-ink-2">
          Matching your activities against the new streets and paths. This uses no Strava requests.
        </p>
      )}
      {a.awaitingDetail > 0 && (
        <p className="mt-2 text-12 text-ink-2">
          {num(a.awaitingDetail)} {a.awaitingDetail === 1 ? 'activity is' : 'activities are'} matched from the simplified
          route; full GPS tracks load as the rate limit allows.
        </p>
      )}
      {last?.stopReason === 'error' && last.error && <p className="mt-2 text-12 text-[#C0392B]">{last.error}</p>}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-12 tabular-nums text-ink-2">
          API {num(status.rate.read15)}/{num(status.rate.budget.read15)} this window
          <br />
          {num(status.rate.readDay)}/{num(status.rate.budget.readDay)} today
        </p>
        <button
          type="button"
          onClick={() => sync.mutate()}
          disabled={syncing || rateLimited}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-ink px-4 text-13 font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} strokeWidth={2} />}
          {syncing ? 'Syncing' : rateLimited ? `Resumes ${time(resumeAt)}` : 'Sync now'}
        </button>
      </div>
    </div>
  )
}
