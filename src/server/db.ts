/** D1 allows at most 100 bound parameters per statement. */
export const MAX_PARAMS = 100

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function getState<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare('SELECT value FROM state WHERE key = ?').bind(key).first<{ value: string }>()
  return row ? (JSON.parse(row.value) as T) : null
}

export function setStateStmt(db: D1Database, key: string, value: unknown) {
  return db
    .prepare(
      'INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .bind(key, JSON.stringify(value), Date.now())
}

export async function setState(db: D1Database, key: string, value: unknown) {
  await setStateStmt(db, key, value).run()
}
