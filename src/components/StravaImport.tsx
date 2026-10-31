import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { importStravaExport, type ImportProgress } from '../lib/strava-export'
import { importStravaBatch, joinStravaWaitlist } from '../server/functions'

const num = (n: number) => n.toLocaleString('en-US')

// The page can show the explanation in more than one place; join the waitlist once.
let joinedWaitlist = false

/**
 * Shown to signed-in people without Strava connected while the app is at Strava's limit on
 * connected athletes: what happened, and how to import a Strava export instead. `compact` (the
 * progress card, which phones show over the map) folds the details away.
 */
export function StravaFull({ compact = false }: { compact?: boolean }) {
  // Seeing this puts you on the list to email when connections open.
  useEffect(() => {
    if (joinedWaitlist) return
    joinedWaitlist = true
    joinStravaWaitlist().catch(() => {
      joinedWaitlist = false
    })
  }, [])
  const details = (
    <>
      <p className="mt-1 text-12 text-ink-2">
        Strava limits how many people can connect to a new app, and Floodfill has reached that limit. We've applied to
        Strava to raise it, and we'll email you as soon as you can connect. Until then, you can import your activities
        from a Strava export.
      </p>
      <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-12 text-ink-2">
        <li>
          On Strava.com, go to <span className="text-ink">Settings → My Account → Download your account</span> and select{' '}
          <span className="text-ink">Get Started</span>.
        </li>
        <li>Strava emails you a link to a zip file of your account. Download it.</li>
        <li>Upload the zip here as it is. Only your activities' GPS tracks are read.</li>
      </ol>
    </>
  )
  return (
    <div>
      <p className="text-13 font-medium text-ink">Strava connections are full for now</p>
      {compact ? (
        <>
          <p className="mt-1 text-12 text-ink-2">
            Import your Strava export to fill in the map. We'll email you when you can connect.
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-12 text-ink underline decoration-line underline-offset-2 hover:decoration-ink">
              Why, and how to get your export
            </summary>
            {details}
          </details>
        </>
      ) : (
        details
      )}
      <StravaImport />
    </div>
  )
}

/** Reads a Strava export zip in the browser and uploads its activities in batches. */
export function StravaImport() {
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (file: File) => {
    setBusy(true)
    setError(null)
    setProgress(null)
    try {
      await importStravaExport(
        file,
        async (activities) => {
          const { added } = await importStravaBatch({ data: { activities } })
          // Fill the map in as batches land.
          void queryClient.invalidateQueries()
          return added
        },
        setProgress,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't import that file.")
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries()
    }
  }

  return (
    <div className="mt-3">
      <label
        className={`flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-13 font-medium text-surface transition-opacity hover:opacity-90 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-done ${
          busy ? 'pointer-events-none opacity-60' : ''
        }`}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} strokeWidth={2} />}
        {busy ? 'Importing' : 'Upload Strava export'}
        <input
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void run(file)
          }}
        />
      </label>
      {progress && (
        <p className="mt-2 text-12 tabular-nums text-ink-2" role="status">
          {busy
            ? `Reading ${num(progress.read)} of ${num(progress.total)} runs, walks, hikes and rides…`
            : `Imported ${num(progress.added)} new ${progress.added === 1 ? 'activity' : 'activities'}.`}
          {progress.noGps > 0 && ` ${num(progress.noGps)} without GPS skipped.`}
        </p>
      )}
      {error && <p className="mt-2 text-12 text-[#C0392B]">{error}</p>}
    </div>
  )
}
