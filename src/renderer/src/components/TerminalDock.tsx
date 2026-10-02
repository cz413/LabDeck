import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const HEIGHT_KEY = 'labdeck.terminal-dock-height'
const DEFAULT_HEIGHT = 330
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const readHeight = (): number => {
  try {
    const height = Number(localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(height) && height > 0 ? height : DEFAULT_HEIGHT
  } catch { return DEFAULT_HEIGHT }
}
const saveHeight = (height: number): void => {
  try { localStorage.setItem(HEIGHT_KEY, String(Math.round(height))) } catch { /* Resizing also works without storage. */ }
}

export function TerminalDock({ expanded, fullscreen, children }: { expanded: boolean; fullscreen: boolean; children: ReactNode }): React.JSX.Element {
  const dockRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ pointerId: number; y: number; height: number } | null>(null)
  const [preferredHeight, setPreferredHeight] = useState(readHeight)
  const [availableHeight, setAvailableHeight] = useState(0)
  const [resizing, setResizing] = useState(false)
  const maxHeight = Math.max(0, Math.round(availableHeight - Math.min(160, availableHeight * .35)))
  const minHeight = Math.min(180, maxHeight)
  const height = clamp(preferredHeight, minHeight, maxHeight)
  const heightRef = useRef(height)
  heightRef.current = height

  useLayoutEffect(() => {
    const main = dockRef.current?.parentElement
    if (!main) return
    const measure = (): void => setAvailableHeight(main.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(main)
    return () => observer.disconnect()
  }, [])

  const finishResize = (): void => {
    if (!dragRef.current) return
    dragRef.current = null
    saveHeight(heightRef.current)
    setResizing(false)
  }

  useEffect(() => {
    if (!resizing) return
    const cursor = document.body.style.cursor
    const userSelect = document.body.style.userSelect
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('blur', finishResize)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)
    return () => {
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
      window.removeEventListener('blur', finishResize)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
    }
  }, [resizing])

  useEffect(() => { if (!expanded || fullscreen) finishResize() }, [expanded, fullscreen])

  const setHeight = (value: number, persist = false): void => {
    const next = clamp(value, minHeight, maxHeight)
    heightRef.current = next
    setPreferredHeight(next)
    if (persist) saveHeight(next)
  }

  return <section ref={dockRef} className={`workbench-terminal-dock ${expanded ? 'expanded' : 'collapsed'} ${fullscreen ? 'fullscreen' : ''} ${resizing ? 'resizing' : ''}`} aria-label="终端工作区"
    style={expanded && !fullscreen ? { height, flexBasis: height } : undefined}>
    {expanded && !fullscreen && <div className="workbench-dock-resizer" role="separator" tabIndex={0} aria-label="调整终端高度" aria-orientation="horizontal"
      aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={Math.round(height)} aria-valuetext={`${Math.round(height)} 像素`}
      title="拖动调整终端高度；双击恢复默认；方向键微调"
      onPointerDown={(event) => {
        if (event.button !== 0 || dragRef.current) return
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragRef.current = { pointerId: event.pointerId, y: event.clientY, height }
        setResizing(true)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (drag?.pointerId === event.pointerId) setHeight(drag.height + drag.y - event.clientY)
      }}
      onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize}
      onDoubleClick={() => setHeight(DEFAULT_HEIGHT, true)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 24
        const next = event.key === 'ArrowUp' ? height + step : event.key === 'ArrowDown' ? height - step : event.key === 'Home' ? minHeight : event.key === 'End' ? maxHeight : null
        if (next !== null) { event.preventDefault(); setHeight(next, true) }
      }}><span /></div>}
    {children}
  </section>
}
