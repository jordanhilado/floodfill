import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import type { CityId } from '../lib/cities'
import { NEIGHBORHOODS } from '../lib/neighborhoods'
import { formatDistance, formatPercent, type Unit } from '../lib/prefs'
import { streetDetailQuery, type Mode } from '../lib/query-options'
import { streetProgress, type StreetIndex } from '../lib/street-index'

/** The tapped street: how much of it is done in this mode and which neighborhoods it runs through. */
export function StreetCard({
  city,
  index,
  ids,
  target,
  completed,
  mode,
  unit,
  onClose,
}: {
  city: CityId
  index: StreetIndex
  ids: number[]
  /** What to ask the server about: the street by name, or a single unnamed segment. */
  target: { name: string } | { segmentId: number }
  completed: Set<number>
  mode: Mode
  unit: Unit
  onClose: () => void
}) {
  const { data: detail } = useQuery(streetDetailQuery(mode, target))
  const segments = ids.map((id) => index.byId.get(id)!).filter(Boolean)
  const first = segments[0]
  if (!first) return null
  // A street with a park path of the same name is still a street.
  const isPath = segments.every((s) => s.path)
  const { done, total, percent: pct, counted } = streetProgress(index, ids, completed, mode)

  // Neighborhoods it runs through, longest stretch first.
  const byHood = new Map<number, number>()
  for (const s of segments) if (s.hood !== null) byHood.set(s.hood, (byHood.get(s.hood) ?? 0) + s.length)
  const hoods = [...byHood].sort((a, b) => b[1] - a[1]).map(([i]) => NEIGHBORHOODS[city][i]?.name)
  const where = hoods.length > 3 ? `${hoods.slice(0, 3).join(', ')} +${hoods.length - 3}` : hoods.join(', ')

  return (
    <section className="surface rounded-[16px] p-4" aria-live="polite">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-14 font-medium">{first.name ?? (isPath ? 'Unnamed path' : 'Unnamed street')}</h2>
          <p className="truncate text-12 text-ink-2">
            {isPath ? 'Path' : 'Street'}
            {where && ` · ${where}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Clear selected street"
          className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-2 hover:bg-fill-strong hover:text-ink"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      {counted ? (
        <>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-todo/90" aria-hidden>
            <div className="h-full rounded-full bg-done" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <p className="mt-2 flex justify-between text-12 tabular-nums text-ink-2">
            <span>
              <span className="text-ink">{formatPercent(pct)}</span> done {mode === 'foot' ? 'on foot' : 'by bike'}
            </span>
            <span>
              {formatDistance(done, unit)} of {formatDistance(total, unit)} {unit}
            </span>
          </p>
          <p className="mt-1 text-12 tabular-nums text-ink-2">
            {detail ? (
              <>
                <span className="text-ink">{detail.activities.toLocaleString('en-US')}</span>{' '}
                {detail.activities === 1 ? 'activity' : 'activities'}
                {detail.rank !== null && detail.ranked !== null && (
                  <>
                    {' · '}#{detail.rank.toLocaleString('en-US')} of {detail.ranked.toLocaleString('en-US')} streets
                  </>
                )}
              </>
            ) : (
              '\u00a0'
            )}
          </p>
        </>
      ) : (
        <p className="mt-3 text-12 text-ink-2">Not counted {mode === 'foot' ? 'on foot' : 'by bike'}.</p>
      )}
    </section>
  )
}
