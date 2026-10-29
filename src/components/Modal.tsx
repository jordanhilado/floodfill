import { X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

/**
 * Centered card dialog used for Settings, Info and the city picker. Native <dialog> gives focus
 * trapping, Escape to close and an inert background; a tap on the backdrop closes it too.
 */
export function Modal({
  open,
  onClose,
  title,
  heading,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** Replaces the plain title in the header; `title` still names the dialog. */
  heading?: React.ReactNode
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      // A custom heading may hold buttons, so name the dialog by its title instead.
      aria-labelledby={heading ? undefined : titleId}
      aria-label={heading ? title : undefined}
      className="m-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[380px] overflow-y-auto overscroll-contain rounded-[16px] bg-surface p-0 text-ink shadow-[0_0_0_1px_var(--color-line),0_16px_48px_rgba(41,41,41,0.16)] backdrop:bg-black/20"
    >
      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          {heading ? (
            <div className="min-w-0">{heading}</div>
          ) : (
            <h2 id={titleId} className="text-14 font-medium">
              {title}
            </h2>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title.toLowerCase()}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-2 hover:bg-fill-strong hover:text-ink"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}
