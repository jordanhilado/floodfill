import { useNavigate } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { CITIES, CITY_IDS, DEFAULT_CITY, UPCOMING_CITIES, type CityId } from '../lib/cities'
import { Modal } from './Modal'

/** Cities floodfill.world covers, and the largest US cities that are on the way. */
export function CityDialog({ open, onClose, city }: { open: boolean; onClose: () => void; city: CityId }) {
  const navigate = useNavigate()
  const enabled = new Set(CITY_IDS.map((id) => CITIES[id].name))
  const choose = (id: CityId) => {
    onClose()
    if (id === city) return
    // A neighborhood belongs to one city, so the selection doesn't carry over.
    void navigate({
      to: '/',
      search: (prev) => ({ ...prev, mode: prev.mode ?? 'foot', city: id === DEFAULT_CITY ? undefined : id, hood: undefined }),
    })
  }
  return (
    <Modal open={open} onClose={onClose} title="Cities">
      <ul className="mt-3 divide-y divide-line">
        {CITY_IDS.map((id) => (
          <li key={id}>
            <button
              type="button"
              onClick={() => choose(id)}
              aria-current={id === city ? 'true' : undefined}
              className="flex h-11 w-full items-center gap-2 rounded-[8px] text-left text-13 hover:bg-fill"
            >
              <span className="font-medium text-ink">{CITIES[id].name}</span>
              <span className="text-ink-2">{CITIES[id].state}</span>
              {id === city && <Check size={14} strokeWidth={2} className="ml-auto text-done" aria-label="Current city" />}
            </button>
          </li>
        ))}
        {UPCOMING_CITIES.filter((c) => !enabled.has(c.name)).map((c) => (
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
