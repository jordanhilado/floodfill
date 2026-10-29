import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { Bike, Footprints } from 'lucide-react'
import { savePref, type Prefs, type Unit } from '../lib/prefs'
import type { Mode } from '../lib/query-options'
import { SCHEMES, type Scheme, type Theme } from '../lib/theme'
import { useResolvedTheme } from '../lib/use-resolved-theme'
import { Modal } from './Modal'
import { ProfileSettings } from './ProfileSettings'
import { Segmented } from './Segmented'
import { logOut } from '../server/functions'
import { StravaSettings } from './StravaSettings'

const MODES: { value: Mode; label: string; detail: string; Icon: typeof Bike }[] = [
  { value: 'foot', label: 'By foot', detail: 'Runs, trail runs, walks, hikes', Icon: Footprints },
  { value: 'bike', label: 'By bike', detail: 'Road, gravel, mountain, e-bike', Icon: Bike },
]

const UNITS: { value: Unit; label: string }[] = [
  { value: 'km', label: 'Kilometers' },
  { value: 'mi', label: 'Miles' },
]

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export function SettingsDialog({
  open,
  onClose,
  mode,
  prefs,
  me,
}: {
  open: boolean
  onClose: () => void
  mode: Mode
  prefs: Prefs
  /** The signed-in user; account and Strava settings only show when there is one. */
  me: { username: string | null; email: string; stravaConnected: boolean; xUsername: string | null; showStrava: boolean } | null
}) {
  const queryClient = useQueryClient()
  const signOut = async () => {
    await logOut()
    onClose()
    await queryClient.invalidateQueries()
    await router.invalidate()
  }
  const { unit } = prefs
  const resolved = useResolvedTheme(prefs.theme)
  const navigate = useNavigate()
  const router = useRouter()

  const setMode = (value: Mode) => navigate({ to: '/', search: (prev) => ({ ...prev, mode: value }), replace: true })
  const setPref = (key: 'unit' | 'theme' | 'scheme', value: string) => {
    savePref(key, value)
    void router.invalidate()
  }
  return (
    <Modal open={open} onClose={onClose} title="Settings">
        {me && (
          <section className="mt-4 flex items-center justify-between gap-3 rounded-[8px] p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <span className="min-w-0">
              <span className="block truncate text-13 font-medium">{me.username ? `@${me.username}` : 'No username yet'}</span>
              <span className="block truncate text-12 text-ink-2">{me.email}</span>
            </span>
            <span className="flex shrink-0 gap-1.5">
              {me.username && (
                <button
                  type="button"
                  onClick={() => {
                    onClose()
                    void navigate({
                      to: '/u/$handle',
                      params: { handle: `@${me.username}` },
                      search: (prev) => ({ ...prev, mode: prev.mode ?? 'foot' }),
                    })
                  }}
                  className="h-8 rounded-full bg-ink px-3 text-13 font-medium text-surface transition-opacity hover:opacity-90"
                >
                  View profile
                </button>
              )}
              <button
                type="button"
                onClick={signOut}
                className="h-8 rounded-full px-3 text-13 text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-fill hover:text-ink"
              >
                Sign out
              </button>
            </span>
          </section>
        )}

        {me?.username && (
          <fieldset className="mt-4">
            <legend className="text-12 text-ink-2">Profile</legend>
            <ProfileSettings me={me} />
          </fieldset>
        )}

        <fieldset className="mt-4">
          <legend className="text-12 text-ink-2">Count progress</legend>
          <div className="mt-2 grid gap-2">
            {MODES.map(({ value, label, detail, Icon }) => (
              <label
                key={value}
                className={`flex cursor-pointer items-center gap-3 rounded-[8px] p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-done ${
                  mode === value ? 'bg-fill shadow-[inset_0_0_0_1px_var(--color-ink)]' : 'shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-fill'
                }`}
              >
                <input
                  type="radio"
                  name="mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                  className="sr-only"
                />
                <Icon size={20} strokeWidth={1.75} className={mode === value ? 'text-ink' : 'text-ink-2'} />
                <span>
                  <span className="block text-13 font-medium">{label}</span>
                  <span className="block text-12 text-ink-2">{detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="text-12 text-ink-2">Units</legend>
          <Segmented name="unit" options={UNITS} value={unit} onChange={(v) => setPref('unit', v)} />
        </fieldset>

        <fieldset className="mt-4">
          <legend className="text-12 text-ink-2">Theme</legend>
          <Segmented name="theme" options={THEMES} value={prefs.theme} onChange={(v) => setPref('theme', v)} />
        </fieldset>

        <fieldset className="mt-4">
          <legend className="text-12 text-ink-2">Line colors</legend>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(Object.keys(SCHEMES) as Scheme[]).map((key) => {
              const c = SCHEMES[key][resolved]
              const active = prefs.scheme === key
              return (
                <label
                  key={key}
                  className={`flex cursor-pointer flex-col gap-2 rounded-[8px] p-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-done ${
                    active ? 'bg-fill shadow-[inset_0_0_0_1px_var(--color-ink)]' : 'shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-fill'
                  }`}
                >
                  <input
                    type="radio"
                    name="scheme"
                    value={key}
                    checked={active}
                    onChange={() => setPref('scheme', key)}
                    className="sr-only"
                  />
                  {/* Done, to go, selected */}
                  <span className="flex gap-1" aria-hidden>
                    {[c.done, c.todo, c.selected].map((color) => (
                      <span key={color} className="h-1 flex-1 rounded-full" style={{ background: color }} />
                    ))}
                  </span>
                  <span className={`text-13 ${active ? 'font-medium text-ink' : 'text-ink-2'}`}>{SCHEMES[key].label}</span>
                </label>
              )
            })}
          </div>
        </fieldset>

        {me && (
          <fieldset className="mt-4">
            <legend className="text-12 text-ink-2">Strava</legend>
            <div className="mt-2">
              <StravaSettings />
            </div>
          </fieldset>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-5 flex h-9 w-full items-center justify-center rounded-full bg-ink text-13 font-medium text-surface transition-opacity hover:opacity-90"
        >
          Done
        </button>
    </Modal>
  )
}
