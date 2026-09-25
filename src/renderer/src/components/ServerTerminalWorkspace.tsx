import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Plus, Server, SquareTerminal, X } from 'lucide-react'
import type { ServerProfile } from '@shared/types'
import { getAccessRoute } from '@shared/access-routes'
import { TerminalPanel } from './TerminalPanel'

export interface ServerTerminalSession {
  id: string
  name: string
  server: ServerProfile
  accessRouteId: string
}

interface ServerTerminalWorkspaceProps {
  sessions: ServerTerminalSession[]
  activeId: string | null
  visible: boolean
  servers: ServerProfile[]
  accessRouteIdFor(server: ServerProfile): string
  onActivate(sessionId: string): void
  onAdd(server: ServerProfile): void
  onClose(sessionId: string): void
  onOpenFiles(session: ServerTerminalSession): void
  onOpenServerFiles(server: ServerProfile): void
  onTrusted(): Promise<void>
}

export function ServerTerminalWorkspace({
  sessions,
  activeId,
  visible,
  servers,
  accessRouteIdFor,
  onActivate,
  onAdd,
  onClose,
  onOpenFiles,
  onOpenServerFiles,
  onTrusted
}: ServerTerminalWorkspaceProps): React.JSX.Element {
  const [serverPickerPurpose, setServerPickerPurpose] = useState<'terminal' | 'files' | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const filesButtonRef = useRef<HTMLButtonElement>(null)
  const activeSession = sessions.find((session) => session.id === activeId) ?? null
  const serverPickerOpen = serverPickerPurpose !== null

  useEffect(() => {
    if (!serverPickerOpen) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node)) setServerPickerPurpose(null)
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

  useEffect(() => {
    if (!visible) setServerPickerPurpose(null)
  }, [visible])

  const chooseServer = (server: ServerProfile): void => {
    const purpose = serverPickerPurpose
    setServerPickerPurpose(null)
    if (purpose === 'files') onOpenServerFiles(server)
    else if (purpose === 'terminal') onAdd(server)
  }

  return (
    <section
      className={`server-terminal-workspace persistent-terminal-workspace ${visible ? 'visible' : ''}`}
      aria-hidden={!visible}
    >
      <div className={`local-terminal-tabbar server-terminal-tabbar ${sessions.length ? '' : 'no-sessions'}`}>
        <div className="local-terminal-tabs" role="tablist" aria-label="SSH 终端会话">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              role="tab"
              aria-selected={activeId === session.id}
              className={`local-terminal-tab ${activeId === session.id ? 'active' : ''}`}
              onClick={() => onActivate(session.id)}
              title={session.server.name}
            >
              <SquareTerminal size={14} />
              <span className="local-terminal-tab-label">{session.server.name}</span>
              <span
                className="local-terminal-close"
                role="button"
                tabIndex={0}
                aria-label={`关闭 ${session.server.name} ${session.name}`}
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
          ))}
        </div>
        <div className="server-terminal-session-actions" ref={pickerRef}>
          <button
            ref={addButtonRef}
            type="button"
            className="local-terminal-add server-terminal-add"
            onClick={() => setServerPickerPurpose((purpose) => purpose === 'terminal' ? null : 'terminal')}
            title="选择服务器"
            aria-label="选择要连接的服务器"
            aria-expanded={serverPickerPurpose === 'terminal'}
            aria-controls="ssh-server-picker"
            disabled={!servers.length}
          >
            <Plus size={17} />
          </button>
          <button
            ref={filesButtonRef}
            type="button"
            className="local-terminal-add server-terminal-file"
            onClick={() => {
              if (activeSession) {
                setServerPickerPurpose(null)
                onOpenFiles(activeSession)
              } else {
                setServerPickerPurpose((purpose) => purpose === 'files' ? null : 'files')
              }
            }}
            title={activeSession ? '打开当前会话服务器的文件' : '选择服务器并打开文件'}
            aria-label={activeSession ? '打开当前会话服务器的文件' : '选择服务器并打开文件'}
            aria-expanded={!activeSession && serverPickerPurpose === 'files'}
            aria-controls="ssh-server-picker"
            disabled={!activeSession && !servers.length}
          >
            <FolderOpen size={15} /><span>文件</span>
          </button>
          {serverPickerOpen && (
            <div className="ssh-server-picker" id="ssh-server-picker" role="group" aria-label="选择 SSH 服务器">
              <strong className="ssh-server-picker-heading">选择服务器</strong>
              {servers.map((server) => {
                const accessRouteId = accessRouteIdFor(server)
                const route = getAccessRoute(server, accessRouteId)
                return (
                  <button
                    key={server.id}
                    type="button"
                    className="ssh-server-choice"
                    onClick={() => chooseServer(server)}
                  >
                    <Server size={15} />
                    <span className="ssh-server-choice-copy">
                      <strong>{server.name}</strong>
                      <small>{route.name} · {route.username}@{route.host}:{route.port}</small>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="local-terminal-stage">
        {sessions.map((session) => (
          <div key={session.id} className={`local-terminal-view ${activeId === session.id ? 'active' : ''}`}>
            <TerminalPanel
              target={{ type: 'server', server: session.server, accessRouteId: session.accessRouteId }}
              displayMode="embedded"
              name={session.name}
              onClose={() => onClose(session.id)}
              onTrusted={onTrusted}
            />
          </div>
        ))}
        {!sessions.length && (
          <div className="local-terminal-empty server-terminal-empty">
            <SquareTerminal size={32} />
            <strong>还没有 SSH 终端</strong>
          </div>
        )}
      </div>
    </section>
  )
}
