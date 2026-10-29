import { useSyncExternalStore } from 'react'
import type { ResolvedTheme, Theme } from './theme'

const query = '(prefers-color-scheme: dark)'

const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(query)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

/** Light or dark after applying "system". The server assumes light; CSS handles first paint. */
export function useResolvedTheme(theme: Theme): ResolvedTheme {
  const systemDark = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
  if (theme === 'system') return systemDark ? 'dark' : 'light'
  return theme
}
