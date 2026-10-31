import { RateLimiter } from './rate-limit'

const API = 'https://www.strava.com/api/v3'
const OAUTH = 'https://www.strava.com/oauth'

/** Scopes the app asks for: all activities, including private ones. */
export const STRAVA_SCOPES = 'read,activity:read_all'

export type StravaSummaryActivity = {
  id: number
  name: string
  sport_type: string
  start_date: string
  distance: number
  moving_time: number
  map?: { summary_polyline?: string | null }
}

/** A user's row in strava_accounts. */
export type StravaAccount = {
  user_id: string
  athlete_id: number
  access_token: string
  refresh_token: string
  expires_at: number
  backfill_before: number | null
  backfill_done: number
}

export class StravaError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The athlete revoked access (or the tokens are otherwise dead): only reconnecting fixes it. */
export class StravaAuthError extends StravaError {}

/** The app's Strava API credentials (each user connects their own account through OAuth). */
export function stravaConfigured(env: Env) {
  return Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET)
}

export function authorizeUrl(env: Env, redirectUri: string, state: string) {
  const url = new URL(`${OAUTH}/authorize`)
  url.search = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    approval_prompt: 'auto',
    scope: STRAVA_SCOPES,
    state,
  }).toString()
  return url.toString()
}

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_at: number
  athlete?: { id: number }
}

async function tokenRequest(env: Env, body: Record<string, string>) {
  const res = await fetch(`${OAUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, ...body }),
  })
  if (!res.ok) throw new StravaError(res.status, `Strava token request failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as TokenResponse
}

/** Trades the OAuth callback code for tokens and the athlete id. */
export function exchangeCode(env: Env, code: string) {
  return tokenRequest(env, { code, grant_type: 'authorization_code' })
}

/** Strava turned a connection away because the app is at its limit of connected athletes. */
export const isAthleteLimitError = (err: unknown) =>
  err instanceof StravaError && err.status === 403 && /limit of connected athletes/i.test(err.message)
/** API client for one user's Strava account. Every call goes through the app-wide rate limiter. */
export class StravaClient {
  private db: D1Database
  private env: Env
  private account: StravaAccount
  limiter: RateLimiter

  constructor(db: D1Database, env: Env, limiter: RateLimiter, account: StravaAccount) {
    this.db = db
    this.env = env
    this.limiter = limiter
    this.account = account
  }

  /** Access tokens last 6 hours; Strava may rotate the refresh token, so both are saved back. */
  private async accessToken(force = false) {
    if (!force && this.account.expires_at * 1000 > Date.now() + 5 * 60 * 1000) return this.account.access_token
    const t = await tokenRequest(this.env, { grant_type: 'refresh_token', refresh_token: this.account.refresh_token }).catch((err) => {
      // A refused refresh token means the athlete revoked access; server errors are worth retrying.
      throw err instanceof StravaError && (err.status === 400 || err.status === 401) ? new StravaAuthError(err.status, err.message) : err
    })
    this.account = { ...this.account, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at }
    await this.db
      .prepare('UPDATE strava_accounts SET access_token = ?, refresh_token = ?, expires_at = ? WHERE user_id = ?')
      .bind(t.access_token, t.refresh_token, t.expires_at, this.account.user_id)
      .run()
    return t.access_token
  }

  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(API + path)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

    for (let attempt = 0; attempt < 2; attempt++) {
      this.limiter.check()
      const res = await fetch(url, { headers: { authorization: `Bearer ${await this.accessToken(attempt > 0)}` } })
      this.limiter.record(res.headers, res.status)
      if (res.status === 429) this.limiter.check() // throws RateBudgetExhausted
      if (!res.ok) {
        const body = await res.text()
        if (res.status === 401 && body.includes('read_permission')) {
          throw new StravaError(401, 'Strava access is missing the activity permission. Reconnect Strava and allow activity access.')
        }
        if (res.status === 401 && attempt === 0) continue
        throw new StravaError(res.status, `GET ${path} → ${res.status} ${body}`)
      }
      return (await res.json()) as T
    }
    throw new StravaAuthError(401, `GET ${path} → unauthorized`)
  }

  listActivities(params: { before?: number; after?: number; page?: number; per_page?: number }) {
    return this.get<StravaSummaryActivity[]>('/athlete/activities', { per_page: 200, ...params })
  }

  /** Whether Strava still has this activity, asked as its owner. */
  async activityExists(id: number) {
    try {
      await this.get(`/activities/${id}`)
      return true
    } catch (err) {
      if (err instanceof StravaError && err.status === 404) return false
      throw err
    }
  }

  async latlngStream(id: number): Promise<[number, number][] | null> {
    const streams = await this.get<{ latlng?: { data: [number, number][] } }>(`/activities/${id}/streams`, {
      keys: 'latlng',
      key_by_type: 'true',
    })
    return streams.latlng?.data ?? null
  }
}
