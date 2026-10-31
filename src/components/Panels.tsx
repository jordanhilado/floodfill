import { useSuspenseQuery } from '@tanstack/react-query'
import { Bike, Footprints, Info, MapPin, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { DOMAIN } from '../lib/brand'
import { CITIES, type CityId } from '../lib/cities'
import { formatDistance, formatPercent, type Prefs, type Unit } from '../lib/prefs'
import { coverageQuery, type Mode } from '../lib/query-options'
import { SCHEMES, type ResolvedTheme, type Scheme } from '../lib/theme'
import { CityDialog } from './CityDialog'
import { InfoDialog } from './InfoDialog'
import { SettingsDialog } from './SettingsDialog'
import { ShareButton } from './ShareButton'
import { StravaFull } from './StravaImport'
import { ConnectStravaButton } from './StravaSettings'

const num = (n: number) => n.toLocaleString('en-US')

type Me = { username: string | null; email: string; stravaConnected: boolean; xUsername: string | null; showStrava: boolean } | null

export function NavBar({
  city,
  mode,
  prefs,
  theme,
  me,
  onGetStarted,
}: {
  city: CityId
  mode: Mode
  prefs: Prefs
  theme: ResolvedTheme
  me: Me
  onGetStarted: () => void
}) {
  const [open, setOpen] = useState<'settings' | 'info' | 'city' | null>(null)
  const close = () => setOpen(null)
  const iconButton = 'flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-2 transition-colors hover:bg-fill-strong hover:text-ink'
  return (
    <nav className="surface flex h-11 items-center gap-2 rounded-[8px] pl-2 pr-1.5">
      <div className="flex shrink-0 items-center gap-2">
        {/* Both tiles render; styles.css shows the one for the current theme. */}
        <img src="/favicon-light.png" alt="" width={28} height={28} className="logo-light size-7" />
        <img src="/favicon-dark.png" alt="" width={28} height={28} className="logo-dark size-7" />
        {/* Narrow phones keep just the mark so the city name fits beside Share */}
        <span className="text-16 font-medium max-[463px]:sr-only">{DOMAIN}</span>
      </div>
      <span className="h-4 w-px shrink-0 bg-line" />
      <button
        type="button"
        onClick={() => setOpen('city')}
        aria-haspopup="dialog"
        aria-label={`City: ${CITIES[city].name}, ${CITIES[city].state}. Change city`}
        className="-ml-1 flex h-8 min-w-0 items-center gap-1 rounded-[8px] px-1 text-13 text-ink-2 transition-colors hover:bg-fill-strong hover:text-ink"
      >
        {/* Desktop shows the domain beside it, so it drops the pin to fit "San Francisco, CA". */}
        <MapPin size={14} strokeWidth={1.75} className="shrink-0 sm:hidden" />
        <span className="truncate">
          {CITIES[city].name}, {CITIES[city].state}
        </span>
      </button>
      <div className="ml-auto flex shrink-0 items-center">
        {/* Phones: the main call to action lives in the nav's top-right corner; desktop floats it on the map. */}
        {me ? (
          <ShareButton city={city} mode={mode} prefs={prefs} theme={theme} className="mr-1 sm:hidden" />
        ) : (
          <GetStartedButton onClick={onGetStarted} className="mr-1 sm:hidden" />
        )}
        <button type="button" onClick={() => setOpen('info')} aria-haspopup="dialog" aria-label="About and data credits" className={iconButton}>
          <Info size={14} strokeWidth={1.75} />
        </button>
        <button type="button" onClick={() => setOpen('settings')} aria-haspopup="dialog" aria-label="Settings" className={iconButton}>
          <Settings2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      <CityDialog open={open === 'city'} onClose={close} city={city} />
      <InfoDialog open={open === 'info'} onClose={close} city={city} />
      <SettingsDialog open={open === 'settings'} onClose={close} mode={mode} prefs={prefs} me={me} />
    </nav>
  )
}

export function GetStartedButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className={`flex h-8 shrink-0 items-center rounded-full bg-ink px-3.5 text-13 font-medium text-surface transition-opacity hover:opacity-90 ${className}`}
    >
      Get started
    </button>
  )
}

