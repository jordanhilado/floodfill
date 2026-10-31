import { createServerFn } from '@tanstack/react-start'
import { getRequest, setCookie } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { CITY_IDS } from '../lib/cities'
import { IMPORT_BATCH, STRAVA_FULL_MESSAGE } from '../lib/strava-export'
import {
  AuthError,
  currentUser,
  requireUser,
  setUsername,
  signOut,
  startSignIn,
  usernameAvailability,
  verifySignIn,
} from './auth'
import {
  getCoverageData,
  getLeaderboard,
  getNeighborhoodData,
  getPersonalStandings,
  getProfile,
  getProfileMaps,
  getStreetDetail,
  getStreetPage,
  getSyncStatusData,
} from './queries'
import { allow, ipKey } from './limits'
import { authorizeUrl, stravaConfigured } from './strava/client'
import { joinWaitlist, stravaCapacity } from './strava/capacity'
import { importActivities, runRematch, runSync, type SyncResult } from './sync'

const mode = z.enum(['foot', 'bike'])
const city = z.enum(CITY_IDS)
const userId = async () => (await currentUser(env.DB))?.id ?? null

/** Sign-in attempts from one address: a cap on emails sent and codes guessed, on top of the per-email limits. */
async function limitSignIn() {
  if (!(await allow(env.AUTH_LIMITER, ipKey()))) throw new AuthError('Too many tries. Wait a minute and try again.')
}

// ── Account ──────────────────────────────────────────────────────────────────

/** The signed-in user and whether their Strava account is connected, or null. */
export const getMe = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await currentUser(env.DB)
  if (!user) return null
  const [strava, links, activity] = await Promise.all([
    env.DB.prepare('SELECT 1 AS x FROM strava_accounts WHERE user_id = ?').bind(user.id).first(),
    env.DB.prepare('SELECT x_username, show_strava FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ x_username: string | null; show_strava: number }>(),
    env.DB.prepare('SELECT 1 AS x FROM activities WHERE user_id = ? LIMIT 1').bind(user.id).first(),
  ])
  return {
    username: user.username,
    email: user.email,
    stravaConnected: strava !== null,
    /** Has activities, from Strava or an imported export. */
    hasActivities: activity !== null,
    xUsername: links?.x_username ?? null,
    showStrava: links?.show_strava === 1,
  }
})

export const requestCode = createServerFn({ method: 'POST' })
  .validator(z.object({ identifier: z.string().trim().min(1).max(254) }))
  .handler(async ({ data }) => {
    await limitSignIn()
    return startSignIn(env, data.identifier)
  })

export const confirmCode = createServerFn({ method: 'POST' })
  .validator(z.object({ identifier: z.string().trim().min(1).max(254), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') }))
  .handler(async ({ data }) => {
    await limitSignIn()
    const user = await verifySignIn(env, data.identifier, data.code)
    const strava = await env.DB.prepare('SELECT 1 AS x FROM strava_accounts WHERE user_id = ?').bind(user.id).first()
    return { needsUsername: user.username === null, stravaConnected: strava !== null }
  })

export const checkUsername = createServerFn({ method: 'GET' })
  .validator(z.object({ username: z.string().max(40) }))
  .handler(async ({ data }) => usernameAvailability(env.DB, data.username, (await userId()) ?? undefined))

export const chooseUsername = createServerFn({ method: 'POST' })
  .validator(z.object({ username: z.string().max(40) }))
  .handler(async ({ data }) => {
    const user = await setUsername(env.DB, await requireUser(env.DB), data.username)
    return { username: user.username }
  })

/** Links shown on your public profile. An empty X username removes it. */
export const updateProfileLinks = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      // X handles: 1–15 letters, numbers or underscores. A leading @ is fine.
      xUsername: z
        .string()
        .trim()
        .transform((v) => v.replace(/^@/, ''))
        .refine((v) => v === '' || /^[A-Za-z0-9_]{1,15}$/.test(v), 'Use 1–15 letters, numbers or underscores.')
        .optional(),
      showStrava: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser(env.DB)
    if (data.xUsername !== undefined) {
      await env.DB.prepare('UPDATE users SET x_username = ? WHERE id = ?').bind(data.xUsername || null, user.id).run()
    }
    if (data.showStrava !== undefined) {
      await env.DB.prepare('UPDATE users SET show_strava = ? WHERE id = ?').bind(data.showStrava ? 1 : 0, user.id).run()
    }
  })

export const logOut = createServerFn({ method: 'POST' }).handler(() => signOut(env.DB))

/**
 * Starts Strava OAuth. A one-time state value in a short-lived cookie ties the callback to this
 * browser (see routes/api/strava/callback.ts).
 */
export const startStravaConnect = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireUser(env.DB)
  if (!stravaConfigured(env)) throw new Error('Strava is not configured on this server.')
  // Someone already connected can reconnect: they hold a place under the limit already.
  const [capacity, account] = await Promise.all([
    stravaCapacity(env),
    env.DB.prepare('SELECT 1 AS x FROM strava_accounts WHERE user_id = ?').bind(user.id).first(),
  ])
  if (capacity.full && !account) {
    await joinWaitlist(env.DB, user.id)
    throw new Error(STRAVA_FULL_MESSAGE)
  }
  const url = new URL(getRequest().url)
  const state = crypto.randomUUID()
  setCookie('ff_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    path: '/',
    maxAge: 10 * 60,
  })
  return { url: authorizeUrl(env, `${url.origin}/api/strava/callback`, state) }
})

