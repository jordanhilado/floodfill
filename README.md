# floodfill.world

See how much of your city you've covered. [floodfill.world](https://floodfill.world) matches your
Strava activities against every street and path in a city and fills in the map as you go.

Floodfill works city by city. Open now: **San Francisco**, **Los Angeles**, **New York** and
**Seattle**.

## Features

- **Coverage map**: every street and path in the city, shaded by whether you've covered it yet.
- **On foot and by bike**: runs, walks and hikes are tracked separately from rides.
- **Neighborhoods and streets**: rank them by progress or activities, search for a street, and
  spotlight one on the map.
- **Leaderboard**: see how you compare with everyone else in the city.
- **Share card**: export an image of your map and stats.
- **Strava sync**: your history imports in the background and new activities are picked up
  automatically.
- **Passwordless sign-in**: log in with a code sent to your email.

## Tech stack

- [TanStack Start](https://tanstack.com/start), Router, Query and Virtual, with React and
  Tailwind CSS
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) with D1 for storage, cron
  triggers for syncing, and Email Service for sign-in codes
- [MapLibre GL](https://maplibre.org/) for the map
- Street data from [OpenStreetMap](https://www.openstreetmap.org/); neighborhoods from each
  city's open data (see License)
- TypeScript, Vite, Vitest and pnpm

## Running locally

You'll need Node.js, pnpm and a [Strava API app](https://www.strava.com/settings/api) whose
Authorization Callback Domain is `localhost`.

```bash
pnpm install
pnpm db:setup                    # create the local database and load the San Francisco streets
cp .dev.vars.example .dev.vars   # then fill in your Strava app's keys and an AUTH_SECRET
pnpm dev                         # http://localhost:3000
```

Sign-in codes aren't emailed locally; they're printed in the dev server log.

## Contributing

Contributions are welcome, from bug fixes to new features to support for a new city. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for how to name branches and pull requests. Run
`pnpm typecheck` and `pnpm test` before opening a pull request.

To suggest a new city or report a problem, [open an issue](https://github.com/jordanhilado/floodfill/issues).

## License

Code is [MIT](LICENSE). Street and path data is © OpenStreetMap contributors, available under the
[ODbL](https://opendatacommons.org/licenses/odbl/). Neighborhood boundaries:

- San Francisco: DataSF, under the [PDDL](https://opendatacommons.org/licenses/pddl/1-0/)
- Los Angeles: Los Angeles Times Mapping L.A., via the City of Los Angeles GeoHub, under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- New York: NYC Department of City Planning, 2020 Neighborhood Tabulation Areas, via NYC Open Data
- Seattle: City of Seattle Neighborhood Map Atlas, under the
  [PDDL](https://opendatacommons.org/licenses/pddl/1-0/)
