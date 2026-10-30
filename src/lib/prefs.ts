import { createIsomorphicFn } from '@tanstack/react-start'
import { getCookie, getRequest, setCookie } from '@tanstack/react-start/server'
import type { ShareLayout, ShareRankings } from './share-image'
import { SCHEMES, type Scheme, type Theme } from './theme'

export type Unit = 'km' | 'mi'
export type Prefs = { unit: Unit; theme: Theme; scheme: Scheme; shareLayout: ShareLayout; shareRankings: ShareRankings }

const PREF_MAX_AGE = 31536000

/** Where road distances are signed in miles: the US and its territories, the UK, Liberia and Myanmar. */
const MILE_COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'GB', 'LR', 'MM'])

/** Cloudflare's codes for an unknown country and for Tor. */
const NO_COUNTRY = new Set(['XX', 'T1'])

/** Miles where they're used or when the country is unknown, kilometers everywhere else. */
export const unitForCountry = (country: string | null | undefined): Unit =>
  country && !NO_COUNTRY.has(country) && !MILE_COUNTRIES.has(country) ? 'km' : 'mi'

const parse = (get: (key: string) => string | undefined, defaultUnit: Unit): Prefs => {
  const unit = get('unit')
  const theme = get('theme')
  const scheme = get('scheme')
  const rankings = get('shareRankings')
  return {
    unit: unit === 'km' || unit === 'mi' ? unit : defaultUnit,
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    scheme: scheme && scheme in SCHEMES ? (scheme as Scheme) : 'classic',
    shareLayout: get('shareLayout') === 'landscape' ? 'landscape' : 'portrait',
    shareRankings: rankings === 'neighborhoods' || rankings === 'streets' ? rankings : 'both',
  }
}

const clientCookie = (key: string) => document.cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`))?.[1]

// Kept in cookies (not localStorage) so the server renders the right view on first load.
export const readPrefs = createIsomorphicFn()
  .server(() => {
    // A first visit gets units for the country Cloudflare places the request in, saved as the
    // visitor's choice so the browser (which can't see the country) reads the same.
    // (Cloudflare's `cf` request metadata isn't on the DOM Request type.)
    const { cf } = getRequest() as unknown as { cf?: { country?: string } }
    const prefs = parse(getCookie, unitForCountry(cf?.country))
    if (!getCookie('unit')) setCookie('unit', prefs.unit, { path: '/', maxAge: PREF_MAX_AGE, sameSite: 'lax' })
    return prefs
  })
  .client(() => parse(clientCookie, 'mi'))

export function savePref(key: keyof Prefs, value: string) {
  document.cookie = `${key}=${value}; path=/; max-age=${PREF_MAX_AGE}; samesite=lax`
}

export function formatDistance(meters: number, unit: Unit) {
  const v = unit === 'mi' ? meters / 1609.344 : meters / 1000
  // Short streets would otherwise read "0.0 of 0.0 mi".
  const digits = v > 0 && v < 1 ? 2 : 1
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

export function formatPercent(pct: number) {
  return `${pct > 0 && pct < 10 ? pct.toFixed(2) : pct.toFixed(1)}%`
}
