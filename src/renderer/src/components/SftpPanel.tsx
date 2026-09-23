import { useEffect, useState } from 'react'
import { ArrowLeft, Download, File, Folder, RefreshCw, Upload, X } from 'lucide-react'
import type { ServerProfile, SftpEntry, SftpTransferProgress } from '@shared/types'
import { getAccessRoute } from '@shared/access-routes'

interface SftpPanelProps {
  server: ServerProfile
  accessRouteId?: string
  onClose(): void
  onMessage(message: string, kind?: 'success' | 'error'): void
}

export function SftpWindowApp({ serverId, accessRouteId }: { serverId: string; accessRouteId?: string }): React.JSX.Element {
  const [server, setServer] = useState<ServerProfile | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    void Promise.all([window.labApi.servers.list(), window.labApi.settings.get()])
      .then(([servers, settings]) => {
        document.documentElement.dataset.theme = settings.theme
        const matched = servers.find((item) => item.id === serverId)
        if (!matched) throw new Error('服务器不存在或已被删除')
        setServer(matched)
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '文件传输窗口初始化失败'))
  }, [serverId])

  if (error) return <StandaloneWindowState message={error} error />
  if (!server) return <StandaloneWindowState message="正在打开文件传输窗口…" />
  return <div className="standalone-sftp-shell"><SftpPanel server={server} accessRouteId={accessRouteId} onClose={() => window.labApi.windowControls.close()} onMessage={(nextMessage, kind = 'success') => { setMessage(`${kind === 'error' ? '失败：' : ''}${nextMessage}`); window.setTimeout(() => setMessage(''), 3600) }} />{message && <div className={`sftp-window-message ${message.startsWith('失败：') ? 'error' : ''}`}>{message}</div>}</div>
}

