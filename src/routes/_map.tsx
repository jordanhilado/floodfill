import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { ClientOnly, createFileRoute, Outlet, stripSearchParams } from '@tanstack/react-router'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { AuthDialog, type AuthStep } from '../components/AuthDialog'
import { LeaderboardCard } from '../components/LeaderboardCard'
import { NeighborhoodCard } from '../components/NeighborhoodCard'
import { RankingsCard } from '../components/RankingsCard'
import { GetStartedButton, GetStartedCard, NavBar, ProgressCard } from '../components/Panels'
import { ShareButton } from '../components/ShareButton'
import { Sheet } from '../components/Sheet'
import { StreetCard } from '../components/StreetCard'
import { CITIES, CITY_IDS, DEFAULT_CITY } from '../lib/cities'
import { coverageQuery, meQuery, neighborhoodsQuery, syncStatusQuery } from '../lib/query-options'
import { streetFileUrls, streetIds, streetIndexQuery, streetProgress } from '../lib/street-index'
import { useResolvedTheme } from '../lib/use-resolved-theme'
import { useIsSyncing, useSync } from '../lib/use-sync'

const NO_IDS: number[] = []

/** A street chosen from the list (by name, framed on the map) or tapped on the map (a segment). */
type StreetSelection = { name: string; bbox?: [number, number, number, number] } | { segmentId: number }

const StreetMap = lazy(() => import('../components/StreetMap'))

const search = z.object({
  /** San Francisco when absent. */
  city: z.enum(CITY_IDS).optional().catch(undefined),
  mode: z.enum(['foot', 'bike']).catch('foot'),
  /** Selected neighborhood, by its name in the city's official boundaries. */
  hood: z.string().optional().catch(undefined),
  /** Set by the Strava OAuth callback (routes/api/strava/callback.ts); cleared once shown. */
  strava: z.string().optional().catch(undefined),
})

const STRAVA_NOTICES: Record<string, string> = {
  connected: 'Strava connected. Importing your activities…',
  denied: "Strava access wasn't granted. You can connect any time from Settings.",
  scope: 'Floodfill needs permission to view your activities. Connect again and keep that box checked.',
  taken: 'That Strava account is already connected to another Floodfill account.',
  signin: 'Sign in again, then connect Strava.',
  error: "Couldn't connect Strava. Try again from Settings.",
}

export const Route = createFileRoute('/_map')({
  validateSearch: search,
  // The default city and by foot stay out of the URL.
  search: { middlewares: [stripSearchParams({ city: DEFAULT_CITY, mode: 'foot' })] },
  loaderDeps: ({ search }) => ({ city: search.city ?? DEFAULT_CITY, mode: search.mode }),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(meQuery()),
      context.queryClient.ensureQueryData(coverageQuery(deps.city, deps.mode)),
      context.queryClient.ensureQueryData(syncStatusQuery()),
      context.queryClient.ensureQueryData(neighborhoodsQuery(deps.city, deps.mode)),
    ]),
  head: ({ match }) => {
    const city = match.search.city ?? DEFAULT_CITY
    const { name } = CITIES[city]
    return {
      meta: [
        { title: `Floodfill · ${name} street coverage` },
        { name: 'description', content: `How much of ${name} you have covered, from your Strava activities.` },
      ],
      // Start the street network download before the map bundle loads.
      links: streetFileUrls(city).map((href) => ({ rel: 'preload', href, as: 'fetch', crossOrigin: 'anonymous' as const })),
    }
  },
  component: Home,
})