/** What signed-out visitors see in place of their progress. */
export function GetStartedCard({ city, scheme, onGetStarted }: { city: CityId; scheme: Scheme; onGetStarted: () => void }) {
  return (
    <section className="surface rounded-[16px] p-4">
      <h1 className="text-14 font-medium">How much of {CITIES[city].name} have you covered?</h1>
      <p className="mt-1 text-13 text-ink-2">
        Connect Strava and watch every street and path you've run, walked or ridden turn{' '}
        <span className="inline-flex items-center gap-1 text-ink">
          <span className="size-2 rounded-full bg-done" aria-hidden />
          {SCHEMES[scheme].doneName}
        </span>
        . Then see where you rank in the city.
      </p>
      <button
        type="button"
        onClick={onGetStarted}
        aria-haspopup="dialog"
        className="mt-3 flex h-10 w-full items-center justify-center rounded-full bg-ink text-14 font-medium text-surface transition-opacity hover:opacity-90"
      >
        Get started
      </button>
    </section>
  )
}

export function ProgressCard({
  city,
  mode,
  unit,
  stravaConnected,
  hasActivities,
  stravaFull,
}: {
  city: CityId
  mode: Mode
  unit: Unit
  stravaConnected: boolean
  /** Has activities from Strava or an imported export. */
  hasActivities: boolean
  /** The app is at Strava's limit on connected athletes. */
  stravaFull: boolean
}) {
  const { data } = useSuspenseQuery(coverageQuery(city, mode))
  const activities = data.activities
  const ModeIcon = mode === 'foot' ? Footprints : Bike

  return (
    <section className="surface rounded-[16px] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          {/* Same treatment as the share image: a display figure with a quieter percent sign. */}
          <p className="flex items-baseline text-48 font-medium tracking-[-0.05em] tabular-nums">
            {formatPercent(data.percent).replace('%', '')}
            <span className="ml-0.5 text-24 tracking-normal text-ink-2">%</span>
          </p>
          <p className="mt-1.5 text-13 text-ink-2">
            of {CITIES[data.city].name} paths, {mode === 'foot' ? 'on foot' : 'by bike'}
          </p>
        </div>
        <ModeIcon size={20} strokeWidth={1.75} className="mt-1 shrink-0 text-done" aria-hidden />
      </div>

      {/* The track is the "to go" color, matching its dot below and the map's unfinished lines. */}
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-todo/90" aria-hidden>
        <div className="h-full rounded-full bg-done" style={{ width: `${Math.min(100, data.percent)}%` }} />
      </div>
      {/* Doubles as the map legend: the dots match the map's done and still-to-go lines. */}
      <div className="mt-2 flex items-center justify-between gap-3 text-12 tabular-nums">
        <span className="flex items-center gap-1.5 text-ink">
          <span className="size-2 rounded-full bg-done" aria-hidden />
          {formatDistance(data.completedMeters, unit)} {unit} done
        </span>
        <span className="flex items-center gap-1.5 text-ink-2">
          <span className="size-2 rounded-full bg-todo/90" aria-hidden />
          {formatDistance(data.totalMeters - data.completedMeters, unit)} {unit} to go
        </span>
      </div>

      {/* Someone who imported an export manages it in Settings. */}
      {!stravaConnected &&
        !hasActivities &&
        (stravaFull ? (
          <div className="mt-3 border-t border-line pt-3">
            <StravaFull compact />
          </div>
        ) : (
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
            <p className="text-12 text-ink-2">Connect Strava to start filling in the map.</p>
            <ConnectStravaButton className="shrink-0" />
          </div>
        ))}
      <p className="mt-3 border-t border-line pt-3 text-12 tabular-nums text-ink-2">
        <span className="text-ink">{num(data.streetsCompleted)}</span> of {num(data.totalStreets)} streets complete
        {activities !== undefined && (
          <>
            {' · '}
            <span className="text-ink">{num(activities)}</span> {activities === 1 ? 'activity' : 'activities'}
          </>
        )}
      </p>
    </section>
  )
}
