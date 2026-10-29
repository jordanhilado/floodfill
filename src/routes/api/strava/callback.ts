import { createFileRoute } from '@tanstack/react-router'
import { getCookie } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { currentUser } from '../../../server/auth'
import { exchangeCode } from '../../../server/strava/client'

/** Strava sends people back here after they approve (or decline) access. */
export const Route = createFileRoute('/api/strava/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const back = (status: string) => Response.redirect(`${url.origin}/?strava=${status}`, 302)

        if (url.searchParams.get('error')) return back('denied')
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        if (!code || !state || state !== getCookie('ff_oauth_state')) return back('error')
        const user = await currentUser(env.DB)
        if (!user) return back('signin')
        if (!(url.searchParams.get('scope') ?? '').includes('activity:read')) return back('scope')

        const token = await exchangeCode(env, code).catch(() => null)
        const athleteId = token?.athlete?.id
        if (!token || !athleteId) return back('error')

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
