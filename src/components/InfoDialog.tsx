import { DOMAIN, REPO_URL } from '../lib/brand'
import { CITIES, CITY_IDS } from '../lib/cities'
import { ACTIVITY_CREDITS, MAP_CREDITS, type Credit } from '../lib/credits'
import { MATCH } from '../server/coverage/match'
import { Modal } from './Modal'

const link = 'text-ink underline decoration-line underline-offset-2 hover:decoration-ink'

/** What floodfill.world counts, and where its data comes from, for every city. */
export function InfoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sections: [string, Credit[]][] = [
    ...CITY_IDS.map((id): [string, Credit[]] => [CITIES[id].name, CITIES[id].credits]),
    ['Map', MAP_CREDITS],
    ['Activities', ACTIVITY_CREDITS],
  ]

  return (
    <Modal open={open} onClose={onClose} title={`About ${DOMAIN}`}>
      <p className="mt-2 text-13 text-ink-2">
        How much of each city's paths you've covered, from your Strava activities. A block counts as done once{' '}
        {Math.round(MATCH.completeFraction * 100)}% of it is within {MATCH.radiusM} m of your GPS tracks.
      </p>
      <p className="mt-2 text-13 text-ink-2">
        {DOMAIN} is open source.{' '}
        <a href={REPO_URL} target="_blank" rel="noreferrer" className={link}>
          View it on GitHub
        </a>
        .
      </p>
      {sections.map(([title, credits]) => (
        <section key={title} className="mt-4">
          <h3 className="text-12 text-ink-2">{title}</h3>
          <dl className="mt-1.5 divide-y divide-line">
            {credits.map((c) => (
              <div key={c.what + c.source} className="flex items-baseline justify-between gap-3 py-1.5">
                <dt className="shrink-0 text-13 text-ink-2">{c.what}</dt>
                <dd className="min-w-0 text-right text-13">
                  <a href={c.url} target="_blank" rel="noreferrer" className={link}>
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
