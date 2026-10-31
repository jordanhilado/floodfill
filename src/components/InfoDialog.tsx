import { CITIES, type CityId } from '../lib/cities'
import { ACTIVITY_CREDITS, AUTHOR_CREDITS, MAP_CREDITS, type Credit } from '../lib/credits'
import { MATCH } from '../server/coverage/match'
import { Modal } from './Modal'

/** What Floodfill counts, and where its data comes from. */
export function InfoDialog({ open, onClose, city }: { open: boolean; onClose: () => void; city: CityId }) {
  const sections: [string, Credit[]][] = [
    [CITIES[city].name, CITIES[city].credits],
    ['Map', MAP_CREDITS],
    ['Activities', ACTIVITY_CREDITS],
    ['Author', AUTHOR_CREDITS],
  ]

  return (
    <Modal open={open} onClose={onClose} title="About Floodfill">
      <p className="mt-2 text-13 text-ink-2">
        How much of {CITIES[city].name}'s paths you've covered, from your Strava activities. A block counts
        as done once {Math.round(MATCH.completeFraction * 100)}% of it is within {MATCH.radiusM} m of your GPS tracks.
      </p>
      {sections.map(([title, credits]) => (
        <section key={title} className="mt-4">
          <h3 className="text-12 text-ink-2">{title}</h3>
          <dl className="mt-1.5 divide-y divide-line">
            {credits.map((c) => (
              <div key={c.what + c.source} className="flex items-baseline justify-between gap-3 py-1.5">
                <dt className="shrink-0 text-13 text-ink-2">{c.what}</dt>
                <dd className="min-w-0 text-right text-13">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                  >
                    {c.source}
                  </a>
                  {c.license && (
                    // Keep the license with its separator so it never wraps alone.
                    <span className="whitespace-nowrap">
                      {' · '}
                      <a
                        href={c.license.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-ink-2 underline decoration-line underline-offset-2 hover:text-ink hover:decoration-ink"
                      >
                        {c.license.name}
                      </a>
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Modal>
  )
}
