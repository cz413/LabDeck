import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Code2, FolderOpen, Laptop, Plus, Server, SquareTerminal, X } from 'lucide-react'
import type { ServerProfile } from '@shared/types'
import { getAccessRoute, getAccessRoutes } from '@shared/access-routes'
import { TerminalPanel } from './TerminalPanel'
import type { ConfirmationRequest } from './ConfirmDialog'

export interface LocalTerminalSession {
  id: string
  name: string
  type: 'local'
}

export interface ServerTerminalSession {
  id: string
  name: string
  type: 'server'
  server: ServerProfile
  accessRouteId: string
  currentPath: string
  initialCommand?: string
}

export type TerminalWorkspaceSession = LocalTerminalSession | ServerTerminalSession

interface TerminalWorkspaceProps {
  sessions: TerminalWorkspaceSession[]
  activeId: string | null
  visible: boolean
  servers: ServerProfile[]
  accessRouteIdFor(server: ServerProfile): string
  onActivate(sessionId: string): void
  onAdd(server: ServerProfile, accessRouteId: string): void
  onAddLocal(): void
  onClose(sessionId: string): void
  onOpenVsCode(server: ServerProfile, accessRouteId: string): void
  vscodeConnectingId: string | null
  onOpenFiles(session: ServerTerminalSession): void
  onOpenServerFiles(server: ServerProfile, accessRouteId: string): void
  onWorkingDirectory(sessionId: string, path: string): void
  onTrusted(): Promise<void>
  confirm(request: ConfirmationRequest): Promise<boolean>
}

