import { describe, expect, it } from 'vitest'
import { RateBudgetExhausted, RateLimiter, type Usage } from './rate-limit'

const env = {
  STRAVA_LIMIT_15MIN: '400',
  STRAVA_LIMIT_DAILY: '4000',
  STRAVA_READ_LIMIT_15MIN: '200',
  STRAVA_READ_LIMIT_DAILY: '2000',
  STRAVA_BUDGET_FRACTION: '0.9',
} as Env

/** Minimal D1 stand-in for the `state` table reads/writes the limiter does. */
function fakeDb(initial?: Usage) {
  let stored = initial ? JSON.stringify(initial) : null
  return {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        first: async () => (stored ? { value: stored } : null),
        run: async () => {
          stored = args[1] as string
        },
      }),
    }),
  } as unknown as D1Database
}

const headers = (usage: string, readUsage: string) =>
  new Headers({
    'x-ratelimit-limit': '400,4000',
    'x-ratelimit-usage': usage,
    'x-readratelimit-limit': '200,2000',
    'x-readratelimit-usage': readUsage,
  })

describe('RateLimiter', () => {
  it('stops at its share of the 15-minute read limit even if headers report less', async () => {
    const limiter = await RateLimiter.load(fakeDb(), env)
    let made = 0
    expect(() => {
      for (;;) {
        limiter.check()
        limiter.record(headers('0,0', '0,0'), 200)
        made++
      }
    }).toThrow(RateBudgetExhausted)
    expect(made).toBe(180)
  })

  it('adopts higher usage from headers (other clients share the app limits)', async () => {
    const limiter = await RateLimiter.load(fakeDb(), env)
    limiter.record(headers('190,500', '180,450'), 200)
    expect(() => limiter.check()).toThrow(RateBudgetExhausted)
  })

  it('treats a 429 as an exhausted window', async () => {
    const limiter = await RateLimiter.load(fakeDb(), env)
    limiter.record(new Headers(), 429)
    expect(() => limiter.check()).toThrow(/15-minute/)
  })
})
