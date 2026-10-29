import { Check, Link } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Unit } from '../lib/prefs'
import type { Mode } from '../lib/query-options'
import type { Profile } from '../server/queries'
import { Standing } from './LeaderboardCard'
import { Modal } from './Modal'
import { Segmented } from './Segmented'

const MODES: { value: Mode; label: string }[] = [
  { value: 'foot', label: 'On foot' },
  { value: 'bike', label: 'By bike' },
]

/** Someone's username and where they stand in each city, on foot or by bike. */
export function ProfileDialog({
  handle,
  profile,
  mode: initialMode,
  unit,
  onClose,
}: {
  /** As typed in the URL, for the title when no one uses it. */
  handle: string
  profile: Profile | null
  /** Starts on the mode the map is showing. */
  mode: Mode
  unit: Unit
  onClose: () => void
}) {
  const [mode, setMode] = useState(initialMode)
  const name = `@${profile?.username ?? handle}`
  return (
    <Modal
      open
      onClose={onClose}
      title={name}
      heading={
        <>
          <div className="flex items-center gap-1">
            <h2 className="truncate text-24 font-medium">{name}</h2>
            {profile && <CopyLink username={profile.username} />}
          </div>
          {profile && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-ink-2">
              <span>Joined {profile.joined}</span>
              {profile.x && (
                <ProfileLink href={`https://x.com/${profile.x}`} icon={X_LOGO}>
                  @{profile.x}
                </ProfileLink>
              )}
              {profile.strava && (
                <ProfileLink href={profile.strava} icon={STRAVA_LOGO}>
                  Strava
                </ProfileLink>
              )}
            </p>
          )}
        </>
      }
    >
      {profile ? (
        <>
          <Segmented name="profile-mode" options={MODES} value={mode} onChange={setMode} />
          <ul className="mt-4 divide-y divide-line">
            {profile[mode].map((c) => (
              <li key={c.city} className="py-2 first:pt-0">
                <Standing title={c.name} standing={c} unit={unit} how={mode === 'foot' ? 'on foot' : 'by bike'} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-13 text-ink-2">No one uses this username.</p>
      )}
    </Modal>
  )
}

// Brand marks from Simple Icons (CC0).
const X_LOGO =
  'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z'
const STRAVA_LOGO =
  'M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169'

function ProfileLink({ href, icon, children }: { href: string; icon: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1 text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
    >
      <svg viewBox="0 0 24 24" className="size-3 shrink-0 fill-current" aria-hidden>
        <path d={icon} />
      </svg>
      {children}
    </a>
  )
}

/** Copies the profile's /u/@name link, confirming with a check for a moment. */
function CopyLink({ username }: { username: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = async (button: HTMLButtonElement) => {
    const url = `${location.origin}/u/@${username}`
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // Clipboard API refused (permissions, embedded browsers): copy from a selected field instead.
      // It goes inside the dialog, since everything outside an open modal dialog is inert.
      const field = document.createElement('textarea')
      field.value = url
      field.className = 'fixed opacity-0'
      button.parentElement!.appendChild(field)
      field.select()
      const ok = document.execCommand('copy')
      field.remove()
      if (!ok) return
    }
    setCopied(true)
  }
  return (
    <button
      type="button"
      onClick={(e) => void copy(e.currentTarget)}
      aria-label={copied ? 'Link copied' : 'Copy profile link'}
      title={copied ? 'Copied' : 'Copy link'}
      className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-2 hover:bg-fill-strong hover:text-ink"
    >
      {copied ? <Check size={14} strokeWidth={2} className="text-done" /> : <Link size={14} strokeWidth={2} />}
    </button>
  )
}
