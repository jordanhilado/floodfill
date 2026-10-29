import { describe, expect, it } from 'vitest'
import { applyActivityCoverage } from './apply'
import type { CityIndex } from './segments'

/** Stand-in for D1 that enforces its 100-bound-parameter limit on every statement. */
function strictDb() {
  let maxParams = 0
  const stmt = (args: unknown[] = []) => {
    maxParams = Math.max(maxParams, args.length)
    if (args.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${args.length})`)
    return {
      bind: (...next: unknown[]) => stmt(next),
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    }
  }
  const db = { prepare: () => stmt(), batch: async () => [] } as unknown as D1Database
  return { db, maxParams: () => maxParams }
}

describe('applyActivityCoverage', () => {
  it('keeps every statement within D1’s 100-parameter limit for long activities', async () => {
    const { db, maxParams } = strictDb()
    const masks = new Map(Array.from({ length: 300 }, (_, i) => [i + 1, 1] as [number, number]))
    const index = { byId: new Map() } as unknown as CityIndex
    await applyActivityCoverage(db, index, 'user-1', 42, 'foot', masks)
    expect(maxParams()).toBeLessThanOrEqual(100)
  })
})
