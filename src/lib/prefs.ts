import { createIsomorphicFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import type { ShareLayout, ShareRankings } from './share-image'
import { SCHEMES, type Scheme, type Theme } from './theme'

export type Unit = 'km' | 'mi'
export type Prefs = { unit: Unit; theme: Theme; scheme: Scheme; shareLayout: ShareLayout; shareRankings: ShareRankings }

const parse = (get: (key: string) => string | undefined): Prefs => {
  const theme = get('theme')
  const scheme = get('scheme')
  const rankings = get('shareRankings')
  return {
    unit: get('unit') === 'mi' ? 'mi' : 'km',
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    scheme: scheme && scheme in SCHEMES ? (scheme as Scheme) : 'classic',
    shareLayout: get('shareLayout') === 'landscape' ? 'landscape' : 'portrait',
    shareRankings: rankings === 'neighborhoods' || rankings === 'streets' ? rankings : 'both',
  }
}

const clientCookie = (key: string) => document.cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`))?.[1]

// Kept in cookies (not localStorage) so the server renders the right view on first load.
export const readPrefs = createIsomorphicFn()
  .server(() => parse(getCookie))
  .client(() => parse(clientCookie))

export function savePref(key: keyof Prefs, value: string) {
  document.cookie = `${key}=${value}; path=/; max-age=31536000; samesite=lax`
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
