import { DOMAIN } from '../../lib/brand'
import { getState, setState } from '../db'

/**
 * Strava caps how many athletes can connect to the app (STRAVA_ATHLETE_LIMIT, from the app's
 * page at strava.com/settings/api). Athletes connected outside production also count
 * (STRAVA_ATHLETES_ELSEWHERE). Past the cap, Strava refuses new connections, so new people are
 * asked to import a Strava export instead and join a waitlist for when the cap is raised.
 */
export type StravaCapacity = { connected: number; limit: number; full: boolean }

const FULL_KEY = 'strava_full'

export async function stravaCapacity(env: Env): Promise<StravaCapacity> {
  // Unset means no limit. 0 means full, which is handy for trying the full state locally.
  const limit = env.STRAVA_ATHLETE_LIMIT ? Number(env.STRAVA_ATHLETE_LIMIT) : Infinity
  const [row, refused] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM strava_accounts').first<{ n: number }>(),
    getState<{ limit: number }>(env.DB, FULL_KEY),
  ])
  const connected = (row?.n ?? 0) + (Number(env.STRAVA_ATHLETES_ELSEWHERE) || 0)
  // Strava refused a connection at this limit: it counts athletes we can't see. Raising the
  // limit (once Strava raises the app's) clears it.
  return { connected, limit, full: connected >= limit || (refused !== null && refused.limit >= limit) }
}

/** Strava refused a connection for being over the limit, whatever our own count says. */
export function markStravaFull(env: Env) {
  return setState(env.DB, FULL_KEY, { limit: Number(env.STRAVA_ATHLETE_LIMIT) || 0 })
}

/** Adds someone to the waitlist (once). */
export async function joinWaitlist(db: D1Database, userId: string) {
  await db
    .prepare('INSERT INTO strava_waitlist (user_id, created_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING')
    .bind(userId, Date.now())
    .run()
}

/**
 * Emails waitlisted people, oldest first and as many as there are open places, once Strava
 * connections are open again. People who connected in the meantime are skipped. Runs with the cron.
 */
export async function notifyWaitlist(env: Env) {
  const { connected, limit, full } = await stravaCapacity(env)
  if (full) return 0
  const open = Math.min(50, Number.isFinite(limit) ? limit - connected : 50)
  const { results } = await env.DB.prepare(
    `SELECT w.user_id, u.email FROM strava_waitlist w JOIN users u ON u.id = w.user_id
     WHERE w.notified_at IS NULL AND NOT EXISTS (SELECT 1 FROM strava_accounts sa WHERE sa.user_id = w.user_id)
     ORDER BY w.created_at LIMIT ?`,
  )
    .bind(open)
    .all<{ user_id: string; email: string }>()
  let sent = 0
  for (const { user_id, email } of results) {
    try {
      await sendOpenEmail(env, email)
    } catch (err) {
      const { code, message } = (err ?? {}) as { code?: string; message?: string }
      console.error(`[floodfill] waitlist email failed: ${code ?? 'no code'} ${message ?? String(err)}`)
      continue
    }
    await env.DB.prepare('UPDATE strava_waitlist SET notified_at = ? WHERE user_id = ?').bind(Date.now(), user_id).run()
    sent++
  }
  return sent
}

function sendOpenEmail(env: Env, email: string) {
  const url = `https://${DOMAIN}`
  return env.EMAIL.send({
    to: email,
    from: { email: env.EMAIL_FROM, name: 'Floodfill' },
    subject: 'You can connect Strava to Floodfill now',
    text: `Floodfill can connect to Strava again. Open ${url}, then Settings, and connect your Strava account to keep your map up to date automatically.`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#292929;letter-spacing:-0.15px">
  <p style="font-size:14px;margin:0 0 16px">Floodfill can connect to Strava again.</p>
  <p style="font-size:14px;margin:0 0 16px">Open <a href="${url}" style="color:#292929">${DOMAIN}</a>, then Settings, and connect your Strava account to keep your map up to date automatically.</p>
</div>`,
  })
}