export function ServerTerminalWorkspace({
  sessions,
  activeId,
  visible,
  servers,
  accessRouteIdFor,
  onActivate,
  onAdd,
  onAddLocal,
  onClose,
  onOpenVsCode,
  vscodeConnectingId,
  onOpenFiles,
  onOpenServerFiles,
  onWorkingDirectory,
  onTrusted,
  confirm
}: TerminalWorkspaceProps): React.JSX.Element {
  const [serverPickerPurpose, setServerPickerPurpose] = useState<'terminal' | 'files' | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pickerPosition, setPickerPosition] = useState<{ top: number; left: number; width: number; maxHeight: number; placement: 'above' | 'below' } | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const filesButtonRef = useRef<HTMLButtonElement>(null)
  const activeSession = sessions.find((session) => session.id === activeId) ?? null
  const activeServerSession = activeSession?.type === 'server' ? activeSession : null
  const serverPickerOpen = serverPickerPurpose !== null

  useEffect(() => {
    if (!serverPickerOpen) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setServerPickerPurpose(null)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setServerPickerPurpose(null)
        if (serverPickerPurpose === 'files') filesButtonRef.current?.focus()
        else addButtonRef.current?.focus()
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [serverPickerOpen, serverPickerPurpose])

  useLayoutEffect(() => {
    if (!visible || !serverPickerPurpose) {
      setPickerPosition(null)
      return
    }
    const anchor = serverPickerPurpose === 'files' ? filesButtonRef.current : addButtonRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    const positionMenu = (): void => {
      const rect = anchor.getBoundingClientRect()
      const margin = 8
      const gap = 7
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin)
      const above = Math.max(0, rect.top - gap - margin)
      const desiredHeight = Math.min(420, menu.scrollHeight + 2)
      const placement = below >= desiredHeight || below >= above ? 'below' : 'above'
      const maxHeight = Math.min(420, placement === 'below' ? below : above)
      const width = Math.min(320, window.innerWidth - margin * 2)
      const next = {
        top: placement === 'below' ? rect.bottom + gap : Math.max(margin, rect.top - gap - Math.min(desiredHeight, maxHeight)),
        left: Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin)),
        width,
        maxHeight,
        placement
      } as const
      setPickerPosition((current) => current && Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next)
    }
    positionMenu()
    const observer = new ResizeObserver(positionMenu)
    observer.observe(anchor)
    observer.observe(menu)
    const workspace = pickerRef.current?.closest('.server-terminal-workspace')
    if (workspace) observer.observe(workspace)
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [visible, serverPickerPurpose, servers])

  useEffect(() => {
    if (!visible) setServerPickerPurpose(null)
  }, [visible])

  const chooseServer = (server: ServerProfile, accessRouteId: string): void => {
    const purpose = serverPickerPurpose
    setServerPickerPurpose(null)
    if (purpose === 'files') onOpenServerFiles(server, accessRouteId)
    else if (purpose === 'terminal') onAdd(server, accessRouteId)
  }

  const renderServerRoutes = (server: ServerProfile): React.JSX.Element => (
    <div className="ssh-route-group" key={server.id}>
      <strong className="ssh-route-server-name">{server.name}</strong>
      {getAccessRoutes(server).map((route) => {
        const isJump = route.kind === 'jump'
        const endpoint = `${route.username}@${route.host}:${route.port}`
        const jumpEndpoint = route.jumpHost
          ? `${route.jumpHost.username}@${route.jumpHost.host}:${route.jumpHost.port}`
          : ''
        const isCurrent = accessRouteIdFor(server) === route.id
        return (
          <button
            key={`${server.id}:${route.id}`}
            type="button"
            className={`ssh-server-choice ssh-route-choice route-${route.kind}`}
            onClick={() => chooseServer(server, route.id)}
            title={isJump ? `通过 ${jumpEndpoint} 连接 ${endpoint}` : `直连 ${endpoint}`}
          >
            <Server size={15} />
            <span className="ssh-server-choice-copy">
              <strong>{isJump ? '经跳板机' : '直连'}</strong>
              <small>{isJump && jumpEndpoint ? `${jumpEndpoint} → ${endpoint}` : endpoint}</small>
            </span>
            {isCurrent && <span className="ssh-route-current">当前路径</span>}
          </button>
        )
      })}
    </div>
  )

  const addLocalTerminal = (): void => {
    setServerPickerPurpose(null)
    onAddLocal()
  }

  return (
    <section
      className={`server-terminal-workspace persistent-terminal-workspace ${visible ? 'visible' : ''}`}
      aria-hidden={!visible}
    >
      <div className={`local-terminal-tabbar server-terminal-tabbar ${sessions.length ? '' : 'no-sessions'}`}>
        <div className="local-terminal-tabs" role="tablist" aria-label="终端会话">
          {sessions.map((session) => {
            const route = session.type === 'server' ? getAccessRoute(session.server, session.accessRouteId) : null
            const tabTitle = session.type === 'local'
              ? session.name
              : `${session.name} · ${route?.kind === 'jump' ? '经跳板机' : '直连'}`
            return (
              <button
                key={session.id}
                type="button"
                role="tab"
                aria-selected={activeId === session.id}
                className={`local-terminal-tab ${activeId === session.id ? 'active' : ''} ${session.type === 'local' ? 'local-session-tab' : 'ssh-session-tab'}`}
                onClick={() => onActivate(session.id)}
                title={tabTitle}
              >
                {session.type === 'local' ? <Laptop size={14} /> : <SquareTerminal size={14} />}
                <span className="local-terminal-tab-label">{session.type === 'local' ? session.name : session.server.name}</span>
                {route && <span className={`terminal-route-chip route-${route.kind}`}>{route.kind === 'jump' ? '跳板' : '直连'}</span>}
                <span
                  className="local-terminal-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`关闭 ${session.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onClose(session.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      onClose(session.id)
                    }
                  }}
                ><X size={13} /></span>
              </button>
            )
          })}
        </div>
        <div className="server-terminal-session-actions" ref={pickerRef}>
          <button
            ref={addButtonRef}
            type="button"
            className="local-terminal-add server-terminal-add"
            onClick={() => setServerPickerPurpose((purpose) => purpose === 'terminal' ? null : 'terminal')}
            title="新建终端会话"
            aria-label="新建终端会话"
            aria-expanded={serverPickerPurpose === 'terminal'}
            aria-controls="terminal-add-picker"
          >
            <Plus size={17} />
          </button>
          {activeServerSession && (
            <button
              type="button"
              className="local-terminal-add server-terminal-vscode"
              onClick={() => onOpenVsCode(activeServerSession.server, activeServerSession.accessRouteId)}
              disabled={vscodeConnectingId === activeServerSession.server.id}
              title={vscodeConnectingId === activeServerSession.server.id ? 'VS Code 连接中' : '用 VS Code 打开当前 SSH 连接'}
              aria-label={vscodeConnectingId === activeServerSession.server.id ? 'VS Code 连接中' : '用 VS Code 打开当前 SSH 连接'}
            >
              <Code2 size={15} />
              <span>{vscodeConnectingId === activeServerSession.server.id ? '连接中…' : 'VS Code'}</span>
            </button>
          )}
          <button
            ref={filesButtonRef}
            type="button"
            className="local-terminal-add server-terminal-file"
            onClick={() => {
              if (activeServerSession) {
                setServerPickerPurpose(null)
                onOpenFiles(activeServerSession)
              } else {
                setServerPickerPurpose((purpose) => purpose === 'files' ? null : 'files')
              }
            }}
            title={activeServerSession ? '打开当前会话服务器的文件' : '选择服务器并打开文件'}
            aria-label={activeServerSession ? '打开当前会话服务器的文件' : '选择服务器并打开文件'}
            aria-expanded={!activeServerSession && serverPickerPurpose === 'files'}
            aria-controls="terminal-add-picker"
            disabled={!activeServerSession && !servers.length}
          >
            <FolderOpen size={15} /><span>文件</span>
          </button>
          {serverPickerOpen && visible && createPortal(
            <div ref={menuRef} className="ssh-server-picker terminal-add-picker" id="terminal-add-picker" role="group" aria-label={serverPickerPurpose === 'terminal' ? '新建终端会话' : '选择服务器'} data-placement={pickerPosition?.placement} style={pickerPosition ? { top: pickerPosition.top, left: pickerPosition.left, width: pickerPosition.width, maxHeight: pickerPosition.maxHeight } : { visibility: 'hidden' }}>
              {serverPickerPurpose === 'terminal' ? <>
                <strong className="ssh-server-picker-heading">新建终端</strong>
                <button type="button" className="ssh-server-choice local-terminal-choice" onClick={addLocalTerminal}>
                  <Laptop size={16} />
                  <span className="ssh-server-choice-copy"><strong>本地终端</strong><small>PowerShell · 当前 Windows 用户</small></span>
                </button>
                {servers.length > 0 && <div className="ssh-server-picker-divider" />}
                {servers.length > 0 && <strong className="ssh-server-picker-heading">SSH 服务器</strong>}
              </> : <strong className="ssh-server-picker-heading">选择服务器</strong>}
              {(serverPickerPurpose === 'files' || serverPickerPurpose === 'terminal') && servers.map(renderServerRoutes)}
              {serverPickerPurpose === 'files' && !servers.length && <span className="ssh-server-picker-empty">还没有可用的服务器</span>}
            </div>, document.body
          )}
        </div>
      </div>

      <div className="local-terminal-stage">
        {sessions.map((session) => (
          <div key={session.id} className={`local-terminal-view ${activeId === session.id ? 'active' : ''}`}>
            {session.type === 'local' ? (
              <TerminalPanel target={{ type: 'local' }} displayMode="embedded" name={session.name} onClose={() => onClose(session.id)} />
            ) : (
              <TerminalPanel
                target={{ type: 'server', server: session.server, accessRouteId: session.accessRouteId }}
                displayMode="embedded"
                name={session.name}
                onClose={() => onClose(session.id)}
                onTrusted={onTrusted}
                confirm={confirm}
                initialWorkingDirectory={session.currentPath}
                initialCommand={session.initialCommand}
                onWorkingDirectory={(path) => onWorkingDirectory(session.id, path)}
              />
            )}
          </div>
        ))}
        {!sessions.length && (
          <div className="local-terminal-empty server-terminal-empty">
            <SquareTerminal size={32} />
            <strong>还没有打开的终端</strong>
            <span>点击“＋”创建本地 PowerShell 会话或连接 SSH 服务器。</span>
          </div>
        )}
      </div>
    </section>
  )
}
