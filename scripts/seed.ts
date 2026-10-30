/**
 * Loads street seeds into D1: every city in db/seed, or the ones named.
 *
 *   node scripts/seed.ts [cityId...] [--remote]
 *
 * Locally this follows the migrations in `pnpm db:setup`. With --remote it loads production, which
 * a new or rebuilt city needs before the change that ships its totals is deployed.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const remote = args.includes('--remote')
const named = args.filter((a) => !a.startsWith('--'))
const cities = named.length
  ? named
  : readdirSync(path.join(root, 'db/seed'))
      .filter((f) => f.endsWith('-segments.sql'))
      .map((f) => f.slice(0, -'-segments.sql'.length))

for (const city of cities) {
  console.log(`Seeding ${city} (${remote ? 'remote' : 'local'})`)
  execFileSync('wrangler', ['d1', 'execute', 'floodfill', remote ? '--remote' : '--local', `--file=db/seed/${city}-segments.sql`], {
    cwd: root,
    stdio: 'inherit',
    // wrangler is a .cmd shim on Windows.
    shell: process.platform === 'win32',
  })
}
