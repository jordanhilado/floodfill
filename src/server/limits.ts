import { getRequest } from '@tanstack/react-start/server'

/**
 * Per-client request limits, from the Workers rate limiting bindings in wrangler.jsonc. Counts are
 * kept per Cloudflare location and are approximate: they stop floods, not the odd extra request.
 */
export async function allow(limiter: RateLimit | undefined, key: string) {
  // Unit tests run without the bindings.
  if (!limiter) return true
  const { success } = await limiter.limit({ key })
  return success
}

/** The client's address, as Cloudflare saw it. */
export const ipKey = () => `ip:${getRequest().headers.get('cf-connecting-ip') ?? 'unknown'}`

/** Headers every response carries: HTTPS only, no framing, no MIME sniffing, a quiet referrer. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  // Limits what an injected tag could do without restricting the app's own scripts, styles,
  // map tiles or workers.
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
}