function Home() {
  const search = Route.useSearch()
  const { mode, hood, strava } = search
  const city = search.city ?? DEFAULT_CITY
  const { prefs } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: me } = useSuspenseQuery(meQuery())

  // Get started / sign-in flow. Someone signed in without a username goes straight to that step.
  const [auth, setAuth] = useState<AuthStep | null>(null)
  useEffect(() => {
    if (me && !me.username) setAuth('username')
  }, [me])
  const getStarted = () => setAuth('identify')

  // Back from Strava: say how it went, and start the first import after a successful connect.
  const sync = useSync()
  const syncing = useIsSyncing()
  const [notice, setNotice] = useState<string | null>(null)
  const handled = useRef(false)
  useEffect(() => {
    if (!strava || handled.current) return
    handled.current = true
    setNotice(STRAVA_NOTICES[strava] ?? STRAVA_NOTICES.error)
    if (strava === 'connected') sync.mutate()
    void navigate({ to: '/', search: (prev) => ({ ...prev, mode: prev.mode ?? 'foot', strava: undefined }), replace: true })
  }, [strava, navigate, sync])
  // The "importing" notice goes away once the first import finishes.
  useEffect(() => {
    if (notice === STRAVA_NOTICES.connected && sync.isSuccess) setNotice(null)
  }, [notice, sync.isSuccess])
  const { data: coverage } = useSuspenseQuery(coverageQuery(city, mode))
  const { data: hoods } = useSuspenseQuery(neighborhoodsQuery(city, mode))
  const selected = hoods.some((h) => h.name === hood) ? hood : undefined
  const theme = useResolvedTheme(prefs.theme)

  // Selected street: the index expands a name or a tapped segment to all of the street's segments.
  const { data: streetIndex } = useQuery(streetIndexQuery(city))
  const [street, setStreet] = useState<StreetSelection | null>(null)
  // A street belongs to one city.
  useEffect(() => setStreet(null), [city])
  const selectedStreetIds = useMemo(() => {
    if (!streetIndex || !street) return NO_IDS
    return 'name' in street ? (streetIndex.byName.get(street.name) ?? NO_IDS) : streetIds(streetIndex, street.segmentId)
  }, [streetIndex, street])
  const selectedStreetName =
    street && 'name' in street ? street.name : street && streetIndex ? (streetIndex.byId.get(street.segmentId)?.name ?? null) : null
  const pickStreet = (segmentId: number | null) => {
    const name = segmentId !== null ? streetIndex?.byId.get(segmentId)?.name : null
    setStreet(segmentId === null ? null : name ? { name } : { segmentId })
  }
  // Only list picks move the camera; a tap on the map is already in view.
  const streetFocus = street && 'bbox' in street && street.bbox ? { key: street.name, bbox: street.bbox } : null
  const completed = useMemo(() => new Set(coverage.completedIds), [coverage.completedIds])
  const streetPercent = (segmentId: number) =>
    streetIndex ? streetProgress(streetIndex, streetIds(streetIndex, segmentId), completed, mode).percent : null
  // The selected neighborhood's card, ranked by progress like the list.
  const hoodRank = hoods.findIndex((h) => h.name === selected)
  const selectedHood = hoodRank >= 0 ? hoods[hoodRank] : null
  const clearHood = () =>
    navigate({ to: '/', search: (prev) => ({ ...prev, mode: prev.mode ?? 'foot', hood: undefined }), replace: true })
  // Escape closes the top card: the street first, then the neighborhood.
  const escape = useRef(() => {})
  escape.current = () => (street ? setStreet(null) : selected && void clearHood())
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && escape.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Warm the other mode so switching is instant.
  useEffect(() => {
    const other = mode === 'foot' ? 'bike' : 'foot'
    void queryClient.prefetchQuery(coverageQuery(city, other))
    void queryClient.prefetchQuery(neighborhoodsQuery(city, other))
  }, [city, mode, queryClient])

  const noticeBanner = notice && (
    <div role="status" className="surface flex items-center gap-2 rounded-[8px] px-3 py-2 text-13 text-ink">
      {syncing && notice === STRAVA_NOTICES.connected && <Loader2 size={14} className="shrink-0 animate-spin text-ink-2" />}
      <span className="min-w-0 flex-1">{notice}</span>
      <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 text-ink-2 hover:text-ink">
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      <ClientOnly>
        <Suspense>
          {/* A fresh map per city: its layers and state all belong to one city's streets. */}
          <StreetMap
            key={city}
            city={city}
            mode={mode}
            completedIds={coverage.completedIds}
            selectedNeighborhood={selected}
            selectedStreetIds={selectedStreetIds}
            onPickStreet={pickStreet}
            streetFocus={streetFocus}
            streetPercent={streetPercent}
            theme={theme}
            scheme={prefs.scheme}
          />
        </Suspense>
      </ClientOnly>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-4 sm:w-[380px]">
        <div className="pointer-events-auto">
          <NavBar city={city} mode={mode} prefs={prefs} theme={theme} me={me} onGetStarted={getStarted} />
        </div>
        {/* Phones: under the nav, above the map. Desktop shows it at the top of the card column. */}
        {notice && <div className="pointer-events-auto sm:hidden">{noticeBanner}</div>}
      </div>
      <div className="pointer-events-none absolute right-0 top-0 hidden p-4 sm:block">
        <div className="pointer-events-auto">
          {me ? (
            <ShareButton
              city={city}
              mode={mode}
              prefs={prefs}
              theme={theme}
              className="h-11 px-5 text-14 shadow-[0_8px_24px_rgba(0,0,0,0.18)]"
            />
          ) : (
            <GetStartedButton onClick={getStarted} className="h-11 px-5 text-14 shadow-[0_8px_24px_rgba(0,0,0,0.18)]" />
          )}
        </div>
      </div>
      {(selectedHood || (streetIndex && selectedStreetIds.length > 0)) && (
        <div
          data-street-card
          className="pointer-events-none absolute inset-x-0 top-[60px] flex flex-col gap-2 p-4 pt-0 sm:inset-x-auto sm:right-0 sm:w-[340px] [&>*]:pointer-events-auto"
        >
          {selectedHood && (
            <NeighborhoodCard
              neighborhood={selectedHood}
              rank={hoodRank + 1}
              of={hoods.length}
              mode={mode}
              unit={prefs.unit}
              onClose={clearHood}
            />
          )}
          {streetIndex && selectedStreetIds.length > 0 && (
            <StreetCard
              city={city}
              index={streetIndex}
              ids={selectedStreetIds}
              target={street && 'segmentId' in street && !selectedStreetName ? { segmentId: street.segmentId } : { name: selectedStreetName ?? '' }}
              completed={completed}
              mode={mode}
              unit={prefs.unit}
              onClose={() => setStreet(null)}
            />
          )}
        </div>
      )}
      {/* Desktop: floating bottom-left. Phones show it at the end of the sheet instead. */}
      <p className="surface absolute bottom-4 left-4 hidden rounded-[8px] px-2 py-1 text-12 text-ink-2 sm:block">
        <Credit />
      </p>
      <Sheet
        header={
          <>
            {notice && <div className="hidden sm:block">{noticeBanner}</div>}
            {me ? (
              <ProgressCard city={city} mode={mode} unit={prefs.unit} stravaConnected={me.stravaConnected} />
            ) : (
              <GetStartedCard city={city} onGetStarted={getStarted} />
            )}
          </>
        }
      >
        {me && (
          <RankingsCard
            city={city}
            mode={mode}
            neighborhoods={hoods}
            selectedNeighborhood={selected}
            selectedStreet={selectedStreetName}
            onSelectStreet={(row) => setStreet(row ? { name: row.name, bbox: row.bbox } : null)}
          />
        )}
        <LeaderboardCard city={city} mode={mode} unit={prefs.unit} signedIn={me !== null} onGetStarted={getStarted} />
        <p className="border-t border-line px-4 py-3 text-12 text-ink-2 sm:hidden">
          <Credit />
        </p>
      </Sheet>
      <AuthDialog open={auth !== null} onClose={() => setAuth(null)} start={auth ?? 'identify'} />
      <Outlet />
    </main>
  )
}

function Credit() {
  return (
    <>
      Built in SF by{' '}
      <a
        href="https://jordanhilado.com"
        target="_blank"
        rel="noreferrer"
        className="text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
      >
        Jordan Hilado
      </a>
    </>
  )
}
