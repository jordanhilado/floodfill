import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownWideNarrow, ChevronDown, Loader2, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CityId } from '../lib/cities'
import { formatPercent } from '../lib/prefs'
import { streetsQuery, type Mode, type RankSort } from '../lib/query-options'
import type { NeighborhoodProgress, StreetProgressRow } from '../server/queries'
import { useSheet } from './Sheet'

const ROW_PX = 48
const VISIBLE_ROWS = 5
/** Phones list this many neighborhoods before "Show all" (the sheet scrolls, not the list). */
const PHONE_ROWS = 8
const num = (n: number) => n.toLocaleString('en-US')

type Tab = 'neighborhoods' | 'streets'

/** Neighborhoods and streets ranked by progress. Selecting either highlights and frames it on the map. */
export function RankingsCard({
  city,
  mode,
  neighborhoods,
  selectedNeighborhood,
  selectedStreet,
  onSelectStreet,
}: {
  city: CityId
  mode: Mode
  neighborhoods: NeighborhoodProgress[]
  selectedNeighborhood: string | undefined
  selectedStreet: string | null
  onSelectStreet: (street: StreetProgressRow | null) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [tab, setTab] = useState<Tab>('neighborhoods')
  const [sort, setSort] = useState<RankSort>('progress')
  const queryClient = useQueryClient()
  // On phones, lower the sheet once something is picked so it shows on the map.
  const sheet = useSheet()

  // Warm the first page of streets so switching tabs is instant.
  useEffect(() => {
    void queryClient.prefetchInfiniteQuery(streetsQuery(city, mode, ''))
  }, [city, mode, queryClient])

  return (
    <section className="surface rounded-[16px] p-4">
      <div className="flex items-center gap-2">
        <h2 className="mr-auto text-14 font-medium">Rankings</h2>
        <button
          type="button"
          onClick={() => setSort((s) => (s === 'progress' ? 'activities' : 'progress'))}
          aria-label={`Sorted by ${sort}. Sort by ${sort === 'progress' ? 'activities' : 'progress'} instead`}
          title={sort === 'progress' ? 'Sorted by progress, then activities' : 'Sorted by activities, then progress'}
          className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-12 text-ink-2 hover:bg-fill-strong hover:text-ink"
        >
          <ArrowDownWideNarrow size={14} strokeWidth={1.75} />
          {/* Both labels share one cell so the button keeps the longer one's width and the tabs don't shift. */}
          <span className="grid text-left">
            {(['progress', 'activities'] as const).map((s) => (
              <span key={s} className={`col-start-1 row-start-1 ${s === sort ? '' : 'invisible'}`}>
                {s === 'progress' ? 'Progress' : 'Activities'}
              </span>
            ))}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse rankings' : 'Expand rankings'}
          className="flex size-7 items-center justify-center rounded-[8px] text-ink-2 hover:bg-fill-strong hover:text-ink max-sm:hidden"
        >
          <ChevronDown size={14} strokeWidth={2} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-0.5 rounded-[8px] bg-fill p-0.5" role="tablist" aria-label="Rankings">
        {(['neighborhoods', 'streets'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t)
              setExpanded(true)
            }}
            className={`h-7 rounded-[8px] text-13 transition-colors ${
              tab === t ? 'bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--color-line)]' : 'text-ink-2 hover:text-ink'
            }`}
          >
            {t === 'neighborhoods' ? 'Neighborhoods' : 'Paths'}
          </button>
        ))}
      </div>

      {expanded &&
        (tab === 'neighborhoods' ? (
          <NeighborhoodList
            neighborhoods={neighborhoods}
            selected={selectedNeighborhood}
            sort={sort}
            onPicked={sheet.collapse}
          />
        ) : (
          <StreetList
            city={city}
            mode={mode}
            selected={selectedStreet}
            onSelect={(row) => {
              onSelectStreet(row)
              if (row) sheet.collapse()
            }}
            sort={sort}
          />
        ))}
    </section>
  )
}

