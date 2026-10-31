import { deleteCookie, getCookie, getRequest, setCookie } from '@tanstack/react-start/server'

/**
 * Passwordless accounts: a 6-digit code sent by email signs you in, creating the account on first
 * use. Usernames are chosen once, are unique (ignoring case), and also work for signing in.
 */

const CODE_TTL_MS = 10 * 60 * 1000
const CODE_RESEND_MS = 30 * 1000
const MAX_ATTEMPTS = 5
// Wrong guesses carry over to new codes until an hour passes without one being sent, so asking
// for a fresh code doesn't buy more guesses.
const LOCKOUT_MS = 60 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE = 'ff_session'

export const USERNAME_RULES = '3–20 letters, numbers, _ or ., starting with a letter or number'
const USERNAME_RE = /^[a-z0-9][a-z0-9_.]{2,19}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type User = { id: string; email: string; username: string | null }

export class AuthError extends Error {}

const now = () => Date.now()

async function sha256(input: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const codeHash = (env: Env, email: string, code: string) => sha256(`${env.AUTH_SECRET}:${email}:${code}`)

/** j•••@gmail.com, so a username sign-in doesn't reveal the whole address. */
export function maskEmail(email: string) {
  const [name, domain] = email.split('@')
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(name.length - 1, 6)))}@${domain}`
}

/** Resolves "email or username" to an email address. */
async function resolveEmail(db: D1Database, identifier: string) {
  const id = identifier.trim()
  if (id.includes('@')) {
    if (!EMAIL_RE.test(id)) throw new AuthError('Enter a valid email address.')
    return id.toLowerCase()
  }
  const user = await db.prepare('SELECT email FROM users WHERE username = ?').bind(id).first<{ email: string }>()
  if (!user) throw new AuthError('No account uses that username. Sign in with your email instead.')
  return user.email
}

/** Emails a sign-in code. Works for new and existing accounts alike. */
export async function startSignIn(env: Env, identifier: string) {
  const db = env.DB
  const email = await resolveEmail(db, identifier)
  const pending = await db
    .prepare('SELECT sent_at, attempts FROM login_codes WHERE email = ?')
    .bind(email)
    .first<{ sent_at: number; attempts: number }>()
  if (pending && pending.attempts >= MAX_ATTEMPTS && now() - pending.sent_at < LOCKOUT_MS) {
    throw new AuthError('Too many wrong codes. Try again in an hour.')
  }
  if (pending && now() - pending.sent_at < CODE_RESEND_MS) {
    throw new AuthError('A code was just sent. Wait a few seconds before asking for another.')
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')
  await db
    .prepare(
      `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
         attempts = CASE WHEN excluded.sent_at - login_codes.sent_at < ? THEN login_codes.attempts ELSE 0 END,
         sent_at = excluded.sent_at`,
    )
    .bind(email, await codeHash(env, email, code), now() + CODE_TTL_MS, now(), LOCKOUT_MS)
    .run()

  try {
    await sendCode(env, email, code)
  } catch (err) {
    // E.g. the sender domain isn't set up for sending yet. Void the code that never arrived but
    // keep the row, so its wrong-guess count still applies. The binding's errors carry a string
    // `code` (E_SENDER_NOT_VERIFIED, ...); log it, since Workers logs keep only an error's stack.
    const { code: errCode, message } = (err ?? {}) as { code?: string; message?: string }
    console.error(`[floodfill] sign-in email failed: ${errCode ?? 'no code'} ${message ?? String(err)}`)
    await db.prepare('UPDATE login_codes SET expires_at = 0 WHERE email = ?').bind(email).run()
    throw new AuthError("Couldn't send your sign-in code right now. Try again later.")
  }
  // Local development simulates email; print the code so the flow can be tested without an inbox.
  if (import.meta.env.DEV) console.log(`[floodfill] sign-in code for ${email}: ${code}`)

  // Only the masked address goes back for a username sign-in, so usernames don't reveal emails.
  return { sentTo: identifier.includes('@') ? email : maskEmail(email) }
}

function sendCode(env: Env, email: string, code: string) {
  return env.EMAIL.send({
    to: email,
    from: { email: env.EMAIL_FROM, name: 'floodfill.world' },
    subject: `${code} is your floodfill.world code`,
    text: `Your floodfill.world sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#292929;letter-spacing:-0.15px">
  <p style="font-size:14px;margin:0 0 16px">Your floodfill.world sign-in code:</p>
  <p style="font-size:24px;font-weight:500;letter-spacing:4px;margin:0 0 16px">${code}</p>
  <p style="font-size:13px;color:#5D5D5D;margin:0">It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>
</div>`,
  })
}

/** Checks the code, creates the account if needed, and starts a session. */
export async function verifySignIn(env: Env, identifier: string, code: string) {
  const db = env.DB
  const email = await resolveEmail(db, identifier)
  const row = await db
    .prepare('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?')
    .bind(email)
    .first<{ code_hash: string; expires_at: number; attempts: number }>()
  if (row && row.attempts >= MAX_ATTEMPTS) throw new AuthError('Too many wrong codes. Try again in an hour.')
  if (!row || row.expires_at < now()) throw new AuthError('That code has expired. Ask for a new one.')
  if ((await codeHash(env, email, code.trim())) !== row.code_hash) {
    await db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run()
    throw new AuthError('That code is not right. Check the email and try again.')
  }
  await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run()

  let user = await db.prepare('SELECT id, email, username FROM users WHERE email = ?').bind(email).first<User>()
  if (!user) {
    user = { id: crypto.randomUUID(), email, username: null }
    await db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(user.id, email, now()).run()
  }

  const token = randomToken()
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), user.id, now() + SESSION_TTL_MS, now())
    .run()
  setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(getRequest().url).protocol === 'https:',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
  return user
}

/** The signed-in user for this request, or null. */
export async function currentUser(db: D1Database): Promise<User | null> {
  const token = getCookie(SESSION_COOKIE)
  if (!token) return null
  return db
    .prepare(
      `SELECT u.id, u.email, u.username FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(await sha256(token), now())
    .first<User>()
}

export async function requireUser(db: D1Database) {
  const user = await currentUser(db)
  if (!user) throw new AuthError('Sign in first.')
  return user
}

export async function signOut(db: D1Database) {
  const token = getCookie(SESSION_COOKIE)
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run()
  deleteCookie(SESSION_COOKIE, { path: '/' })
}

/** Deletes expired sessions, and sign-in codes past both their expiry and the lockout window. */
export async function pruneAuth(db: D1Database) {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
    db.prepare('DELETE FROM login_codes WHERE expires_at < ? AND sent_at < ?').bind(now(), now() - LOCKOUT_MS),
  ])
}

export async function usernameAvailability(db: D1Database, username: string, userId?: string) {
  if (!USERNAME_RE.test(username)) return { available: false, reason: `Use ${USERNAME_RULES}.` }
  const taken = await db
    .prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string }>()
  if (taken && taken.id !== userId) return { available: false, reason: 'That username is taken.' }
  return { available: true, reason: null }
}

export async function setUsername(db: D1Database, user: User, username: string) {
  const check = await usernameAvailability(db, username, user.id)
  if (!check.available) throw new AuthError(check.reason ?? 'That username is not available.')
  try {
    await db.prepare('UPDATE users SET username = ? WHERE id = ?').bind(username, user.id).run()
  } catch {
    // Lost a race for the same name: the unique index caught it.
    throw new AuthError('That username is taken.')
  }
  return { ...user, username }
}
