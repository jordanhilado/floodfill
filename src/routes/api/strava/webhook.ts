import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

type StravaEvent = {
  object_type: 'activity' | 'athlete'
  object_id: number
  aspect_type: 'create' | 'update' | 'delete'
  /** The athlete's id. */
  owner_id: number
}

/**
 * Strava's webhook (developers.strava.com/docs/webhooks). It tells us who has a new, changed or
 * deleted activity, so the cron syncs those athletes instead of polling everyone. Strava doesn't
 * sign its calls, so an event only flags work that is checked with Strava: the next sync lists
 * the athlete's activities, and a deletion is confirmed before anything is removed.
 *
 * Off until STRAVA_WEBHOOK_TOKEN is set. Then subscribe once per Strava app (see CONTRIBUTING.md).
 */
export const Route = createFileRoute('/api/strava/webhook')({
  server: {
    handlers: {
      // Strava checks the callback URL when the subscription is created.
      GET: ({ request }) => {
        const params = new URL(request.url).searchParams
        const token = env.STRAVA_WEBHOOK_TOKEN
        if (!token || params.get('hub.mode') !== 'subscribe' || params.get('hub.verify_token') !== token) {
          return new Response('Forbidden', { status: 403 })
        }
        return Response.json({ 'hub.challenge': params.get('hub.challenge') })
      },

      // Strava wants a 200 within two seconds, so this only records the event.
      POST: async ({ request }) => {
        if (!env.STRAVA_WEBHOOK_TOKEN) return new Response(null, { status: 404 })
        const event = (await request.json().catch(() => null)) as StravaEvent | null
        if (!event || !Number.isSafeInteger(event.owner_id) || !Number.isSafeInteger(event.object_id)) {
          return new Response(null, { status: 400 })
        }
        if (event.object_type === 'activity' && event.aspect_type === 'delete') {
          // Only activities we hold for that athlete, so made-up events can't queue up work.
          await env.DB.prepare(
            `INSERT INTO strava_deletions (activity_id, athlete_id, received_at)
             SELECT a.id, sa.athlete_id, ? FROM activities a JOIN strava_accounts sa ON sa.user_id = a.user_id
             WHERE a.id = ? AND sa.athlete_id = ?
             ON CONFLICT(activity_id) DO NOTHING`,
          )
            .bind(Date.now(), event.object_id, event.owner_id)
            .run()
        } else {
          // A new or changed activity, or the athlete revoked access: listing their activities on
          // the next sync picks up the first two and finds out about the third.
          await env.DB.prepare('UPDATE strava_accounts SET pending_sync = 1 WHERE athlete_id = ?').bind(event.owner_id).run()
        }
        return new Response(null, { status: 200 })
      },
    },
  },
})
