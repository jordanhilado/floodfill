# Contributing

Thanks for helping with floodfill.world. See the [README](README.md) to set up and run the app locally.

## Branches

Name branches `<type>/<short-description>`, in lowercase kebab-case:

```
feat/street-search
fix/sign-in-email-errors
perf/d1-rows-read
```

Branch off `main`, keep one change per branch, and open a pull request back into `main`.

## Pull request titles

Titles follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>
```

- **type**: one of the types below, matching the branch.
- **scope** (optional): the area of the app, such as `auth`, `sync`, `strava`, `db`, `map`,
  `rankings`, `streets` or `ui`.
- **summary**: imperative and lowercase, with no trailing period, under about 70 characters.

```
feat(rankings): add an activities sort to the street list
fix(auth): log the email binding's error code on failed sign-in
perf(db): cut D1 rows read per page view
```

Pull requests are squash-merged, so the title becomes the commit message on `main`.

| Type | For |
| --- | --- |
| `feat` | A new feature or user-facing behavior |
| `fix` | A bug fix |
| `perf` | A performance or cost improvement with no behavior change |
| `refactor` | A code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation only |
| `test` | Adding or fixing tests |
| `chore` | Tooling, dependencies, config or data rebuilds |
| `ci` | CI and workflow changes |

## Before opening a pull request

Run `pnpm typecheck` and `pnpm test`. If you rebuilt the street network, commit everything
`pnpm streets` regenerated together (see below). Fill in the pull request template: what changed,
how you tested it, and anything a reviewer should know.

## Rebuilding the street network

Run `pnpm streets <city> && pnpm seed <city>`, then restart `pnpm dev`. Stored activities in that
city are matched again as soon as the map is opened (or by the next cron sync), without new Strava
requests.

## Adding a city

1. Add an entry to `CITIES` in `src/lib/cities.ts`. Give it the next free `idBase` (a multiple of
   10,000,000) so its segment ids don't collide with another city's, and its official
   neighborhood boundaries and their credit.
2. Run `pnpm streets <city>`. It writes the map data (split into parts under Cloudflare's file size
   limit), the seed, the totals and the neighborhood bounds. `pnpm test` checks they agree.
3. Run `pnpm seed <city>` locally. Before the pull request is merged, load the seed into production
   with `pnpm seed <city> --remote`. Once the pull request is deployed, the first visit to the map
   (or the next cron sync) credits everyone's existing activities in the city, including ones
   skipped before the city existed.

## Strava webhooks

Without webhooks, the cron lists every connected athlete's activities every 15 minutes. Strava's
default read limit (2,000 requests a day) only covers a few dozen athletes on that schedule. With
webhooks, Strava tells the app who has a new, changed or deleted activity. The cron then syncs
only those athletes, plus anyone still importing their history, plus a weekly check of everyone
else.

To turn them on in production:

1. Pick a random token and set it: `openssl rand -hex 16`, then `wrangler secret put STRAVA_WEBHOOK_TOKEN`.
2. Deploy, so `/api/strava/webhook` answers Strava's check.
3. Subscribe once for the Strava app. Strava allows one subscription per app:

   ```sh
   curl -X POST https://www.strava.com/api/v3/push_subscriptions \
     -F client_id=$STRAVA_CLIENT_ID -F client_secret=$STRAVA_CLIENT_SECRET \
     -F callback_url=https://floodfill.world/api/strava/webhook -F verify_token=$STRAVA_WEBHOOK_TOKEN
   ```

   To see or remove the subscription, send a `GET` or `DELETE` request to the same URL with `client_id` and
   `client_secret`.
