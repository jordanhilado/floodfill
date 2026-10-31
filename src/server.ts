import handler from '@tanstack/react-start/server-entry'
import { notifyWaitlist } from './server/strava/capacity'
import { runSync } from './server/sync'

export default {
  fetch: (request) => handler.fetch(request),

  // Continues backfill and picks up new activities every 15 minutes, right after
  // Strava's rate window resets. Cron invocations allow long wall-clock runs.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runSync(env, { trigger: 'cron', timeBudgetMs: 5 * 60_000 }).then((r) => console.log('cron sync', JSON.stringify(r))),
    )
    // Tell waitlisted people once Strava connections open up (see strava/capacity.ts).
    ctx.waitUntil(
      notifyWaitlist(env)
        .then((n) => n > 0 && console.log('waitlist emailed', n))
        .catch((err) => console.error('waitlist failed', err)),
    )
  },
} satisfies ExportedHandler<Env>
