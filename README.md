# Floodfill

How much of San Francisco you've covered, from your Strava activities. Streets and paths come
from OpenStreetMap; yellow = not yet, blue = completed. Progress is tracked separately **by foot**
(Run, Trail Run, Walk, Hike — the default) and **by bike** (Ride, MTB, Gravel, e-bike). The
settings dialog (gear, top left) switches mode and km/mi and holds the Strava sync; mode lives in
the URL (`?mode=bike`), the unit in a cookie so it renders server-side.

TanStack Start + TanStack Router/Query on Cloudflare Workers, D1 for storage, MapLibre for the map.

## Run it

```bash
pnpm install
pnpm db:setup            # create the local D1 schema and load the SF street network
cp .dev.vars.example .dev.vars   # STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / AUTH_SECRET
pnpm dev                 # http://localhost:3000
```

Your Strava API app's **Authorization Callback Domain** must be `localhost` locally (and your
domain in production); the callback is `/api/strava/callback`.

## Accounts

- **Get started** is sign-in and sign-up in one: enter an email or username, then the 6-digit code
  emailed to you. There are no passwords. A new email creates an account; you then pick a unique
  username (case-insensitive) and connect Strava now or later.
- Codes are sent with Cloudflare Email Service (`send_email` binding). Locally the binding is
  simulated: the code is printed in the dev server log and the message appears in Wrangler's Local
  Explorer at `/cdn-cgi/local/explorer`. In production, onboard a sending domain
  (`wrangler email sending enable <domain>`) and set `EMAIL_FROM` in `wrangler.jsonc`.
- Codes expire after 10 minutes, allow 5 attempts, and can be re-sent every 30 seconds; only a
  salted hash is stored. Sessions are 30-day httpOnly cookies, stored as hashes.
- Each user connects their own Strava account through OAuth. Activities imported before accounts
  existed are claimed by whoever connects the same Strava athlete, and re-credited from their
  stored tracks without new Strava requests.
- The leaderboard ranks everyone with a username and a connected Strava account by share of the
  city covered, then activities. The **You** tab shows your rank and progress in each city.

## How it works

- **Network** — `scripts/build-streets.ts` pulls every public way inside the SF boundary from
  Overpass and keeps streets (no freeways or service roads) plus footways, paths, trails,
  cycleways and stairways. Sidewalks and crosswalks are skipped since they duplicate the street
  beside them. Bike mode drops stairs and footways without bike access. Ways are split at
  intersections into block-length segments (≤150 m) and written to
  `public/data/sf/streets.geojson` (cached static asset) and a D1 seed (`db/seed/sf-segments.sql`).
  About 28,700 walkable segments: 2,250 km / 1,398 mi on foot (Wandrer reports 1,406.89 mi),
  1,907 km by bike. "Full streets" counts named streets only; paths count toward distance.
- **Neighborhoods** — boundaries are DataSF's
  [Analysis Neighborhoods](https://data.sf.gov/-/Analysis-Neighborhoods/p5b7-5n3h) (41, used by
  City departments for reporting). The build assigns each segment to the neighborhood containing
  its midpoint (using full-detail polygons; 0.3% of the network falls outside all of them) and
  writes simplified boundaries to `public/data/sf/neighborhoods.geojson` (86 KB). The map always
  shows them, and a Neighborhoods card ranks all 41 by progress; selecting one spotlights it on
  the map. The selection is in the URL (`?hood=Mission`).
- **Rankings** — a tabbed card ranks the 41 neighborhoods and all ~2,100 named streets and paths,
  by progress then activities (or activities then progress via the sort toggle). Streets are
  ranked on the server from the precomputed totals plus two queries over your own coverage and
  activities, and served 50 at a time; the list is virtualized
  (TanStack Virtual) and loads pages as it scrolls (TanStack Query infinite query). Search runs on
  the server and keeps each street's overall rank. Picking a street frames and highlights it.
- **Share** — a 1080×1440 (3:4) PNG drawn on a canvas: the map with your palette, headline stats,
  top neighborhoods and top streets by activities. Shared through the native share sheet where
  available, or saved directly.
- **Rebuilding the network** — `pnpm streets && pnpm db:setup`, then restart `pnpm dev`. The seed
  clears derived coverage and flags a re-match; the next sync re-credits every stored track
  against the new segments without any Strava requests.
- **Static totals** — city, street and neighborhood totals (and every street's length and bounds)
  are summed from the seed into `src/lib/totals.<city>.json`, so page views don't scan
  `segments`. `pnpm streets` writes it; `pnpm totals [city]` regenerates it from the existing seed
  without Overpass, and `pnpm test` fails if it's out of date. It ships with the Worker, so a new
  seed applied to production D1 needs the matching deploy (and vice versa).
- **Matching** — each segment gets sample points every 10 m (skipping 12 m at each end so that
  crossing an intersection doesn't count). A sample is visited when a track passes within 20 m.
  A segment is complete once 70% of its samples have been visited, across any number of
  activities. Constants are in `src/server/coverage/match.ts`.
- **Sync** (`src/server/sync.ts`) — resumable, in three phases:
  1. new activities since the newest one stored,
  2. history backfill, 200 activities per request,
  3. full GPS streams, one request per activity, newest first.
  Activities are credited right away from the summary polyline that comes with the list (no extra
  requests), then re-matched when the full-resolution stream arrives.
- **Rate limits** — `src/server/strava/rate-limit.ts` tracks both Strava limits (overall 400/15 min
  and 4,000/day; read 200/15 min and 2,000/day), takes the real numbers from Strava's
  `X-RateLimit-*` / `X-ReadRateLimit-*` response headers, and stops at `STRAVA_BUDGET_FRACTION`
  (90%) of each so other clients keep some headroom. Limits are `vars` in `wrangler.jsonc`.
- **Triggers** — "Sync now" (Settings → Strava) runs 20-second batches back to back, refreshing the map after each one.
  A cron trigger (`1,16,31,46 * * * *`, just after each rate window resets) continues the import in
  production. To fire it locally:
  `curl "http://localhost:3000/cdn-cgi/local/scheduled"`

## Data model (D1)

`segments` (static street network) · `activities` · `activity_segments` (what each activity
covered, as a bitmask of sample points) · `activity_groups` (the street names and neighborhoods
each activity touched, so per-street and per-neighborhood activity counts don't read every matched
segment) · `coverage` (OR of all activities, per segment and mode) · `state` (tokens, cursors, rate
usage, lock) · `sync_runs`.

## Adding a city

Add an entry to `src/lib/cities.ts`, run `pnpm streets <id>`, add the generated
`src/lib/totals.<id>.json` to `TOTALS` in `src/server/queries.ts`, and load
`db/seed/<id>-segments.sql`. Only San Francisco is enabled.

## Deploying your own

`wrangler d1 create floodfill` and put the new id in `wrangler.jsonc` (the one there is this
project's own database), apply migrations and the seed with `--remote`, set `STRAVA_CLIENT_ID`,
`STRAVA_CLIENT_SECRET` and `AUTH_SECRET` with `wrangler secret put`, change the custom-domain route
and `EMAIL_FROM` to your domain, onboard it for email sending, then `pnpm run deploy`.

## License

Code: [MIT](LICENSE). Street and path data in `db/seed/` and `public/data/sf/streets.geojson` is
derived from © OpenStreetMap contributors and available under the
[ODbL](https://opendatacommons.org/licenses/odbl/). Neighborhood boundaries are from DataSF,
under the [PDDL](https://opendatacommons.org/licenses/pddl/1-0/).
