import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { ClipboardPaste, Copy, KeyRound, Laptop, Maximize2, RefreshCw, Server, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ServerProfile } from '@shared/types'
import { getAccessRoute } from '@shared/access-routes'

type TerminalPanelProps = {
  target: { type: 'local' }
  displayMode?: 'floating' | 'embedded'
  name?: string
  onClose(): void
} | {
  target: { type: 'server'; server: ServerProfile; accessRouteId?: string }
  displayMode?: 'floating' | 'embedded'
  name?: string
  onClose(): void
  onTrusted(): Promise<void>
}

export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const { target, onClose } = props
  const isLocal = target.type === 'local'
  const server = target.type === 'server' ? target.server : null
  const accessRouteId = target.type === 'server' ? target.accessRouteId : undefined
  const route = server ? getAccessRoute(server, accessRouteId) : null
  const targetKey = isLocal ? 'local' : `${server!.id}:${accessRouteId ?? 'default'}`
  const embedded = props.displayMode === 'embedded'
  const panelRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  const canAutofillPasswordRef = useRef(false)
  const passwordPromptRef = useRef(false)
  const manualPasswordInputRef = useRef(false)
  const outputTailRef = useRef('')
  const noticeTimerRef = useRef<number | null>(null)
  const maximizedRef = useRef(false)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; width: number; height: number } | null>(null)
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [position, setPosition] = useState(() => {
    const width = Math.min(1120, window.innerWidth - 48)
    const height = Math.min(720, window.innerHeight - 48)
    return { x: Math.max(12, Math.round((window.innerWidth - width) / 2)), y: Math.max(12, Math.round((window.innerHeight - height) / 2)) }
  })
  const [maximized, setMaximized] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null)
  const [passwordPrompt, setPasswordPrompt] = useState(false)
  maximizedRef.current = maximized

  const clampPosition = (x: number, y: number, width: number, height: number): { x: number; y: number } => ({
    x: Math.max(8, Math.min(Math.max(8, window.innerWidth - width - 8), x)),
    y: Math.max(8, Math.min(Math.max(8, window.innerHeight - height - 8), y))
  })

  const showClipboardNotice = (message: string): void => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    setClipboardNotice(message)
    noticeTimerRef.current = window.setTimeout(() => setClipboardNotice(null), 1600)
  }

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 8000,
      theme: {
        background: '#07101d',
        foreground: '#d8e4f2',
        cursor: '#64d8cb',
        selectionBackground: '#1f6070aa',
        black: '#0b1524',
        red: '#ff6b7d',
        green: '#67d391',
        yellow: '#e9c46a',
        blue: '#66a7ff',
        magenta: '#c79cff',
        cyan: '#64d8cb',
        white: '#eef5ff'
      }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(containerRef.current!)
    fit.fit()
    terminal.focus()
    terminalRef.current = terminal
    fitRef.current = fit

    const clearPasswordPrompt = (): void => {
      passwordPromptRef.current = false
      manualPasswordInputRef.current = false
      outputTailRef.current = ''
      setPasswordPrompt(false)
    }
    const detachData = window.labApi.terminal.onData((event) => {
      if (event.sessionId !== sessionRef.current) return
      terminal.write(event.data)
      if (isLocal || !canAutofillPasswordRef.current) return
      const plainText = event.data.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      outputTailRef.current = `${outputTailRef.current}${plainText}`.slice(-600)
      const detected = /(?:^|[\r\n])[^\r\n]{0,180}(?:password(?:\s+for\s+[^\r\n:：]+)?|密码)\s*[:：]\s*$/i.test(outputTailRef.current)
      if (detected && !passwordPromptRef.current) {
        passwordPromptRef.current = true
        manualPasswordInputRef.current = false
        setPasswordPrompt(true)
      } else if (!detected && passwordPromptRef.current && /[\r\n]/.test(plainText)) {
        clearPasswordPrompt()
      }
    })
    const detachExit = window.labApi.terminal.onExit((event) => {
      if (event.sessionId === sessionRef.current) {
        terminal.write(`\r\n\x1b[38;5;244m${isLocal ? '本地进程已退出' : '连接已结束'}${event.code === null ? '' : `，退出码 ${event.code}`}\x1b[0m\r\n`)
        setStatus('offline')
        sessionRef.current = null
        canAutofillPasswordRef.current = false
        clearPasswordPrompt()
      }
    })
    const input = terminal.onData((data) => {
      const sessionId = sessionRef.current
      if (!sessionId) return
      if (passwordPromptRef.current && !manualPasswordInputRef.current && data === '\r') {
        clearPasswordPrompt()
        void window.labApi.terminal.autofillPassword(sessionId).then((filled) => {
          showClipboardNotice(filled ? '已安全填充保存的密码' : '没有可用的已保存密码')
          if (!filled) window.labApi.terminal.write(sessionId, data)
        })
        return
      }
      if (passwordPromptRef.current) {
        manualPasswordInputRef.current = true
        passwordPromptRef.current = false
        setPasswordPrompt(false)
      }
      window.labApi.terminal.write(sessionId, data)
    })
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const copyShortcut = (event.ctrlKey && event.shiftKey && event.code === 'KeyC') || (event.ctrlKey && event.code === 'Insert')
      if (copyShortcut) {
        const selection = terminal.getSelection()
        if (selection) void window.labApi.clipboard.writeText(selection).then(() => showClipboardNotice('已复制到剪贴板'))
        return false
      }
      return true
    })
    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      const selection = terminal.getSelection()
      if (selection) {
        void window.labApi.clipboard.writeText(selection).then(() => showClipboardNotice('已复制到剪贴板'))
      } else {
        void window.labApi.clipboard.readText().then((text) => {
          if (text && sessionRef.current) window.labApi.terminal.write(sessionRef.current, text)
        })
      }
      terminal.focus()
    }
    containerRef.current!.addEventListener('contextmenu', handleContextMenu)
    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      if (sessionRef.current) window.labApi.terminal.resize(sessionRef.current, terminal.cols, terminal.rows)
      const panel = panelRef.current
      if (panel && !maximizedRef.current) {
        const rect = panel.getBoundingClientRect()
        setPosition((current) => clampPosition(current.x, current.y, rect.width, rect.height))
      }
    })
    resizeObserver.observe(containerRef.current!)

    void connectTerminal(terminal)

    return () => {
      if (sessionRef.current) window.labApi.terminal.close(sessionRef.current)
      clearPasswordPrompt()
      detachData()
      detachExit()
      input.dispose()
      containerRef.current?.removeEventListener('contextmenu', handleContextMenu)
      resizeObserver.disconnect()
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
      terminal.dispose()
      terminalRef.current = null
    }
  }, [targetKey])

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const dragState = dragRef.current
      if (!dragState || dragState.pointerId !== event.pointerId) return
      setPosition(clampPosition(
        dragState.originX + event.clientX - dragState.startX,
        dragState.originY + event.clientY - dragState.startY,
        dragState.width,
        dragState.height
      ))
    }
    const stop = (event?: PointerEvent): void => {
      if (event && dragRef.current?.pointerId !== event.pointerId) return
      dragRef.current = null
      setDragging(false)
    }
    const stopAll = (): void => stop()
    const keepInside = (): void => {
      const panel = panelRef.current
      if (!panel || maximized) return
      const rect = panel.getBoundingClientRect()
      setPosition((current) => clampPosition(current.x, current.y, rect.width, rect.height))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stopAll)
    window.addEventListener('resize', keepInside)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stopAll)
      window.removeEventListener('resize', keepInside)
    }
  }, [maximized])

  const connectTerminal = async (terminal: Terminal): Promise<void> => {
    setStatus('connecting')
    if (isLocal) {
      terminal.write('\x1b[38;5;45m正在启动本地 PowerShell…\x1b[0m\r\n')
    } else {
      terminal.write(`\x1b[38;5;45m正在连接 ${route!.username}@${route!.host}:${route!.port}（${route!.name}）…\x1b[0m\r\n`)
    }
    let result = isLocal
      ? await window.labApi.terminal.connectLocal(terminal.cols, terminal.rows)
      : await window.labApi.terminal.connect(server!.id, terminal.cols, terminal.rows, accessRouteId)
    for (let attempt = 0; attempt < 2 && result.status === 'host-key-required' && result.fingerprint; attempt += 1) {
      if (!server || props.target.type !== 'server') break
      const targetName = result.hostKeyTarget === 'jumpHost' ? '跳板机' : '目标服务器'
      const trusted = window.confirm(
        `首次连接 ${server.name} 的${targetName}，请通过可信渠道核对主机指纹：\n\n${result.fingerprint}\n\n确认信任该主机吗？`
      )
      if (!trusted) break
      await window.labApi.servers.trustHost(server.id, result.fingerprint, result.hostKeyTarget, accessRouteId)
      if ('onTrusted' in props) await props.onTrusted()
      result = await window.labApi.terminal.connect(server.id, terminal.cols, terminal.rows, accessRouteId)
    }
    if (result.status === 'connected' && result.sessionId) {
      sessionRef.current = result.sessionId
      canAutofillPasswordRef.current = Boolean(result.canAutofillPassword)
      setStatus('online')
      terminal.focus()
    } else {
      canAutofillPasswordRef.current = false
      setStatus('offline')
      terminal.write(`\r\n\x1b[31m${isLocal ? '启动失败' : '连接失败'}：${result.message ?? '未知错误'}\x1b[0m\r\n`)
    }
  }

  const reconnect = (): void => {
    if (!terminalRef.current) return
    if (sessionRef.current) window.labApi.terminal.close(sessionRef.current)
    sessionRef.current = null
    canAutofillPasswordRef.current = false
    passwordPromptRef.current = false
    manualPasswordInputRef.current = false
    outputTailRef.current = ''
    setPasswordPrompt(false)
    terminalRef.current.clear()
    void connectTerminal(terminalRef.current)
  }

  const copySelection = async (): Promise<void> => {
    const selection = terminalRef.current?.getSelection()
    if (selection) {
      await window.labApi.clipboard.writeText(selection)
      showClipboardNotice('已复制到剪贴板')
    } else {
      showClipboardNotice('请先选择终端内容')
    }
    terminalRef.current?.focus()
  }

  const pasteClipboard = async (): Promise<void> => {
    const text = await window.labApi.clipboard.readText()
    if (text && sessionRef.current) {
      window.labApi.terminal.write(sessionRef.current, text)
      showClipboardNotice('已粘贴')
    }
    terminalRef.current?.focus()
  }

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (embedded || maximized || (event.target as HTMLElement).closest('button')) return
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top, width: rect.width, height: rect.height }
    setDragging(true)
  }

  const panelStyle: CSSProperties | undefined = embedded
    ? undefined
    : maximized
    ? { inset: 12 }
    : { left: position.x, top: position.y, right: 'auto', bottom: 'auto' }

  return (
    <div ref={panelRef} className={`workspace-panel terminal-panel ${embedded ? 'embedded' : ''} ${maximized ? 'maximized' : ''} ${dragging ? 'dragging' : ''}`} style={panelStyle}>
      <div className={`workspace-toolbar ${embedded ? '' : 'terminal-drag-handle'}`} onPointerDown={beginDrag} onDoubleClick={() => { if (!embedded) setMaximized((value) => !value) }}>
        <div className="workspace-identity">
          {!embedded && <div className="terminal-server-icon">{isLocal ? <Laptop size={17} /> : <Server size={17} />}</div>}
          {!embedded && <div><strong>{isLocal ? (props.name ?? '本地终端') : server!.name}</strong><span>{isLocal ? 'PowerShell · 当前 Windows 用户' : `${route!.username}@${route!.host}:${route!.port} · ${route!.name}`}</span></div>}
          <div className={`connection-pill ${status}`}><i />{status === 'online' ? (isLocal ? '运行中' : '已连接') : status === 'connecting' ? (isLocal ? '启动中' : '连接中') : (isLocal ? '已退出' : '已断开')}</div>
        </div>
        <div className="toolbar-actions">
          {!embedded && <button className="toolbar-button terminal-clipboard-button" onClick={() => void copySelection()} title="复制选中内容（Ctrl+Shift+C）"><Copy size={14} />复制</button>}
          {!embedded && <button className="toolbar-button terminal-clipboard-button" onClick={() => void pasteClipboard()} title="粘贴（Ctrl+Shift+V）"><ClipboardPaste size={14} />粘贴</button>}
          <button className="toolbar-button" onClick={reconnect}><RefreshCw size={15} />{isLocal ? '重新启动' : '重连'}</button>
          {!embedded && <button className="icon-button" onClick={() => setMaximized((value) => !value)} title={maximized ? '还原窗口' : '最大化终端'}><Maximize2 size={17} /></button>}
          {!embedded && <button className="icon-button" onClick={onClose} title="关闭终端"><X size={18} /></button>}
        </div>
      </div>
      <div className="terminal-container" ref={containerRef} />
      {passwordPrompt && <div className="terminal-password-hint" role="status"><KeyRound size={15} /><span>检测到密码输入</span><small>按</small><kbd>Enter</kbd><small>自动填充已保存密码</small></div>}
      {clipboardNotice && <div className="terminal-clipboard-notice" role="status">{clipboardNotice}</div>}
    </div>
  )
}
