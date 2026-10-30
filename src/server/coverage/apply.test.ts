import { describe, expect, it } from 'vitest'
import { chunk } from '../db'
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

  it('replaces the streets and neighborhoods the activity touched, once each', async () => {
    const written: { sql: string; args: unknown[] }[] = []
    const stmt = (sql: string, args: unknown[] = []) => ({
      sql,
      args,
      bind: (...next: unknown[]) => stmt(sql, next),
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    })
    const db = {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: { sql: string; args: unknown[] }[]) => {
        written.push(...stmts)
        return []
      },
    } as unknown as D1Database
    const seg = (id: number, name: string | null, neighborhood: string | null) => [id, { id, name, neighborhood }] as const
    const index = {
      byId: new Map([seg(1, 'Market Street', 'Mission'), seg(2, 'Market Street', 'Castro/Upper Market'), seg(3, null, 'Mission'), seg(4, 'Wiggle', null)]),
    } as unknown as CityIndex

    await applyActivityCoverage(db, index, 'user-1', 42, 'foot', new Map([[1, 1], [2, 1], [3, 1], [4, 1]]))

    expect(written.some((s) => s.sql === 'DELETE FROM activity_groups WHERE activity_id = ?' && s.args[0] === 42)).toBe(true)
    const groups = written
      .filter((s) => s.sql.startsWith('INSERT INTO activity_groups'))
      .flatMap((s) => chunk(s.args, 3))
      .map(([id, kind, key]) => `${id} ${kind} ${key}`)
    expect(groups.sort()).toEqual([
      '42 name Market Street',
      '42 name Wiggle',
      '42 neighborhood Castro/Upper Market',
      '42 neighborhood Mission',
    ])
  })
})
