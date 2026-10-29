import { Check } from 'lucide-react'
import { CITIES, UPCOMING_CITIES, type CityId } from '../lib/cities'
import { Modal } from './Modal'

/** Cities Floodfill covers: the current one, and the largest US cities that are on the way. */
export function CityDialog({ open, onClose, city }: { open: boolean; onClose: () => void; city: CityId }) {
  const current = CITIES[city]
  return (
    <Modal open={open} onClose={onClose} title="Cities">
      <ul className="mt-3 divide-y divide-line">
        <li>
          <button
            type="button"
            onClick={onClose}
            aria-current="true"
            className="flex h-11 w-full items-center gap-2 rounded-[8px] text-left text-13"
          >
            <span className="font-medium text-ink">{current.name}</span>
            <span className="text-ink-2">{current.state}</span>
            <Check size={14} strokeWidth={2} className="ml-auto text-done" aria-label="Current city" />
          </button>
        </li>
        {UPCOMING_CITIES.map((c) => (
          <li key={c.name} aria-disabled="true" className="flex h-11 items-center gap-2 text-13">
            <span className="text-ink-2">{c.name}</span>
            <span className="text-ink-3">{c.state}</span>
            <span className="ml-auto rounded-full bg-fill px-2 py-0.5 text-12 text-ink-2">Coming soon</span>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
