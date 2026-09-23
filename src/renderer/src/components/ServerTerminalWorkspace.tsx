import { useRef, useState } from 'react'
import { Plus, SquareTerminal, X } from 'lucide-react'
import type { ServerProfile } from '@shared/types'
import { TerminalPanel } from './TerminalPanel'

interface ServerTerminalTab {
  id: number
  name: string
}

interface ServerTerminalWorkspaceProps {
  server: ServerProfile
  accessRouteId?: string
  onTrusted(): Promise<void>
}

export function ServerTerminalWorkspace({ server, accessRouteId, onTrusted }: ServerTerminalWorkspaceProps): React.JSX.Element {
  const nextId = useRef(2)
  const [tabs, setTabs] = useState<ServerTerminalTab[]>([{ id: 1, name: 'SSH 1' }])
  const [activeId, setActiveId] = useState(1)

  const addTerminal = (): void => {
    const id = nextId.current++
    setTabs((current) => [...current, { id, name: `SSH ${id}` }])
    setActiveId(id)
  }

  const closeTerminal = (id: number): void => {
    setTabs((current) => {
      const index = current.findIndex((item) => item.id === id)
      const next = current.filter((item) => item.id !== id)
      if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? 0)
      return next
    })
  }

  return (
    <section className="server-terminal-workspace">
      <div className="local-terminal-tabbar server-terminal-tabbar">
        <div className="local-terminal-tabs" role="tablist" aria-label={`${server.name} SSH 会话`}>
          {tabs.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={activeId === item.id} className={`local-terminal-tab ${activeId === item.id ? 'active' : ''}`} onClick={() => setActiveId(item.id)}>
              <SquareTerminal size={14} />
              <span className="local-terminal-tab-label">{item.name}</span>
              <span className="local-terminal-close" role="button" tabIndex={0} aria-label={`关闭 ${item.name}`} onClick={(event) => { event.stopPropagation(); closeTerminal(item.id) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); closeTerminal(item.id) } }}><X size={13} /></span>
            </button>
          ))}
          <button type="button" className="local-terminal-add" onClick={addTerminal} title="新建 SSH 终端"><Plus size={16} /><span>新建 SSH</span></button>
        </div>
      </div>

      <div className="local-terminal-stage">
        {tabs.length ? tabs.map((item) => (
          <div key={item.id} className={`local-terminal-view ${activeId === item.id ? 'active' : ''}`}>
            <TerminalPanel target={{ type: 'server', server, accessRouteId }} displayMode="embedded" name={item.name} onClose={() => closeTerminal(item.id)} onTrusted={onTrusted} />
          </div>
        )) : (
          <div className="local-terminal-empty server-terminal-empty">
            <SquareTerminal size={32} />
            <strong>没有打开的 SSH 终端</strong>
            <span>新建一条独立连接继续操作这台服务器。</span>
            <button type="button" onClick={addTerminal}><Plus size={15} />新建 SSH 终端</button>
          </div>
        )}
      </div>
    </section>
  )
}
