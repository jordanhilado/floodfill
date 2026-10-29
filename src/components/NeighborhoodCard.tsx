import { X } from 'lucide-react'
import { formatDistance, formatPercent, type Unit } from '../lib/prefs'
import type { Mode } from '../lib/query-options'
import type { NeighborhoodProgress } from '../server/queries'

/** The selected neighborhood: how much of it is done in this mode, its rank and its activities. */
export function NeighborhoodCard({
  neighborhood: n,
  rank,
  of,
  mode,
  unit,
  onClose,
}: {
  neighborhood: NeighborhoodProgress
  /** Position by progress among the city's neighborhoods (1-based). */
  rank: number
  of: number
  mode: Mode
  unit: Unit
  onClose: () => void
}) {
  return (
    <section className="surface rounded-[16px] p-4" aria-live="polite">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-14 font-medium">{n.name}</h2>
          <p className="truncate text-12 tabular-nums text-ink-2">
            Neighborhood · #{rank} of {of}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Clear selected neighborhood"
          className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-2 hover:bg-fill-strong hover:text-ink"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-todo/90" aria-hidden>
        <div className="h-full rounded-full bg-done" style={{ width: `${Math.min(100, n.percent)}%` }} />
      </div>
      <p className="mt-2 flex justify-between text-12 tabular-nums text-ink-2">
        <span>
          <span className="text-ink">{formatPercent(n.percent)}</span> done {mode === 'foot' ? 'on foot' : 'by bike'}
        </span>
        <span>
          {formatDistance(n.completedMeters, unit)} of {formatDistance(n.totalMeters, unit)} {unit}
        </span>
      </p>
      <p className="mt-1 text-12 tabular-nums text-ink-2">
        <span className="text-ink">{n.activities.toLocaleString('en-US')}</span> {n.activities === 1 ? 'activity' : 'activities'}
      </p>
    </section>
  )
}
