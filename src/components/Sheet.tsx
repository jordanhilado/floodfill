import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

type Detent = 'peek' | 'half' | 'full'
const ORDER: Detent[] = ['peek', 'half', 'full']
/** Room kept above a fully raised sheet for the nav bar (16px inset + 44px bar + a gap). */
const NAV_CLEARANCE = 68
const PHONE = '(max-width: 639px)'

type SheetControls = { collapse: () => void; expand: () => void }
const SheetContext = createContext<SheetControls>({ collapse: () => {}, expand: () => {} })

/** Lowers (after picking something to see on the map) or raises (for typing) the phone sheet. No-ops on desktop. */
export const useSheet = () => useContext(SheetContext)

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Phones: a bottom sheet over the map with three heights. The header (grabber + summary) is
 * always showing at the lowest height and drags the sheet; the body scrolls. Desktop: the same
 * cards as a scrolling column on the left, with no sheet behavior.
 */
export function Sheet({ header, children }: { header: React.ReactNode; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const [phone, setPhone] = useState(false)
  const [detent, setDetent] = useState<Detent>('peek')
  const [heights, setHeights] = useState<Record<Detent, number>>({ peek: 0, half: 0, full: 0 })
  const [dragHeight, setDragHeight] = useState<number | null>(null)

  useEffect(() => {
    const mq = window.matchMedia(PHONE)
    const update = () => setPhone(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Heights follow the viewport and the header's own height (which changes with its content).
  useIsomorphicLayoutEffect(() => {
    if (!phone) return
    const measure = () => {
      const vh = window.visualViewport?.height ?? window.innerHeight
      const peek = Math.round(headerRef.current?.getBoundingClientRect().height ?? 160) + safeAreaBottom()
      const full = Math.max(peek, Math.round(vh - NAV_CLEARANCE))
      setHeights({ peek, half: Math.min(full, Math.max(peek + 160, Math.round(vh * 0.55))), full })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (headerRef.current) ro.observe(headerRef.current)
    window.addEventListener('resize', measure)
    // The on-screen keyboard shrinks only the visual viewport; keep a raised sheet above it.
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [phone])

  const height = dragHeight ?? heights[detent]
  const heightsRef = useRef(heights)
  heightsRef.current = heights
  // The map frames things above the sheet's resting height and lifts its controls over the peek.
  useEffect(() => {
    const el = root.current
    if (!el) return
    if (phone && heights.peek) {
      el.dataset.inset = String(heights[detent])
      document.documentElement.style.setProperty('--sheet-peek', `${heights.peek}px`)
    } else {
      delete el.dataset.inset
      document.documentElement.style.removeProperty('--sheet-peek')
    }
  }, [phone, heights, detent])

  // ── Dragging ──────────────────────────────────────────────────────────────────
  // Moves are tracked on the window once a finger is down, so a fast drag that leaves the
  // header still counts; it only becomes a drag past a few pixels, so taps still click.
  const justDragged = useRef(false)
  const onPointerDown = (e: React.PointerEvent) => {
    if (!phone || (e.pointerType === 'mouse' && e.button !== 0)) return
    const id = e.pointerId
    const startY = e.clientY
    const startH = height
    const { peek: lo, full: hi } = heights
    let moved = false
    let last = { y: e.clientY, t: e.timeStamp }
    let velocity = 0 // px per ms, down is positive

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      const dy = ev.clientY - startY
      if (!moved && Math.abs(dy) < 6) return
      moved = true
      const dt = ev.timeStamp - last.t
      if (dt > 0) velocity = 0.8 * ((ev.clientY - last.y) / dt) + 0.2 * velocity
      last = { y: ev.clientY, t: ev.timeStamp }
      // Resist a little past either end, like a native sheet.
      const raw = startH - dy
      setDragHeight(raw < lo ? lo - (lo - raw) * 0.25 : raw > hi ? hi + (raw - hi) * 0.25 : raw)
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (!moved) return
      // Project the release with its speed so a flick carries on to the next height.
      const projected = startH - (ev.clientY - startY) - velocity * 200
      const nearest = ORDER.reduce((best, k) => (Math.abs(heights[k] - projected) < Math.abs(heights[best] - projected) ? k : best))
      setDetent(nearest)
      setDragHeight(null)
      justDragged.current = true
      setTimeout(() => (justDragged.current = false), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }
  // A drag that ends over a button must not also press it.
  const swallowClickAfterDrag = (e: React.MouseEvent) => {
    if (justDragged.current) {
      e.stopPropagation()
      e.preventDefault()
    }
  }

  const cycle = useCallback(() => setDetent((d) => (d === 'full' ? 'peek' : ORDER[ORDER.indexOf(d) + 1])), [])
  const controls = useMemo<SheetControls>(
    () => ({
      collapse: () => {
        if (!window.matchMedia(PHONE).matches) return
        // The map frames the pick in the same commit, before this component's effects run,
        // so hand it the lowered inset now.
        if (root.current && heightsRef.current.peek) root.current.dataset.inset = String(heightsRef.current.peek)
        setDetent('peek')
      },
      expand: () => {
        if (window.matchMedia(PHONE).matches) setDetent('full')
      },
    }),
    [],
  )
  const body = useRef<HTMLDivElement>(null)
  // Back at the lowest height, the list starts from the top next time.
  useEffect(() => {
    if (detent === 'peek' && body.current) body.current.scrollTop = 0
  }, [detent])

  return (
    <SheetContext.Provider value={controls}>
      <div
        ref={root}
        data-panels
        data-detent={phone ? detent : undefined}
        style={phone && height ? { height } : undefined}
        className={`absolute inset-x-0 bottom-0 z-10 flex h-[calc(168px+env(safe-area-inset-bottom))] flex-col overflow-hidden rounded-t-[16px] bg-surface shadow-[0_0_0_1px_var(--color-line),0_-8px_24px_rgba(0,0,0,0.12)] ${
          dragHeight === null ? 'transition-[height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]' : ''
        } sm:pointer-events-none sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-[60px] sm:h-auto sm:max-h-[calc(100dvh-60px)] sm:w-[400px] sm:gap-2 sm:overflow-y-auto sm:overscroll-contain sm:rounded-none sm:bg-transparent sm:p-4 sm:pb-14 sm:shadow-none sm:transition-none sm:[&>*>*]:pointer-events-auto`}
      >
        <div
          ref={headerRef}
          data-sheet-header
          onPointerDown={onPointerDown}
          onClickCapture={swallowClickAfterDrag}
          className="shrink-0 touch-none select-none sm:contents sm:touch-auto sm:select-auto"
        >
          <button
            type="button"
            onClick={cycle}
            aria-label={detent === 'full' ? 'Lower panel' : 'Raise panel'}
            className="flex h-5 w-full items-center justify-center sm:hidden"
          >
            <span className="h-1 w-9 rounded-full bg-fill-strong" />
          </button>
          {header}
        </div>
        <div
          ref={body}
          data-sheet-body
          className={`min-h-0 flex-1 overscroll-contain pb-[env(safe-area-inset-bottom)] sm:contents ${detent === 'peek' ? 'overflow-hidden' : 'overflow-y-auto'}`}
        >
          {children}
        </div>
      </div>
    </SheetContext.Provider>
  )
}

/** The home-indicator inset, read once from CSS (env() isn't available to script). */
function safeAreaBottom() {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom);visibility:hidden'
  document.body.appendChild(probe)
  const h = probe.getBoundingClientRect().height
  probe.remove()
  return Math.round(h)
}