/** One ranked entry: rank, name, percent, and a bar with the activity count. */
export function RankRow({
  rank,
  name,
  percent,
  activities,
  selected,
  emphasis = false,
  onClick,
}: {
  rank: number
  name: React.ReactNode
  percent: number
  activities: number
  /** Rows that toggle a selection; leave unset for rows that open something. */
  selected?: boolean
  /** Your own row on a leaderboard. */
  emphasis?: boolean
  /** Rows without one are display-only. */
  onClick?: () => void
}) {
  const body = (
    <>
      <span className="flex w-full items-center gap-2 text-13">
        <span className={`min-w-5 shrink-0 text-12 tabular-nums ${selected ? 'text-surface/60' : 'text-ink-3'}`}>{rank}</span>
        <span className={`flex min-w-0 items-center gap-1.5 ${selected || emphasis ? 'font-medium' : ''}`}>{name}</span>
        <span className={`ml-auto tabular-nums ${selected ? 'text-surface' : 'text-ink-2'}`}>{formatPercent(percent)}</span>
      </span>
      <span className="mt-1 flex w-full items-center gap-2 pl-7">
        <span className={`block h-1.5 flex-1 overflow-hidden rounded-full ${selected ? 'bg-surface/20' : 'bg-todo/90'}`}>
          <span className="block h-full rounded-full bg-done" style={{ width: `${Math.min(100, percent)}%` }} />
        </span>
        {/* leading-none so the bar centers on the glyphs, not the 16px line box */}
        <span className={`shrink-0 text-12 leading-none tabular-nums ${selected ? 'text-surface/70' : 'text-ink-2'}`}>
          {num(activities)} {activities === 1 ? 'activity' : 'activities'}
        </span>
      </span>
    </>
  )
  const base = 'flex h-[44px] w-full flex-col justify-center rounded-[8px] px-2 text-left'
  if (!onClick) return <div className={`${base} ${emphasis ? 'bg-fill' : ''}`}>{body}</div>
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`${base} transition-colors ${selected ? 'bg-ink text-surface' : emphasis ? 'bg-fill hover:bg-fill-strong' : 'hover:bg-fill'}`}
    >
      {body}
    </button>
  )
}

function NeighborhoodList({
  neighborhoods: byProgress,
  selected,
  sort,
  onPicked,
}: {
  /** Already ranked by progress, then activities. */
  neighborhoods: NeighborhoodProgress[]
  selected: string | undefined
  sort: RankSort
  onPicked: () => void
}) {
  const neighborhoods = useMemo(
    () =>
      sort === 'progress'
        ? byProgress
        : [...byProgress].sort((a, b) => b.activities - a.activities || b.percent - a.percent || a.name.localeCompare(b.name)),
    [byProgress, sort],
  )
  const navigate = useNavigate()
  const list = useRef<HTMLOListElement>(null)
  const rank = neighborhoods.findIndex((n) => n.name === selected)
  const select = (name: string | undefined) =>
    navigate({ to: '/', search: (prev) => ({ ...prev, mode: prev.mode ?? 'foot', hood: name }), replace: true })
  const [showAll, setShowAll] = useState(false)
  const all = showAll || rank >= PHONE_ROWS

  // Keep the selection visible when it's chosen elsewhere (e.g. opened from a link). Desktop
  // only: on phones the list is part of the sheet, which shouldn't jump.
  useEffect(() => {
    if (rank >= 0 && window.matchMedia('(min-width: 640px)').matches) list.current?.children[rank]?.scrollIntoView({ block: 'nearest' })
  }, [rank])

  return (
    <>
      <ol
        ref={list}
        className="-mx-1 mt-3 px-1 sm:max-h-[var(--list-h)] sm:overflow-y-auto sm:overscroll-contain"
        style={{ '--list-h': `${ROW_PX * VISIBLE_ROWS}px` } as React.CSSProperties}
        aria-label="Neighborhoods by progress"
      >
        {neighborhoods.map((n, i) => (
          <li key={n.name} style={{ height: ROW_PX }} className={!all && i >= PHONE_ROWS ? 'max-sm:hidden' : ''}>
            <RankRow
              rank={i + 1}
              name={n.name}
              percent={n.percent}
              activities={n.activities}
              selected={n.name === selected}
              onClick={() => {
                select(n.name === selected ? undefined : n.name)
                if (n.name !== selected) onPicked()
              }}
            />
          </li>
        ))}
      </ol>
      {neighborhoods.length > PHONE_ROWS && rank < PHONE_ROWS && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 h-9 w-full rounded-[8px] text-13 text-ink-2 hover:bg-fill hover:text-ink sm:hidden"
        >
          {showAll ? 'Show fewer' : `Show all ${neighborhoods.length} neighborhoods`}
        </button>
      )}
    </>
  )
}

