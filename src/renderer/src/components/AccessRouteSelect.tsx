import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { ServerProfile } from '@shared/types'
import { getAccessRoute, getAccessRoutes } from '@shared/access-routes'

interface AccessRouteSelectProps {
  server: ServerProfile
  value: string
  onChange(routeId: string): void
  compact?: boolean
}

export function AccessRouteSelect({ server, value, onChange, compact = false }: AccessRouteSelectProps): React.JSX.Element | null {
  const routes = getAccessRoutes(server)
  const selectedRoute = getAccessRoute(server, value)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = `access-route-menu-${server.id}-${compact ? 'compact' : 'full'}`

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  if (routes.length <= 1) return null

  const chooseRoute = (routeId: string): void => {
    onChange(routeId)
    setOpen(false)
  }

  return <div ref={rootRef} className={`access-route-select route-${selectedRoute.kind} ${compact ? 'compact' : ''} ${open ? 'open' : ''}`}>
    <button
      type="button"
      className="access-route-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={menuId}
      title="选择这台服务器的连接路径"
      onClick={() => setOpen((current) => !current)}
    >
      <i className="access-route-indicator" aria-hidden="true" />
      <span className="access-route-caption">{compact ? '连接' : '连接路径'}</span>
      <strong>{selectedRoute.name}</strong>
      <ChevronDown className="access-route-chevron" size={14} aria-hidden="true" />
    </button>
    {open && <div id={menuId} className="access-route-menu" role="listbox" aria-label={`${server.name} 连接路径`}>
      {routes.map((route) => {
        const selected = route.id === selectedRoute.id
        return <button
          type="button"
          role="option"
          aria-selected={selected}
          className={`access-route-option route-${route.kind} ${selected ? 'selected' : ''}`}
          key={route.id}
          onClick={() => chooseRoute(route.id)}
        >
          <i className="access-route-indicator" aria-hidden="true" />
          <span>
            <strong>{route.name}</strong>
            <small>{route.kind === 'jump' ? '通过跳板机访问' : '使用服务器默认地址'}</small>
          </span>
          {selected && <Check size={14} aria-hidden="true" />}
        </button>
      })}
    </div>}
  </div>
}