function StandaloneWindowState({ message, error = false }: { message: string; error?: boolean }): React.JSX.Element {
  return <div className={`standalone-window-state ${error ? 'error' : ''}`}><strong>{message}</strong><button type="button" onClick={() => window.labApi.windowControls.close()}>关闭</button></div>
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

const normalizePathInput = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

const transferStatusLabel = (transfer: SftpTransferProgress): string => {
  if (transfer.status === 'completed') return '已完成'
  if (transfer.status === 'failed') return transfer.error ? `失败：${transfer.error}` : '传输失败'
  return transfer.direction === 'upload' ? '上传中' : '下载中'
}

function TransferList({ transfers }: { transfers: SftpTransferProgress[] }): React.JSX.Element | null {
  if (!transfers.length) return null
  return <div className="sftp-transfers" aria-live="polite">
    {transfers.map((transfer) => {
      const percent = transfer.totalBytes > 0
        ? Math.min(100, Math.round(transfer.transferredBytes / transfer.totalBytes * 100))
        : transfer.status === 'completed' ? 100 : null
      return <div className={`sftp-transfer ${transfer.status}`} key={transfer.transferId}>
        <div className="sftp-transfer-heading"><strong>{transfer.direction === 'upload' ? '上传' : '下载'} · {transfer.fileName}</strong><span>{transferStatusLabel(transfer)}</span></div>
        <div className="sftp-transfer-track"><i className={percent === null ? 'indeterminate' : ''} style={percent === null ? undefined : { width: `${percent}%` }} /></div>
        <div className="sftp-transfer-meta"><span>{formatSize(transfer.transferredBytes)}{transfer.totalBytes > 0 ? ` / ${formatSize(transfer.totalBytes)}` : ''}</span><b>{percent === null ? '准备中' : `${percent}%`}</b></div>
      </div>
    })}
  </div>
}

export function SftpPanel({ server, accessRouteId, onClose, onMessage }: SftpPanelProps): React.JSX.Element {
  const route = getAccessRoute(server, accessRouteId)
  const homePath = route.username.trim() ? `/home/${route.username.trim()}` : '/'
  const [path, setPath] = useState(homePath)
  const [pathInput, setPathInput] = useState(homePath)
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [transfers, setTransfers] = useState<SftpTransferProgress[]>([])

  const load = async (target = path): Promise<void> => {
    const nextPath = normalizePathInput(target)
    setLoading(true)
    setError('')
    try {
      setEntries(await window.labApi.sftp.list(server.id, nextPath, accessRouteId))
      setPath(nextPath)
      setPathInput(nextPath)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '远程目录读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load(homePath) }, [server.id, homePath, accessRouteId])
  useEffect(() => window.labApi.sftp.onProgress((progress) => {
    setTransfers((current) => {
      const index = current.findIndex((item) => item.transferId === progress.transferId)
      if (index < 0) return [...current, progress].slice(-4)
      const next = [...current]
      next[index] = progress
      return next
    })
    if (progress.status !== 'running') {
      window.setTimeout(() => setTransfers((current) => current.filter((item) => item.transferId !== progress.transferId)), 9000)
    }
  }), [])

  const submitPath = (): void => {
    const nextPath = normalizePathInput(pathInput)
    if (nextPath === path) {
      setPathInput(nextPath)
      return
    }
    void load(nextPath)
  }

  const parentPath = (): string => {
    if (path === '/') return '/'
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    return `/${parts.join('/')}` || '/'
  }

  const upload = async (): Promise<void> => {
    const localPath = await window.labApi.sftp.chooseUploadFile()
    if (!localPath) return
    const filename = localPath.split(/[\\/]/).pop()!
    const remotePath = `${path === '/' ? '' : path}/${filename}`
    const transferId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      await window.labApi.sftp.upload(server.id, localPath, remotePath, transferId, accessRouteId)
      onMessage(`已上传 ${filename}`)
      await load()
    } catch (caught) {
      onMessage(caught instanceof Error ? caught.message : '上传失败', 'error')
    }
  }

  const download = async (entry: SftpEntry): Promise<void> => {
    const transferId = `download-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      const savedPath = await window.labApi.sftp.download(server.id, entry.path, transferId, accessRouteId)
      if (savedPath) onMessage(`已下载到 ${savedPath}`)
    } catch (caught) {
      onMessage(caught instanceof Error ? caught.message : '下载失败', 'error')
    }
  }

  return (
    <div className="workspace-panel sftp-panel">
      <div className="workspace-toolbar">
        <div className="workspace-identity">
          <div className="terminal-server-icon"><Folder size={17} /></div>
          <div><strong>{server.name} · 文件管理</strong><span>SFTP · {route.username}@{route.host} · {route.name}</span></div>
        </div>
        <div className="toolbar-actions">
          <button className="toolbar-button" onClick={upload}><Upload size={15} />上传文件</button>
          <button className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
      </div>
      <div className="path-toolbar">
        <button className="icon-button" disabled={path === '/'} onClick={() => void load(parentPath())}><ArrowLeft size={17} /></button>
        <input className="path-input" value={pathInput} onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitPath() } }} onBlur={submitPath} aria-label="远程路径" spellCheck={false} />
        <button className="icon-button" onClick={() => void load()}><RefreshCw size={16} /></button>
      </div>
      <TransferList transfers={transfers} />
      <div className="file-list-header"><span>名称</span><span>大小</span><span>修改时间</span><span /></div>
      <div className="file-list">
        {loading && <div className="panel-empty">正在读取远程目录…</div>}
        {!loading && error && <div className="panel-error">{error}</div>}
        {!loading && !error && entries.length === 0 && <div className="panel-empty">此目录为空</div>}
        {!loading && !error && entries.map((entry) => (
          <div className="file-row" key={entry.path} onDoubleClick={() => entry.type === 'directory' && void load(entry.path)}>
            <span className="file-name">{entry.type === 'directory' ? <Folder size={18} /> : <File size={18} />}{entry.name}</span>
            <span>{entry.type === 'directory' ? '—' : formatSize(entry.size)}</span>
            <span>{new Date(entry.modifiedAt).toLocaleString('zh-CN')}</span>
            <span>{entry.type === 'file' && <button className="icon-button small" onClick={() => void download(entry)} title="下载"><Download size={15} /></button>}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
