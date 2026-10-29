import { getState, setState } from '../db'

const WINDOW_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export type Limits = { all15: number; allDay: number; read15: number; readDay: number }

export type Usage = Limits & {
  /** Index of the 15-minute window (Strava resets at :00, :15, :30, :45 UTC). */
  window: number
  /** UTC day index (Strava resets daily limits at midnight UTC). */
  day: number
  limits: Limits
}

export class RateBudgetExhausted extends Error {
  resetAt: number
  constructor(resetAt: number, detail: string) {
    super(`Strava rate budget exhausted (${detail})`)
    this.resetAt = resetAt
  }
}

export function limitsFromEnv(env: Env): Limits {
  return {
    all15: Number(env.STRAVA_LIMIT_15MIN),
    allDay: Number(env.STRAVA_LIMIT_DAILY),
    read15: Number(env.STRAVA_READ_LIMIT_15MIN),
    readDay: Number(env.STRAVA_READ_LIMIT_DAILY),
  }
}

/**
 * Tracks Strava API usage against the app's rate limits. Strava reports exact usage
 * in response headers, so local counts are only an estimate between requests.
 * Every request here is a GET, so it counts against both the overall and read limits.
 */
export class RateLimiter {
  usage: Usage
  private fraction: number
  requests = 0

  private constructor(usage: Usage, fraction: number) {
    this.usage = usage
    this.fraction = fraction
  }

  static async load(db: D1Database, env: Env) {
    const stored = await getState<Usage>(db, 'strava_usage')
    const limits = limitsFromEnv(env)
    const usage: Usage = stored ?? { all15: 0, allDay: 0, read15: 0, readDay: 0, window: 0, day: 0, limits }
    // Start from the configured limits each run; response headers can only tighten them.
    usage.limits = limits
    const limiter = new RateLimiter(usage, Number(env.STRAVA_BUDGET_FRACTION) || 0.9)
    limiter.roll(Date.now())
    return limiter
  }

  save(db: D1Database) {
    return setState(db, 'strava_usage', this.usage)
  }

  /** Resets counters when a new window/day has started. */
  private roll(now: number) {
    const window = Math.floor(now / WINDOW_MS)
    const day = Math.floor(now / DAY_MS)
    if (window !== this.usage.window) {
      this.usage.window = window
      this.usage.all15 = 0
      this.usage.read15 = 0
    }
    if (day !== this.usage.day) {
      this.usage.day = day
      this.usage.allDay = 0
      this.usage.readDay = 0
    }
  }

  budget() {
    const f = this.fraction
    const l = this.usage.limits
    return {
      read15: Math.floor(l.read15 * f),
      readDay: Math.floor(l.readDay * f),
      all15: Math.floor(l.all15 * f),
      allDay: Math.floor(l.allDay * f),
    }
  }

  /** Throws if another request would exceed the app's share of any limit. */
  check(now = Date.now()) {
    this.roll(now)
    const b = this.budget()
    const u = this.usage
    if (u.readDay >= b.readDay || u.allDay >= b.allDay) {
      throw new RateBudgetExhausted((this.usage.day + 1) * DAY_MS, 'daily')
    }
    if (u.read15 >= b.read15 || u.all15 >= b.all15) {
      throw new RateBudgetExhausted((this.usage.window + 1) * WINDOW_MS, '15-minute')
    }
  }

  /** Records a completed request, preferring Strava's own numbers when present. */
  record(headers: Headers, status: number) {
    this.requests++
    const u = this.usage
    u.all15++
    u.allDay++
    u.read15++
    u.readDay++
    const pair = (name: string) => {
      const v = headers.get(name)
      if (!v) return null
      const [a, b] = v.split(',').map((x) => Number(x.trim()))
      return Number.isFinite(a) && Number.isFinite(b) ? ([a, b] as const) : null
    }
    const limit = pair('x-ratelimit-limit')
    const usage = pair('x-ratelimit-usage')
    const readLimit = pair('x-readratelimit-limit')
    const readUsage = pair('x-readratelimit-usage')
    if (limit) [u.limits.all15, u.limits.allDay] = [Math.min(u.limits.all15, limit[0]), Math.min(u.limits.allDay, limit[1])]
    if (readLimit) [u.limits.read15, u.limits.readDay] = [Math.min(u.limits.read15, readLimit[0]), Math.min(u.limits.readDay, readLimit[1])]
    // Strava's usage headers can lag behind (observed reporting 82 after ~330 requests in
    // one window), so only let them raise our own count, never lower it. Higher values
    // still matter: they include requests from other clients using the same app.
    if (usage) [u.all15, u.allDay] = [Math.max(u.all15, usage[0]), Math.max(u.allDay, usage[1])]
    if (readUsage) [u.read15, u.readDay] = [Math.max(u.read15, readUsage[0]), Math.max(u.readDay, readUsage[1])]
    if (status === 429) {
      // Strava says we're over; treat the current window as spent.
      u.all15 = Math.max(u.all15, u.limits.all15)
      u.read15 = Math.max(u.read15, u.limits.read15)
    }
  }

  snapshot(now = Date.now()) {
    this.roll(now)
    return {
      read15: this.usage.read15,
      readDay: this.usage.readDay,
      budget: this.budget(),
      limits: this.usage.limits,
      windowResetAt: (this.usage.window + 1) * WINDOW_MS,
      dayResetAt: (this.usage.day + 1) * DAY_MS,
    }
  }
}
