import type { QueryClient } from '@tanstack/react-query'
import { HeadContent, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import { readPrefs } from '../lib/prefs'
import { THEME_CSS } from '../lib/theme'
import appCss from '../styles.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Re-read on router.invalidate() after a setting changes.
  beforeLoad: () => ({ prefs: readPrefs() }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      // The map route names the city.
      { title: 'floodfill.world · Street coverage' },
      { name: 'description', content: 'How much of your city you have covered, from your Strava activities.' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      // The tab icon follows the OS appearance; the app's own theme can't reach it.
      { rel: 'icon', href: '/favicon-light.png', type: 'image/png', media: '(prefers-color-scheme: light)' },
      { rel: 'icon', href: '/favicon-dark.png', type: 'image/png', media: '(prefers-color-scheme: dark)' },
      { rel: 'apple-touch-icon', href: '/logo-light.png' },
      { rel: 'preconnect', href: 'https://tiles.openfreemap.org' },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <main className="flex h-dvh items-center justify-center text-14 text-ink-2">
      <a href="/" className="underline underline-offset-2 hover:text-ink">
        Page not found. Back to the map
      </a>
    </main>
  ),
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { prefs } = Route.useRouteContext()
  return (
    <html lang="en" data-theme={prefs.theme} data-scheme={prefs.scheme}>
      <head>
        {/* Theme × palette tokens, generated from src/lib/theme.ts */}
        <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
