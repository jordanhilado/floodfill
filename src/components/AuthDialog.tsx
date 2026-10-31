import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Check, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { checkUsername, chooseUsername, confirmCode, requestCode, startStravaConnect } from '../server/functions'
import { syncStatusQuery } from '../lib/query-options'
import { Modal } from './Modal'
import { StravaFull } from './StravaImport'

export type AuthStep = 'identify' | 'code' | 'username' | 'strava'

const TITLES: Record<AuthStep, string> = {
  identify: 'Get started',
  code: 'Check your email',
  username: 'Choose a username',
  strava: 'Connect Strava',
}

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong. Try again.')

/**
 * One flow for signing in and signing up: email or username → emailed code → (new accounts)
 * username → connect Strava now or later.
 */
export function AuthDialog({ open, onClose, start = 'identify' }: { open: boolean; onClose: () => void; start?: AuthStep }) {
  const [step, setStep] = useState<AuthStep>(start)
  const [identifier, setIdentifier] = useState('')
  const [sentTo, setSentTo] = useState('')
  const queryClient = useQueryClient()
  const router = useRouter()

  useEffect(() => {
    if (open) setStep(start)
  }, [open, start])

  // Who is signed in changed: refetch everything for the new user. (Not resetQueries: that
  // suspends the page, which would remount it and close this dialog mid-flow.)
  const refreshSession = async () => {
    await queryClient.invalidateQueries()
    await router.invalidate()
  }

  return (
    <Modal open={open} onClose={onClose} title={TITLES[step]}>
      {step === 'identify' && (
        <IdentifyStep
          identifier={identifier}
          setIdentifier={setIdentifier}
          onSent={(to) => {
            setSentTo(to)
            setStep('code')
          }}
        />
      )}
      {step === 'code' && (
        <CodeStep
          identifier={identifier}
          sentTo={sentTo}
          onBack={() => setStep('identify')}
          onVerified={async ({ needsUsername, stravaConnected }) => {
            await refreshSession()
            if (needsUsername) setStep('username')
            else if (!stravaConnected) setStep('strava')
            else onClose()
          }}
        />
      )}
      {step === 'username' && (
        <UsernameStep
          onDone={async () => {
            await refreshSession()
            setStep('strava')
          }}
        />
      )}
      {step === 'strava' && <StravaStep onLater={onClose} />}
    </Modal>
  )
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: React.ReactNode
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <label className="mt-3 block">
      <span className="text-12 text-ink-2">{label}</span>
      {children}
      {error ? <span className="mt-1.5 block text-12 text-[#C0392B]">{error}</span> : hint && <span className="mt-1.5 block text-12 text-ink-2">{hint}</span>}
    </label>
  )
}

const inputClass =
  'mt-1.5 h-10 w-full rounded-[8px] bg-fill px-3 text-14 text-ink outline-none placeholder:text-ink-3 focus-visible:ring-2 focus-visible:ring-done'

function Primary({ busy, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...props}
      className={`mt-4 flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-ink text-14 font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40 ${props.className ?? ''}`}
    >
      {busy && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  )
}

