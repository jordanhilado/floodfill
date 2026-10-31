import { DOMAIN, REPO_URL } from '../lib/brand'
import { CITIES, CITY_IDS } from '../lib/cities'
import { ACTIVITY_CREDITS, AUTHOR_CREDITS, MAP_CREDITS, OSM_STREETS, type Credit } from '../lib/credits'
import { MATCH } from '../server/coverage/match'
import { Modal } from './Modal'

const link = 'text-ink underline decoration-line underline-offset-2 hover:decoration-ink'

/** One line of the credits: a label and the sources behind it. */
type Row = { what: string; credits: Credit[] }

/** What floodfill.world counts, and where its data comes from, for every city. */
export function InfoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tiles, schema, , rendering] = MAP_CREDITS
  // OpenStreetMap supplies both every city's paths and the basemap, so it gets one line.
  const rows: Row[] = [
    { what: 'Paths & map data', credits: [OSM_STREETS] },
    ...CITY_IDS.map((id) => ({
      what: `${CITIES[id].name} neighborhoods`,
      credits: CITIES[id].credits.filter((c) => c !== OSM_STREETS),
    })),
    { what: 'Basemap', credits: [tiles, schema] },
    { what: 'Rendering', credits: [rendering] },
    ...[...ACTIVITY_CREDITS, ...AUTHOR_CREDITS].map((c) => ({ what: c.what, credits: [c] })),
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
      <dl className="mt-3 divide-y divide-line">
        {rows.map((row) => (
          <div key={row.what} className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="shrink-0 text-13 text-ink-2">{row.what}</dt>
            <dd className="min-w-0 text-right text-13">
              {row.credits.map((c, i) => (
                <span key={c.source}>
                  {i > 0 && ', '}
                  <a href={c.url} target="_blank" rel="noreferrer" title={c.source} className={link}>
                    {c.short ?? c.source}
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
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