// ── Progress ─────────────────────────────────────────────────────────────────

export const getCoverage = createServerFn({ method: 'GET' })
  .validator(z.object({ city, mode }))
  .handler(async ({ data }) => getCoverageData(env.DB, data.city, data.mode, await userId()))

export const getNeighborhoods = createServerFn({ method: 'GET' })
  .validator(z.object({ city, mode }))
  .handler(async ({ data }) => getNeighborhoodData(env.DB, data.city, data.mode, await userId()))

export const getStreets = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      city,
      mode,
      q: z.string().max(80).default(''),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
      sort: z.enum(['progress', 'activities']).default('progress'),
    }),
  )
  .handler(async ({ data }) => getStreetPage(env.DB, data.city, data.mode, await userId(), data))

export const getStreet = createServerFn({ method: 'GET' })
  .validator(z.object({ city, mode, name: z.string().max(200).optional(), segmentId: z.number().int().optional() }))
  .handler(async ({ data }) =>
    getStreetDetail(
      env.DB,
      data.city,
      data.mode,
      await userId(),
      data.name !== undefined ? { name: data.name } : { segmentId: data.segmentId ?? -1 },
    ),
  )

export const getLeaderboardFn = createServerFn({ method: 'GET' })
  .validator(z.object({ city, mode }))
  .handler(async ({ data }) => getLeaderboard(env.DB, data.city, data.mode, await userId()))

export const getStandings = createServerFn({ method: 'GET' })
  .validator(z.object({ mode }))
  .handler(async ({ data }) => {
    const id = await userId()
    return id ? getPersonalStandings(env.DB, data.mode, id) : []
  })

export const getProfileFn = createServerFn({ method: 'GET' })
  .validator(z.object({ username: z.string().min(1).max(40) }))
  .handler(({ data }) => getProfile(env.DB, data.username))

/** Images of the paths someone has completed in each city, for one mode. */
export const getProfileMapsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ username: z.string().min(1).max(40), mode }))
  .handler(({ data }) => getProfileMaps(env.DB, data.username, data.mode))

// ── Sync ─────────────────────────────────────────────────────────────────────

export const getSyncStatus = createServerFn({ method: 'GET' }).handler(async () =>
  getSyncStatusData(env.DB, env, await userId()),
)

/**
 * Runs one bounded sync batch for the signed-in user. The client calls this repeatedly while the
 * batch stops for time (more work left), and backs off when the rate budget is spent.
 */
export const syncNow = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireUser(env.DB)
  // Reported like another sync holding the lock.
  if (!(await allow(env.SYNC_LIMITER, `user:${user.id}`))) {
    return { stopReason: 'busy', resumeAt: null, requests: 0, listed: 0, detailed: 0, rematched: 0, error: null } satisfies SyncResult
  }
  return runSync(env, { trigger: 'manual', timeBudgetMs: 20_000, userId: user.id })
})

/** Puts the signed-in user on the list to be emailed when Strava connections open again. */
export const joinStravaWaitlist = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireUser(env.DB)
  await joinWaitlist(env.DB, user.id)
})

/** Stores and credits one batch of activities from the signed-in user's Strava export. */
export const importStravaBatch = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      activities: z
        .array(
          z.object({
            id: z.number().int().positive(),
            name: z.string().max(300),
            sportType: z.string().max(40),
            startDate: z.iso.datetime(),
            distanceM: z.number().min(0),
            movingTimeS: z.number().int().min(0),
            polyline: z.string().max(500_000),
          }),
        )
        .max(IMPORT_BATCH),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser(env.DB)
    return { added: await importActivities(env.DB, user.id, data.activities) }
  })

/**
 * Runs one bounded batch of re-matching after a city opens or its network is rebuilt. Pages call
 * this for every visitor while a rematch is pending: it makes no Strava requests, and once there
 * is nothing left to match it is a single read.
 */
export const rematchNow = createServerFn({ method: 'POST' }).handler(async () => {
  // Anyone can call this, so cap it per address. Busy makes the client wait and retry.
  if (!(await allow(env.REMATCH_LIMITER, ipKey()))) return { stopReason: 'busy' as const, rematched: 0 }
  return runRematch(env, 20_000)
})
