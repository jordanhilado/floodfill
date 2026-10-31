import { createFileRoute } from '@tanstack/react-router'
import { getCookie } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { currentUser } from '../../../server/auth'
import { joinWaitlist, markStravaFull } from '../../../server/strava/capacity'
import { exchangeCode, isAthleteLimitError } from '../../../server/strava/client'

/** Strava sends people back here after they approve (or decline) access. */
export const Route = createFileRoute('/api/strava/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        // The state cookie is single use: every way out clears it.
        const back = (status: string) =>
          new Response(null, {
            status: 302,
            headers: {
              Location: `${url.origin}/?strava=${status}`,
              'Set-Cookie': `ff_oauth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`,
            },
          })

        if (url.searchParams.get('error')) return back('denied')
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        if (!code || !state || state !== getCookie('ff_oauth_state')) return back('error')
        const user = await currentUser(env.DB)
        if (!user) return back('signin')
        if (!(url.searchParams.get('scope') ?? '').includes('activity:read')) return back('scope')

        let token: Awaited<ReturnType<typeof exchangeCode>>
        try {
          token = await exchangeCode(env, code)
        } catch (err) {
          if (!isAthleteLimitError(err)) return back('error')
          // Strava counts athletes we can't see; trust it over our own count.
          await Promise.all([markStravaFull(env), joinWaitlist(env.DB, user.id)])
          return back('full')
        }
        const athleteId = token.athlete?.id
        if (!athleteId) return back('error')

        const owner = await env.DB.prepare('SELECT user_id FROM strava_accounts WHERE athlete_id = ?')
          .bind(athleteId)
          .first<{ user_id: string }>()
        if (owner && owner.user_id !== user.id) return back('taken')

        await env.DB.prepare(
          `INSERT INTO strava_accounts (user_id, athlete_id, access_token, refresh_token, expires_at, scope, connected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET athlete_id = excluded.athlete_id, access_token = excluded.access_token,
             refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope`,
        )
          .bind(user.id, athleteId, token.access_token, token.refresh_token, token.expires_at, url.searchParams.get('scope'), Date.now())
          .run()
        return back('connected')
      },
    },
  },
})
