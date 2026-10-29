import { useInfiniteQuery, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Download, Loader2, Share, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CityId } from '../lib/cities'
import { savePref, type Prefs } from '../lib/prefs'
import { coverageQuery, meQuery, neighborhoodsQuery, streetsQuery, syncStatusQuery, type Mode } from '../lib/query-options'
import { renderShareImage, shareFileName, type ShareLayout, type ShareRankings } from '../lib/share-image'
import type { ResolvedTheme } from '../lib/theme'
import { Segmented } from './Segmented'

const LAYOUTS: { value: ShareLayout; label: string }[] = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
]

const RANKINGS: { value: ShareRankings; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'neighborhoods', label: 'Neighborhoods' },
  { value: 'streets', label: 'Paths' },
]

/** The prominent Share CTA plus the sheet that previews, shares and saves the progress graphic. */
export function ShareButton({
  city,
  mode,
  prefs,
  theme,
  className = '',
}: {
  city: CityId
  mode: Mode
  prefs: Prefs
  theme: ResolvedTheme
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 text-13 font-medium text-surface transition-opacity hover:opacity-90 ${className}`}
      >
        <Share size={14} strokeWidth={2} />
        Share
      </button>
      {open && <ShareSheet city={city} mode={mode} prefs={prefs} theme={theme} onClose={() => setOpen(false)} />}
    </>
  )
}

function ShareSheet({
  city,
  mode,
  prefs,
  theme,
  onClose,
}: {
  city: CityId
  mode: Mode
  prefs: Prefs
  theme: ResolvedTheme
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const router = useRouter()
  const { data: me } = useQuery(meQuery())
  const username = me?.username ?? null
  // Remembered like the other settings, so the next share starts the same way.
  const [layout, setLayout] = useState(prefs.shareLayout)
  const [rankings, setRankings] = useState(prefs.shareRankings)
  const choose = <K extends 'shareLayout' | 'shareRankings'>(key: K, value: Prefs[K], set: (v: Prefs[K]) => void) => {
    set(value)
    savePref(key, value)
    void router.invalidate()
  }
  const coverage = useSuspenseQuery(coverageQuery(mode))
  const hoods = useSuspenseQuery(neighborhoodsQuery(mode))
  const { data: status } = useQuery(syncStatusQuery())
  const activities = status?.activities[mode]
  // Most-visited streets: first page of the ranking sorted by activities.
  const streets = useInfiniteQuery(streetsQuery(mode, '', 'activities'))
  const topStreets = streets.data?.pages[0]?.rows.slice(0, 6)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  // Re-rendered only when what the picture shows changes.
  const image = useQuery({
    queryKey: ['share-image', layout, rankings, username, city, mode, prefs.unit, prefs.scheme, theme, coverage.dataUpdatedAt, hoods.dataUpdatedAt, activities, streets.dataUpdatedAt],
    enabled: topStreets !== undefined,
    staleTime: Infinity,
    gcTime: 60_000,
    queryFn: () =>
      renderShareImage({
        layout,
        rankings,
        username,
        city,
        mode,
        unit: prefs.unit,
        theme,
        scheme: prefs.scheme,
        percent: coverage.data.percent,
        completedMeters: coverage.data.completedMeters,
        totalMeters: coverage.data.totalMeters,
        streetsCompleted: coverage.data.streetsCompleted,
        totalStreets: coverage.data.totalStreets,
        activities,
        completedIds: coverage.data.completedIds,
        neighborhoods: hoods.data,
        streets: topStreets ?? [],
      }),
  })

  const url = useMemo(() => (image.data ? URL.createObjectURL(image.data) : null), [image.data])
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])

  const fileName = shareFileName(city)
  const file = image.data ? new File([image.data], fileName, { type: 'image/png' }) : null
  const canShare = file !== null && typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [file] })
  const [shareError, setShareError] = useState<string | null>(null)

  const share = async () => {
    if (!file) return
    setShareError(null)
    try {
      await navigator.share({ files: [file], title: 'My Floodfill progress' })
    } catch (err) {
      // Closing the share sheet is not an error.
      if ((err as Error).name !== 'AbortError') setShareError('Sharing failed. Try Save PNG instead.')
    }
  }
  const save = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
      aria-labelledby="share-title"
      className={`m-0 h-dvh max-h-none w-full max-w-none bg-canvas p-0 text-ink backdrop:bg-black/40 sm:m-auto sm:rounded-[16px] ${layout === 'portrait' ? 'sm:h-[min(820px,calc(100dvh-32px))] sm:w-[400px]' : 'sm:h-fit sm:w-[560px]'} sm:shadow-[0_0_0_1px_var(--color-line),0_16px_48px_rgba(0,0,0,0.24)]`}
    >
      <div className="flex h-full flex-col gap-3 p-4 pt-[max(16px,env(safe-area-inset-top))] pb-[max(16px,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between">
          <h2 id="share-title" className="text-14 font-medium">
            Share your progress
          </h2>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-[8px] text-ink-2 hover:bg-fill-strong hover:text-ink"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Preview (9:16 or 1.91:1), as large as the screen allows */}
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {url ? (
            <img
              src={url}
              alt={`Floodfill progress: ${coverage.data.percent.toFixed(1)}% of paths ${mode === 'foot' ? 'on foot' : 'by bike'}`}
              className={`${layout === 'portrait' ? 'aspect-[9/16]' : 'aspect-[40/21]'} max-h-full w-auto max-w-full rounded-[16px] shadow-[0_0_0_1px_var(--color-line),0_12px_32px_rgba(0,0,0,0.18)]`}
            />
          ) : (
            <div
              className={`flex max-w-full items-center ${layout === 'portrait' ? 'aspect-[9/16] h-full' : 'aspect-[40/21] w-full'} justify-center rounded-[16px] bg-fill text-13 text-ink-2`}
            >
              {image.isError ? (
                'Could not create the image.'
              ) : (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Drawing your map…
                </span>
              )}
            </div>
          )}
        </div>

        <div className="-mt-2">
          <fieldset>
            <legend className="sr-only">Layout</legend>
            <Segmented name="share-layout" options={LAYOUTS} value={layout} onChange={(v) => choose('shareLayout', v, setLayout)} />
          </fieldset>
          <fieldset>
            <legend className="sr-only">Rankings to show</legend>
            <Segmented
              name="share-rankings"
              options={RANKINGS}
              value={rankings}
              onChange={(v) => choose('shareRankings', v, setRankings)}
            />
          </fieldset>
        </div>

        {shareError && <p className="text-center text-12 text-[#C0392B]">{shareError}</p>}
        <div className="flex gap-2">
          {canShare && (
            <button
              type="button"
              onClick={share}
              className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-ink text-14 font-medium text-surface transition-opacity hover:opacity-90"
            >
              <Share size={14} strokeWidth={2} />
              Share
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!url}
            className={`flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full text-14 font-medium transition-opacity disabled:opacity-40 ${
              canShare ? 'bg-fill-strong text-ink hover:opacity-80' : 'bg-ink text-surface hover:opacity-90'
            }`}
          >
            <Download size={14} strokeWidth={2} />
            Save PNG
          </button>
        </div>
      </div>
    </dialog>
  )
}
