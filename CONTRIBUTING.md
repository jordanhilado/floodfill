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

Run `pnpm streets && pnpm db:setup`, then restart `pnpm dev`. Stored activities are matched again
against the new streets on the next sync, without new Strava requests.

## Adding a city

Add an entry to `src/lib/cities.ts`, run `pnpm streets <id>`, add the generated
`src/lib/totals.<id>.json` to `TOTALS` in `src/server/queries.ts`, and load
`db/seed/<id>-segments.sql`.
