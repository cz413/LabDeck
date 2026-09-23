import { useRef, useState } from 'react'
import { Plus, SquareTerminal, X } from 'lucide-react'
import { TerminalPanel } from './TerminalPanel'

interface LocalTerminalTab {
  id: number
  name: string
}

export function LocalTerminalWorkspace({ onClose }: { onClose(): void }): React.JSX.Element {
  const nextId = useRef(2)
  const [tabs, setTabs] = useState<LocalTerminalTab[]>([{ id: 1, name: '终端 1' }])
  const [activeId, setActiveId] = useState(1)

  const addTerminal = (): void => {
    const id = nextId.current
    nextId.current += 1
    setTabs((current) => [...current, { id, name: `终端 ${id}` }])
    setActiveId(id)
  }

  const closeTerminal = (id: number): void => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id)
      const next = current.filter((tab) => tab.id !== id)
      if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? 0)
      return next
    })
  }

  return (
    <section className="local-terminal-workspace">
      <div className="local-terminal-tabbar">
        <div className="local-terminal-tabs" role="tablist" aria-label="本地终端会话">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeId === tab.id}
              className={`local-terminal-tab ${activeId === tab.id ? 'active' : ''}`}
              onClick={() => setActiveId(tab.id)}
            >
              <SquareTerminal size={14} />
              <span className="local-terminal-tab-label">{tab.name}</span>
              <span
                className="local-terminal-close"
                role="button"
                tabIndex={0}
                aria-label={`关闭${tab.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTerminal(tab.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    closeTerminal(tab.id)
                  }
                }}
              ><X size={13} /></span>
            </button>
          ))}
          <button type="button" className="local-terminal-add" onClick={addTerminal} title="新建本地终端"><Plus size={16} /><span>新建</span></button>
        </div>
        <button type="button" className="local-terminal-leave" onClick={onClose}><X size={15} /><span>退出终端工作区</span></button>
      </div>

      <div className="local-terminal-stage">
        {tabs.length ? tabs.map((tab) => (
          <div key={tab.id} className={`local-terminal-view ${activeId === tab.id ? 'active' : ''}`}>
            <TerminalPanel
              target={{ type: 'local' }}
              displayMode="embedded"
              name={tab.name}
              onClose={() => closeTerminal(tab.id)}
            />
          </div>
        )) : (
          <div className="local-terminal-empty">
            <SquareTerminal size={32} />
            <strong>没有打开的终端</strong>
            <span>新建一个 PowerShell 会话继续工作。</span>
            <button type="button" onClick={addTerminal}><Plus size={15} />新建本地终端</button>
          </div>
        )}
      </div>
    </section>
  )
}