function IdentifyStep({
  identifier,
  setIdentifier,
  onSent,
}: {
  identifier: string
  setIdentifier: (v: string) => void
  onSent: (sentTo: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await requestCode({ data: { identifier } })
      onSent(res.sentTo)
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <p className="mt-2 text-13 text-ink-2">Sign in or create an account. We'll email you a 6-digit code.</p>
      <Field label="Email or username" error={error}>
        <input
          className={inputClass}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="you@example.com"
          autoComplete="username email"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
        />
      </Field>
      <Primary type="submit" busy={busy} disabled={busy || !identifier.trim()}>
        Continue
      </Primary>
    </form>
  )
}

function CodeStep({
  identifier,
  sentTo,
  onBack,
  onVerified,
}: {
  identifier: string
  sentTo: string
  onBack: () => void
  onVerified: (r: { needsUsername: boolean; stravaConnected: boolean }) => Promise<void>
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState<'idle' | 'sent' | string>('idle')
  const [canResend, setCanResend] = useState(false)
  const submitted = useRef('')

  useEffect(() => {
    const t = setTimeout(() => setCanResend(true), 30_000)
    return () => clearTimeout(t)
  }, [resent])

  const verify = async (value: string) => {
    if (submitted.current === value) return
    submitted.current = value
    setBusy(true)
    setError(null)
    try {
      await onVerified(await confirmCode({ data: { identifier, code: value } }))
    } catch (err) {
      setError(message(err))
      submitted.current = ''
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void verify(code)
      }}
    >
      <p className="mt-2 text-13 text-ink-2">
        We sent a code to <span className="text-ink">{sentTo}</span>. It expires in 10 minutes.
      </p>
      <Field label="6-digit code" error={error}>
        <input
          className={`${inputClass} text-center tabular-nums tracking-[0.3em]`}
          value={code}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6)
            setCode(v)
            // Submit as soon as the last digit arrives (typed, pasted or autofilled).
            if (v.length === 6) void verify(v)
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          aria-label="6-digit code"
          autoFocus
        />
      </Field>
      <Primary type="submit" busy={busy} disabled={busy || code.length !== 6}>
        Verify
      </Primary>
      <div className="mt-3 flex justify-between text-12">
        <button type="button" onClick={onBack} className="text-ink-2 hover:text-ink">
          Use a different email
        </button>
        <button
          type="button"
          disabled={!canResend}
          onClick={async () => {
            setCanResend(false)
            try {
              await requestCode({ data: { identifier } })
              setResent('sent')
            } catch (err) {
              setResent(message(err))
            }
          }}
          className="text-ink-2 hover:text-ink disabled:text-ink-3"
        >
          {resent === 'sent' ? 'Code sent again' : 'Resend code'}
        </button>
      </div>
      {resent !== 'idle' && resent !== 'sent' && <p className="mt-2 text-12 text-[#C0392B]">{resent}</p>}
    </form>
  )
}

function UsernameStep({ onDone }: { onDone: () => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [debounced, setDebounced] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(username.trim()), 300)
    return () => clearTimeout(t)
  }, [username])
  const check = useQuery({
    queryKey: ['username-check', debounced],
    queryFn: () => checkUsername({ data: { username: debounced } }),
    enabled: debounced.length > 0,
    staleTime: 10_000,
  })
  const ready = debounced === username.trim() && check.data?.available === true

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await chooseUsername({ data: { username: username.trim() } })
      await onDone()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const hint = !debounced ? (
    'Shown on the leaderboard. You can also sign in with it.'
  ) : check.isFetching || debounced !== username.trim() ? (
    'Checking…'
  ) : check.data?.available ? (
    <span className="flex items-center gap-1 text-ink">
      <Check size={14} strokeWidth={2} className="text-done" /> {debounced} is available
    </span>
  ) : (
    check.data?.reason
  )

  return (
    <form onSubmit={submit}>
      <Field label="Username" hint={hint} error={error}>
        <input
          className={inputClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="sunset_runner"
          autoCapitalize="none"
          autoComplete="username"
          spellCheck={false}
          maxLength={20}
          autoFocus
        />
      </Field>
      <Primary type="submit" busy={busy} disabled={busy || !ready}>
        Continue
      </Primary>
    </form>
  )
}

function StravaStep({ onLater }: { onLater: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data: status } = useQuery(syncStatusQuery())
  if (status?.stravaFull) {
    return (
      <div className="mt-3">
        <StravaFull />
        <button type="button" onClick={onLater} className="mt-2 h-10 w-full rounded-full text-14 text-ink-2 hover:bg-fill-strong hover:text-ink">
          Later
        </button>
      </div>
    )
  }
  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const { url } = await startStravaConnect()
      window.location.assign(url)
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }
  return (
    <div>
      <p className="mt-2 text-13 text-ink-2">
        Floodfill reads your Strava activities to work out which paths you've covered. It never posts or
        changes anything.
      </p>
      {error && <p className="mt-2 text-12 text-[#C0392B]">{error}</p>}
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className="mt-4 flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-[#FC4C02] text-14 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        Connect with Strava
      </button>
      <button type="button" onClick={onLater} className="mt-2 h-10 w-full rounded-full text-14 text-ink-2 hover:bg-fill-strong hover:text-ink">
        Later
      </button>
    </div>
  )
}
