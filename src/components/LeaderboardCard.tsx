import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { CITIES, type CityId } from '../lib/cities'
import { formatDistance, formatPercent, type Unit } from '../lib/prefs'
import { leaderboardQuery, standingsQuery, type Mode } from '../lib/query-options'
import type { CityStanding } from '../server/queries'
import { RankRow } from './RankingsCard'

const ROW_PX = 48
const VISIBLE_ROWS = 5
const num = (n: number) => n.toLocaleString('en-US')

type Tab = 'city' | 'you'

/** Who has covered the most of the city, and where you stand in each city. */
export function LeaderboardCard({
  city,
  mode,
  unit,
  signedIn,
  onGetStarted,
}: {
  city: CityId
  mode: Mode
  unit: Unit
  signedIn: boolean
  onGetStarted: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [tab, setTab] = useState<Tab>('city')
  const how = mode === 'foot' ? 'on foot' : 'by bike'

  return (
    <section className="surface rounded-[16px] p-4">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-14 font-medium">Leaderboard</h2>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse leaderboard' : 'Expand leaderboard'}
          className="flex size-7 items-center justify-center rounded-[8px] text-ink-2 hover:bg-fill-strong hover:text-ink max-sm:hidden"
        >
          <ChevronDown size={14} strokeWidth={2} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-0.5 rounded-[8px] bg-fill p-0.5" role="tablist" aria-label="Leaderboard">
        {(
          [
            ['city', CITIES[city].name],
            ['you', 'You'],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t)
              setExpanded(true)
            }}
            className={`h-7 truncate rounded-[8px] px-2 text-13 transition-colors ${
              tab === t ? 'bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--color-line)]' : 'text-ink-2 hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {expanded &&
        (tab === 'city' ? (
          <CityBoard city={city} mode={mode} how={how} signedIn={signedIn} onGetStarted={onGetStarted} />
        ) : signedIn ? (
          <Standings mode={mode} unit={unit} how={how} />
        ) : (
          <JoinPrompt onGetStarted={onGetStarted} text="Sign in to see where you rank in each city." />
        ))}
    </section>
  )
}

function CityBoard({
  city,
  mode,
  how,
  signedIn,
  onGetStarted,
}: {
  city: CityId
  mode: Mode
  how: string
  signedIn: boolean
  onGetStarted: () => void
}) {
  const { data, isPending } = useQuery(leaderboardQuery(city, mode))
  const navigate = useNavigate()
  const openProfile = (username: string) =>
    navigate({ to: '/u/$handle', params: { handle: `@${username}` }, search: (prev) => ({ ...prev, mode: prev.mode ?? 'foot' }) })
  if (isPending) return <Loading />
  if (!data || data.rows.length === 0) {
    return signedIn ? (
      <p className="mt-3 text-13 text-ink-2">No one is on the board yet. Connect Strava to be the first.</p>
    ) : (
      <JoinPrompt onGetStarted={onGetStarted} text="No one is on the board yet. Be the first." />
    )
  }
  return (
    <>
      <p className="mt-3 text-12 text-ink-2">
        {num(data.players)} {data.players === 1 ? 'person' : 'people'} ranked by share of paths {how}
      </p>
      <ol className="-mx-1 mt-2 overflow-y-auto overscroll-contain px-1" style={{ maxHeight: ROW_PX * VISIBLE_ROWS }}>
        {data.rows.map((r) => (
          <li key={r.username} style={{ height: ROW_PX }}>
            <RankRow
              rank={r.rank}
              name={<Name username={r.username} you={r.you} />}
              percent={r.percent}
              activities={r.activities}
              emphasis={r.you}
              onClick={() => openProfile(r.username)}
            />
          </li>
        ))}
      </ol>
      {data.you && (
        <div className="mt-1 border-t border-line pt-1">
          <RankRow
            rank={data.you.rank}
            name={<Name username={data.you.username} you />}
            percent={data.you.percent}
            activities={data.you.activities}
            emphasis
            onClick={() => openProfile(data.you!.username)}
          />
        </div>
      )}
      {!signedIn && <JoinPrompt onGetStarted={onGetStarted} text="Get started to see yourself here." />}
    </>
  )
}

function Name({ username, you }: { username: string; you: boolean }) {
  return (
    <>
      <span className="truncate">@{username}</span>
      {you && <span className="shrink-0 rounded-full bg-done/15 px-1.5 text-12 font-normal text-done">You</span>}
    </>
  )
}

function Standings({ mode, unit, how }: { mode: Mode; unit: Unit; how: string }) {
  const { data, isPending } = useQuery(standingsQuery(mode))
  if (isPending || !data) return <Loading />
  return (
    <>
      <ul className="mt-3 divide-y divide-line">
        {data.map((c) => (
          <li key={c.city} className="py-2 first:pt-0">
            <Standing title={c.name} standing={c} unit={unit} how={how} />
            {!c.rank && <p className="mt-1 text-12 text-ink-2">Choose a username and connect Strava to be ranked.</p>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-12 text-ink-3">More cities coming soon.</p>
    </>
  )
}

/** Rank, progress bar, share done and distance for one city and mode. */
export function Standing({ title, standing: c, unit, how }: { title: string; standing: CityStanding; unit: Unit; how: string }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-14 font-medium">{title}</span>
        <span className="text-13 tabular-nums text-ink-2">
          {c.rank ? (
            <>
              <span className="text-ink">#{num(c.rank)}</span> of {num(c.players)}
            </>
          ) : (
            'Not ranked yet'
          )}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-todo/90" aria-hidden>
        <div className="h-full rounded-full bg-done" style={{ width: `${Math.min(100, c.percent)}%` }} />
      </div>
      <p className="mt-1.5 flex justify-between text-12 tabular-nums text-ink-2">
        <span>
          <span className="text-ink">{formatPercent(c.percent)}</span> {how} · {num(c.activities)}{' '}
          {c.activities === 1 ? 'activity' : 'activities'}
        </span>
        <span>
          {formatDistance(c.meters, unit)} of {formatDistance(c.totalMeters, unit)} {unit}
        </span>
      </p>
    </>
  )
}

function JoinPrompt({ text, onGetStarted }: { text: string; onGetStarted: () => void }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-[8px] bg-fill p-3">
      <p className="text-13 text-ink-2">{text}</p>
      <button
        type="button"
        onClick={onGetStarted}
        className="h-8 shrink-0 rounded-full bg-ink px-3.5 text-13 font-medium text-surface transition-opacity hover:opacity-90"
      >
        Get started
      </button>
    </div>
  )
}

function Loading() {
  return (
    <div className="mt-3 flex h-12 items-center justify-center gap-2 text-13 text-ink-2">
      <Loader2 size={14} className="animate-spin" /> Loading
    </div>
  )
}