function StreetList({
  city,
  mode,
  selected,
  onSelect,
  sort,
}: {
  city: CityId
  mode: Mode
  selected: string | null
  onSelect: (street: StreetProgressRow | null) => void
  sort: RankSort
}) {
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 200)
    return () => clearTimeout(t)
  }, [input])

  const sheet = useSheet()
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage, isPending, isFetching } = useInfiniteQuery({
    ...streetsQuery(city, mode, q, sort),
    // Keep showing the last results while a new search loads.
    placeholderData: keepPreviousData,
  })
  const rows = data?.pages.flatMap((p) => p.rows) ?? []
  const first = data?.pages[0]

  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: hasNextPage ? rows.length + 1 : rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_PX,
    overscan: 10,
  })
  const items = virtualizer.getVirtualItems()

  // Fetch the next page as the list nears the end of what's loaded.
  const lastIndex = items.at(-1)?.index ?? 0
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastIndex >= rows.length - 5) void fetchNextPage()
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  // A new search starts from the top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [q, mode, sort])

  return (
    <>
      <label className="mt-3 flex h-8 items-center gap-2 rounded-[8px] bg-fill px-2.5 text-13 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-done">
        <Search size={14} strokeWidth={1.75} className="shrink-0 text-ink-2" />
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          // Phones: raise the sheet so the results stay above the keyboard.
          onFocus={sheet.expand}
          placeholder={first ? `Search ${num(first.ranked)} paths` : 'Search paths'}
          aria-label="Search paths"
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-2 [&::-webkit-search-cancel-button]:hidden"
        />
        {isFetching && !isFetchingNextPage ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-ink-2" />
        ) : (
          input && (
            <button type="button" onClick={() => setInput('')} aria-label="Clear search" className="shrink-0 text-ink-2 hover:text-ink">
              <X size={14} strokeWidth={2} />
            </button>
          )
        )}
      </label>

      <div
        ref={scroller}
        className="-mx-1 mt-2 overflow-y-auto overscroll-contain px-1"
        style={{ height: ROW_PX * VISIBLE_ROWS }}
        aria-label="Paths by progress"
        role="list"
      >
        {isPending ? (
          <div className="flex h-full items-center justify-center gap-2 text-13 text-ink-2">
            <Loader2 size={14} className="animate-spin" /> Ranking streets…
          </div>
        ) : rows.length === 0 ? (
          <p className="flex h-full items-center justify-center text-13 text-ink-2">No streets match “{q}”.</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index]
              return (
                <div
                  key={row?.name ?? 'loader'}
                  role="listitem"
                  className="absolute inset-x-0"
                  style={{ top: item.start, height: ROW_PX }}
                >
                  {row ? (
                    <RankRow
                      rank={row.rank}
                      name={row.name}
                      percent={row.percent}
                      activities={row.activities}
                      selected={row.name === selected}
                      onClick={() => onSelect(row.name === selected ? null : row)}
                    />
                  ) : (
                    <div className="flex h-[44px] items-center justify-center text-12 text-ink-2">
                      <Loader2 size={14} className="animate-spin" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {first && q && <p className="mt-2 text-12 text-ink-2">{num(first.matches)} matching</p>}
    </>
  )
}
