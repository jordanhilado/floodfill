import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { updateProfileLinks } from '../server/functions'

const X_USERNAME = /^[A-Za-z0-9_]{1,15}$/

/** Links on your public profile: an X username and whether to show your Strava (lives in Settings). */
export function ProfileSettings({ me }: { me: { stravaConnected: boolean; xUsername: string | null; showStrava: boolean } }) {
  const queryClient = useQueryClient()
  const update = useMutation({
    mutationFn: (data: { xUsername?: string; showStrava?: boolean }) => updateProfileLinks({ data }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['me'] }),
        queryClient.invalidateQueries({ queryKey: ['profile'] }),
      ]),
  })

  const [x, setX] = useState(me.xUsername ?? '')
  const typed = x.trim().replace(/^@/, '')
  const invalid = typed !== '' && !X_USERNAME.test(typed)
  const changed = typed !== (me.xUsername ?? '')
  const saveX = (e: React.FormEvent) => {
    e.preventDefault()
    if (changed && !invalid) update.mutate({ xUsername: typed })
  }

  return (
    <div className="mt-2 rounded-[8px] px-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <form onSubmit={saveX} className="py-3">
        <label htmlFor="x-username" className="text-13 font-medium">
          X username
        </label>
        <div className="mt-1.5 flex gap-2">
          <div className="flex h-9 min-w-0 flex-1 items-center rounded-[8px] bg-fill px-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-done">
            <span className="text-14 text-ink-3" aria-hidden>
              @
            </span>
            <input
              id="x-username"
              value={x}
              onChange={(e) => setX(e.target.value)}
              placeholder="username"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={16}
              aria-invalid={invalid}
              className="h-full min-w-0 flex-1 bg-transparent pl-0.5 text-14 text-ink outline-none placeholder:text-ink-3"
            />
          </div>
          {changed && (
            <button
              type="submit"
              disabled={invalid || update.isPending}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-ink px-4 text-13 font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {update.isPending && <Loader2 size={14} className="animate-spin" />}
              {typed ? 'Save' : 'Remove'}
            </button>
          )}
        </div>
        <p className={`mt-1.5 text-12 ${invalid ? 'text-[#C0392B]' : 'text-ink-2'}`}>
          {invalid ? 'Use 1–15 letters, numbers or underscores.' : 'Linked on your profile.'}
        </p>
      </form>

      <div className="flex items-center justify-between gap-3 border-t border-line py-3">
        <span id="show-strava" className="min-w-0">
          <span className="block text-13 font-medium">Show Strava</span>
          <span className="block text-12 text-ink-2">
            {me.stravaConnected ? 'Link your Strava athlete page on your profile.' : 'Connect Strava first.'}
          </span>
        </span>
        <Switch
          labelledBy="show-strava"
          checked={me.stravaConnected && me.showStrava}
          disabled={!me.stravaConnected || update.isPending}
          onChange={(showStrava) => update.mutate({ showStrava })}
        />
      </div>
      {update.isError && <p className="pb-3 text-12 text-[#C0392B]">Couldn't save. Try again.</p>}
    </div>
  )
}

function Switch({
  checked,
  disabled,
  onChange,
  labelledBy,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  labelledBy: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-done disabled:opacity-40 ${
        checked ? 'bg-done' : 'bg-fill-strong'
      }`}
    >
      <span
        aria-hidden
        className={`absolute left-0.5 top-0.5 size-5 rounded-full bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}
