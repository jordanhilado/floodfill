import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { ProfileDialog } from '../../../components/ProfileDialog'
import { profileQuery } from '../../../lib/query-options'

const username = (handle: string) => handle.replace(/^@/, '')

// A profile, e.g. /u/@jhilado, opened over the map. /u/jhilado redirects to the @ form.
export const Route = createFileRoute('/_map/u/$handle')({
  beforeLoad: ({ params, search }) => {
    if (!params.handle.startsWith('@')) {
      throw redirect({ to: '/u/$handle', params: { handle: `@${params.handle}` }, search, replace: true })
    }
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(profileQuery(username(params.handle))),
  head: ({ params }) => ({ meta: [{ title: `${params.handle} · Floodfill` }] }),
  component: ProfileRoute,
})

function ProfileRoute() {
  const { handle } = Route.useParams()
  const { mode } = Route.useSearch()
  const { prefs } = Route.useRouteContext()
  const { data: profile } = useSuspenseQuery(profileQuery(username(handle)))
  const navigate = useNavigate()
  return (
    <ProfileDialog
      handle={username(handle)}
      profile={profile}
      mode={mode}
      unit={prefs.unit}
      onClose={() => void navigate({ to: '/', search: (prev) => ({ ...prev, mode: prev.mode ?? 'foot' }) })}
    />
  )
}
