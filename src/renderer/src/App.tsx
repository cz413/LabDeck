import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Check,
  ChevronRight,
  CircleUserRound,
  Code2,
  Copy,
  Cpu,
  Database,
  FolderOpen,
  FileDown,
  GitMerge,
  Gauge,
  HardDrive,
  LayoutDashboard,
  ListTodo,
  MemoryStick,
  Minus,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server as ServerIcon,
  Settings,
  ShieldCheck,
  Square,
  SquareTerminal,
  Thermometer,
  Trash2,
  WifiOff,
  X,
  Zap,
  XCircle
} from 'lucide-react'
import type { AppSettings, ConnectionTestResult, GpuProcessMetric, GpuWatchTarget, MonitorPolicy, ServerProfile, ServerSnapshot } from '@shared/types'
import { gpuLoadState, gpuMemoryPercent, gpuRecommendation, isGpuBusy } from '@shared/gpu-status'
import { getAccessRoute, getAccessRoutes, getDefaultAccessRouteId, routeLabel } from '@shared/access-routes'
import { ServerDialog } from './components/ServerDialog'
import { AccessRouteSelect } from './components/AccessRouteSelect'
import { GpuDetailPanel } from './components/GpuDetailPanel'
import { LocalTerminalWorkspace } from './components/LocalTerminalWorkspace'
import { ServerTerminalWorkspace, type ServerTerminalSession } from './components/ServerTerminalWorkspace'
import { ServerDetailPage } from './components/ServerDetailPage'

type Page = 'dashboard' | 'gpus' | 'tasks' | 'servers' | 'serverDetail' | 'terminals' | 'alerts' | 'settings'
type Workspace = { type: 'localTerminal' } | null
type GpuSelection = { server: ServerProfile; gpuIndex: number } | null

interface UserGpuTask {
  server: ServerProfile
  gpuIndex: number
  gpuName: string
  process: GpuProcessMetric
}

interface Toast {
  id: number
  message: string
  kind: 'success' | 'error'
}

const defaultSettings: AppSettings = {
  theme: 'ocean',
  monitoringEnabled: true,
  pollingIntervalSeconds: 60,
  maxConcurrentPolls: 5,
  minimizeToTray: true,
  closeBehavior: 'ask',
  notifyOnWarning: true,
  gpuWatches: []
}

const formatPercent = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${Math.round(value)}%`

const formatBytes = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '—'
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TB`
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(0)} GB`
  return `${(value / 1024 ** 2).toFixed(0)} MB`
}

const formatTaskDuration = (seconds: number | null): string => {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`
  return `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`
}

const statusLabel = (snapshot?: ServerSnapshot): string => {
  if (!snapshot || snapshot.status === 'unknown') return '等待采集'
  if (snapshot.cached) return '上次状态'
  if (snapshot.status === 'offline') return '连接失败'
  if (snapshot.status === 'warning') return '需要关注'
  return '运行正常'
}

const monitorPolicyLabel: Record<MonitorPolicy, string> = {
  manual: '手动',
  onView: '按需',
  background: '持续'
}

const isLegacyJumpProfile = (name: string): boolean => /(?:[-_\s]?jump|跳板机)$/i.test(name.trim())
const baseServerName = (name: string): string => name.trim().replace(/(?:[-_\s]?jump|跳板机)$/i, '').trim()

function LabDeckMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path className="brand-monogram" d="M7 5.5v20h8.5M13.5 5.5h4c5.3 0 8.5 3.9 8.5 10s-3.2 10-8.5 10h-4" />
      <path className="brand-decks" d="M16.5 10.5h5.5M16.5 15.5h6.5M16.5 20.5h5.5" />
    </svg>
  )
}

export function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('dashboard')
  const [servers, setServers] = useState<ServerProfile[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, ServerSnapshot>>({})
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [dialogServer, setDialogServer] = useState<ServerProfile | null | undefined>(undefined)
  const [workspace, setWorkspace] = useState<Workspace>(null)
  const [terminalSessions, setTerminalSessions] = useState<ServerTerminalSession[]>([])
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [gpuSelection, setGpuSelection] = useState<GpuSelection>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [vscodeConnectingId, setVsCodeConnectingId] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [sshConfigCount, setSshConfigCount] = useState(0)
  const [importingConfig, setImportingConfig] = useState(false)
  const [windowMaximized, setWindowMaximized] = useState(false)
  const [closePromptOpen, setClosePromptOpen] = useState(false)
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false)
  const [accessRouteSelections, setAccessRouteSelections] = useState<Record<string, string>>({})
  const retryState = useRef<Record<string, { failures: number; nextRetryAt: number }>>({})
  const nextTerminalNumber = useRef(1)
  const previousPage = useRef<Page>('dashboard')
  const serverDetailReturnPage = useRef<Page>('dashboard')

  const accessRouteIdFor = (server: ServerProfile): string => {
    const selected = accessRouteSelections[server.id]
    return selected && getAccessRoutes(server).some((route) => route.id === selected)
      ? selected
      : getDefaultAccessRouteId(server)
  }

  const selectAccessRoute = (server: ServerProfile, routeId: string): void => {
    if (!getAccessRoutes(server).some((route) => route.id === routeId)) return
    setAccessRouteSelections((current) => ({ ...current, [server.id]: routeId }))
    if (server.monitorPolicy !== 'manual') void refreshSnapshots([server], { force: true })
  }

  const routeNeedsSecret = (server: ServerProfile, routeId: string): boolean => {
    const route = getAccessRoute(server, routeId)
    return server.mode === 'real' && (
      (route.authType === 'password' && !server.hasSecret) ||
      (route.kind === 'jump' && route.jumpHost?.authType === 'password' && !route.jumpHost.hasSecret)
    )
  }

  const notify = (message: string, kind: 'success' | 'error' = 'success'): void => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, message, kind }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3600)
  }

  const loadServers = async (): Promise<ServerProfile[]> => {
    const list = await window.labApi.servers.list()
    setServers(list)
    return list
  }

  const refreshSnapshots = async (
    list = servers,
    options: { force?: boolean; concurrency?: number } = {}
  ): Promise<void> => {
    const now = Date.now()
    const eligible = options.force
      ? list
      : list.filter((server) => (retryState.current[server.id]?.nextRetryAt ?? 0) <= now)
    if (!eligible.length) return
    setRefreshing(true)
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (nextIndex < eligible.length) {
        const server = eligible[nextIndex]
        nextIndex += 1
        try {
          const snapshot = await window.labApi.monitor.snapshot(server.id, accessRouteIdFor(server))
          if (snapshot.status === 'offline') {
            const failures = (retryState.current[server.id]?.failures ?? 0) + 1
            const delayMinutes = [1, 2, 5, 10][Math.min(failures - 1, 3)]
            retryState.current[server.id] = { failures, nextRetryAt: Date.now() + delayMinutes * 60_000 }
          } else {
            delete retryState.current[server.id]
          }
          setSnapshots((current) => ({ ...current, [server.id]: snapshot }))
        } catch (error) {
          const failures = (retryState.current[server.id]?.failures ?? 0) + 1
          const delayMinutes = [1, 2, 5, 10][Math.min(failures - 1, 3)]
          retryState.current[server.id] = { failures, nextRetryAt: Date.now() + delayMinutes * 60_000 }
          console.warn(`采集 ${server.name} 失败`, error)
        }
      }
    }
    await Promise.allSettled(
      Array.from(
        { length: Math.min(options.concurrency ?? settings.maxConcurrentPolls, eligible.length) },
        () => worker()
      )
    )
    setRefreshing(false)
  }

  useEffect(() => {
    void (async () => {
      try {
        const [list, savedSettings, cachedSnapshots] = await Promise.all([
          loadServers(),
          window.labApi.settings.get(),
          window.labApi.monitor.cachedSnapshots()
        ])
        setSettings(savedSettings)
        setSnapshots(cachedSnapshots)
        document.documentElement.dataset.theme = savedSettings.theme
        setLoading(false)
        const watchedServerIds = new Set(savedSettings.gpuWatches.map((watch) => watch.serverId))
        const backgroundServers = list.filter((server) => server.monitorPolicy === 'background' || watchedServerIds.has(server.id))
        if (savedSettings.monitoringEnabled && backgroundServers.length) {
          window.setTimeout(() => void refreshSnapshots(backgroundServers, { concurrency: savedSettings.maxConcurrentPolls }), 0)
        }
        void window.labApi.sshConfig.scan().then((scan) => {
          setSshConfigCount(scan.candidates.filter((item) => !item.alreadyImported).length)
        }).catch(() => {
          setSshConfigCount(0)
        })
      } catch (error) {
        notify(error instanceof Error ? error.message : '应用初始化失败', 'error')
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    const watchedServerIds = new Set(settings.gpuWatches.map((watch) => watch.serverId))
    const backgroundServers = servers.filter((server) => server.monitorPolicy === 'background' || watchedServerIds.has(server.id))
    if (!settings.monitoringEnabled || !backgroundServers.length) return
    const timer = window.setInterval(
      () => void refreshSnapshots(backgroundServers),
      settings.pollingIntervalSeconds * 1000
    )
    return () => window.clearInterval(timer)
  }, [settings.monitoringEnabled, settings.pollingIntervalSeconds, settings.maxConcurrentPolls, settings.gpuWatches, servers, accessRouteSelections])

  useEffect(() => window.labApi.notifications.onGpuAvailable((event) => {
    const server = servers.find((item) => item.id === event.serverId)
    if (!server) return
    setWorkspace(null)
    setPage('gpus')
    setGpuSelection({ server, gpuIndex: event.gpuIndex })
  }), [servers])

  useEffect(() => window.labApi.windowControls.onCloseRequested(() => {
    setRememberCloseChoice(false)
    setClosePromptOpen(true)
  }), [])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  useEffect(() => {
    if (loading) return
    const enteredPage = previousPage.current !== page
    previousPage.current = page
    if (!enteredPage || (page !== 'servers' && page !== 'gpus' && page !== 'tasks')) return
    const onViewServers = servers.filter((server) => server.monitorPolicy === 'onView')
    if (onViewServers.length) void refreshSnapshots(onViewServers, { force: true })
  }, [page, loading, servers])

  const filteredServers = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return servers
    return servers.filter((server) =>
      [server.name, server.host, server.group, ...server.tags]
        .join(' ')
        .toLowerCase()
        .includes(query)
    )
  }, [search, servers])

  const selectedServer = selectedServerId
    ? servers.find((server) => server.id === selectedServerId)
    : undefined

  const summary = useMemo(() => {
    const values = servers.map((server) => snapshots[server.id])
    const online = values.filter((item) => !item?.cached && (item?.status === 'online' || item?.status === 'warning')).length
    const warning = values.filter((item) => !item?.cached && item?.status === 'warning').length
    const gpuCount = values.reduce((sum, item) => sum + (item?.gpus.length ?? 0), 0)
    const averageGpu = values
      .flatMap((item) => item?.gpus ?? [])
      .reduce((sum, gpu, _, list) => sum + gpu.utilizationPercent / Math.max(1, list.length), 0)
    return { online, warning, gpuCount, averageGpu }
  }, [servers, snapshots])

  const myTasks = useMemo<UserGpuTask[]>(() => servers.flatMap((server) => {
    const snapshot = snapshots[server.id]
    if (!snapshot || snapshot.cached || snapshot.status === 'offline') return []
    const username = server.username.trim().toLowerCase()
    return snapshot.gpus.flatMap((gpu) => gpu.processes
      .filter((process) => process.username.trim().toLowerCase() === username)
      .map((process) => ({ server, gpuIndex: gpu.index, gpuName: gpu.name, process })))
  }), [servers, snapshots])

  const alerts = useMemo(() => {
    return servers.flatMap((server) => {
      const snapshot = snapshots[server.id]
      if (!snapshot || snapshot.cached) return []
      const items: Array<{ server: ServerProfile; level: 'critical' | 'warning'; title: string; detail: string }> = []
      if (snapshot.status === 'offline') {
        items.push({ server, level: 'critical', title: '服务器不可达', detail: snapshot.error ?? 'SSH 连接失败' })
      }
      snapshot.fileSystems.filter((fs) => fs.usagePercent >= 80).forEach((fs) => {
        items.push({ server, level: fs.usagePercent >= 90 ? 'critical' : 'warning', title: '存储空间不足', detail: `${fs.mountPoint} 已使用 ${Math.round(fs.usagePercent)}%` })
      })
      snapshot.gpus.filter((gpu) => gpu.temperatureC >= 80).forEach((gpu) => {
        items.push({ server, level: gpu.temperatureC >= 88 ? 'critical' : 'warning', title: 'GPU 温度较高', detail: `${gpu.name} 当前 ${gpu.temperatureC}°C` })
      })
      return items
    })
  }, [servers, snapshots])

  const saved = async (savedServer: ServerProfile): Promise<void> => {
    setDialogServer(undefined)
    await loadServers()
    if (savedServer.monitorPolicy === 'background' && settings.monitoringEnabled) {
      await refreshSnapshots([savedServer], { force: true })
    }
    notify('服务器配置已保存')
  }

  const openSftp = (server: ServerProfile, accessRouteId = accessRouteIdFor(server)): void => {
    if (routeNeedsSecret(server, accessRouteId)) {
      notify('请先在服务器认证信息中输入并保存 SSH 密码', 'error')
      setDialogServer(server)
      return
    }
    void window.labApi.sftp.openWindow(server.id, accessRouteId).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : '无法打开文件传输窗口', 'error')
    })
  }

  const openVsCode = async (server: ServerProfile): Promise<void> => {
    if (vscodeConnectingId === server.id) return
    setVsCodeConnectingId(server.id)
    try {
      const result = await window.labApi.vscode.openRemote(server.id, accessRouteIdFor(server))
      notify(result.message)
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法打开 VS Code 远程连接', 'error')
    } finally {
      setVsCodeConnectingId(null)
    }
  }

  const createTerminalSession = (server: ServerProfile, accessRouteId: string): ServerTerminalSession => {
    const session = {
      id: crypto.randomUUID(),
      name: `SSH ${nextTerminalNumber.current++}`,
      server,
      accessRouteId
    }
    setTerminalSessions((current) => [...current, session])
    setActiveTerminalSessionId(session.id)
    return session
  }

  const openServerTerminal = (server: ServerProfile): void => {
    const accessRouteId = accessRouteIdFor(server)
    if (routeNeedsSecret(server, accessRouteId)) {
      notify('请先在服务器认证信息中输入并保存 SSH 密码', 'error')
      setDialogServer(server)
      return
    }
    const existing = terminalSessions.find((session) =>
      session.server.id === server.id && session.accessRouteId === accessRouteId
    )
    const session = existing ?? createTerminalSession(server, accessRouteId)
    setActiveTerminalSessionId(session.id)
    setWorkspace(null)
    setSelectedServerId(server.id)
    setPage('terminals')
  }

  const addTerminalSession = (server: ServerProfile): void => {
    const accessRouteId = accessRouteIdFor(server)
    if (routeNeedsSecret(server, accessRouteId)) {
      notify('请先在服务器认证信息中输入并保存 SSH 密码', 'error')
      setDialogServer(server)
      return
    }
    createTerminalSession(server, accessRouteId)
    setWorkspace(null)
    setSelectedServerId(server.id)
    setPage('terminals')
  }

  const closeTerminalSession = (sessionId: string): void => {
    const sessionIndex = terminalSessions.findIndex((session) => session.id === sessionId)
    if (sessionIndex < 0) return
    const session = terminalSessions[sessionIndex]
    const shouldClose = window.confirm(
      `关闭 ${session.server.name} 的 ${session.name}？\n\n这会断开 SSH，可能中断正在运行的前台命令。`
    )
    if (!shouldClose) return
    setTerminalSessions((current) => current.filter((item) => item.id !== sessionId))
    if (activeTerminalSessionId === sessionId) {
      const nextSession = terminalSessions[sessionIndex + 1] ?? terminalSessions[sessionIndex - 1]
      setActiveTerminalSessionId(nextSession?.id ?? null)
    }
  }

  const openServerDetail = (server: ServerProfile): void => {
    if (page !== 'serverDetail') serverDetailReturnPage.current = page
    setWorkspace(null)
    setSelectedServerId(server.id)
    setPage('serverDetail')
    if (server.monitorPolicy === 'onView') void refreshSnapshots([server], { force: true })
  }

  const testServer = async (server: ServerProfile): Promise<void> => {
    setTestingId(server.id)
    try {
      const accessRouteId = accessRouteIdFor(server)
      let result: ConnectionTestResult = await window.labApi.servers.test(server.id, accessRouteId)
      for (let attempt = 0; attempt < 2 && result.status === 'host-key-required' && result.fingerprint; attempt += 1) {
        const targetName = result.hostKeyTarget === 'jumpHost' ? '跳板机' : '目标服务器'
        const trusted = window.confirm(
          `首次连接 ${server.name} 的${targetName}，请通过可信渠道核对主机指纹：\n\n${result.fingerprint}\n\n确认信任该主机吗？`
        )
        if (!trusted) break
        await window.labApi.servers.trustHost(server.id, result.fingerprint, result.hostKeyTarget, accessRouteId)
        await loadServers()
        result = await window.labApi.servers.test(server.id, accessRouteId)
      }
      if (result.status === 'success') {
        notify(`${server.name}：${result.message}${result.latencyMs ? `（${result.latencyMs} ms）` : ''}`)
        const snapshot = await window.labApi.monitor.snapshot(server.id, accessRouteId)
        delete retryState.current[server.id]
        setSnapshots((current) => ({ ...current, [server.id]: snapshot }))
      } else if (result.status === 'failed') {
        notify(`${server.name}：${result.message}`, 'error')
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '连接测试失败', 'error')
    } finally {
      setTestingId(null)
    }
  }

  const mergeServerPath = async (source: ServerProfile): Promise<void> => {
    const targetName = baseServerName(source.name)
    const target = servers.find((candidate) => candidate.id !== source.id && candidate.name.trim().toLowerCase() === targetName.toLowerCase())
    if (!target) {
      notify(`没有找到与“${source.name}”对应的主服务器记录`, 'error')
      return
    }
    if (!window.confirm(`将“${source.name}”作为“${target.name}”的备用连接路径并移除重复卡片？\n\n目标服务器、监控历史和 GPU 任务会保留；${source.name} 的地址会作为“跳板机”保存。`)) return
    try {
      await window.labApi.servers.mergeAccessRoute(target.id, source.id)
      await loadServers()
      if (selectedServerId === source.id) {
        setSelectedServerId(target.id)
        setPage('serverDetail')
      }
      notify(`已将“${source.name}”合并为“${target.name}”的连接路径`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '合并连接路径失败', 'error')
    }
  }

  const removeServer = async (server: ServerProfile): Promise<void> => {
    if (!window.confirm(`确定删除“${server.name}”吗？本机保存的该服务器凭据也会被删除。`)) return
    await window.labApi.servers.remove(server.id)
    if (selectedServerId === server.id) {
      setSelectedServerId(null)
      setPage('servers')
    }
    setServers((current) => current.filter((item) => item.id !== server.id))
    setSettings((current) => ({ ...current, gpuWatches: current.gpuWatches.filter((watch) => watch.serverId !== server.id) }))
    setSnapshots((current) => {
      const next = { ...current }
      delete next[server.id]
      return next
    })
    notify('服务器已删除')
  }

  const saveSettings = async (): Promise<void> => {
    try {
      setSettings(await window.labApi.settings.save(settings))
      notify('设置已保存')
    } catch (error) {
      notify(error instanceof Error ? error.message : '设置保存失败', 'error')
    }
  }

  const toggleGpuWatch = async (target: GpuWatchTarget): Promise<void> => {
    const matches = (watch: GpuWatchTarget): boolean => watch.serverId === target.serverId && watch.gpuUuid === target.gpuUuid
    const alreadyWatched = settings.gpuWatches.some(matches)
    const nextSettings: AppSettings = {
      ...settings,
      gpuWatches: alreadyWatched
        ? settings.gpuWatches.filter((watch) => !matches(watch))
        : [...settings.gpuWatches, target]
    }
    setSettings(nextSettings)
    try {
      const saved = await window.labApi.settings.save(nextSettings)
      setSettings(saved)
      const server = servers.find((item) => item.id === target.serverId)
      const targetName = target.gpuUuid
        ? `${server?.name ?? '服务器'} 的 GPU`
        : server?.name ?? '服务器'
      notify(alreadyWatched ? `已取消关注 ${targetName}` : `已关注 ${targetName}，空闲时将发送通知`)
      if (!alreadyWatched && server) void refreshSnapshots([server], { force: true })
    } catch (error) {
      setSettings(settings)
      notify(error instanceof Error ? error.message : '关注设置保存失败', 'error')
    }
  }

  const importSshConfig = async (): Promise<void> => {
    setImportingConfig(true)
    try {
      const result = await window.labApi.sshConfig.importAll()
      await loadServers()
      setSshConfigCount(0)
      if (result.imported.length) {
        notify(`已从 ${result.configPath} 导入 ${result.imported.length} 台服务器`)
      } else {
        notify(result.skipped.length ? 'SSH Config 中的服务器均已导入' : '未发现可导入的具体 Host', 'error')
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'SSH Config 导入失败', 'error')
    } finally {
      setImportingConfig(false)
    }
  }

  const goToPage = (nextPage: Page): void => {
    setPage(nextPage)
    if (workspace?.type === 'localTerminal') setWorkspace(null)
  }

  const resolveCloseAction = async (action: 'tray' | 'exit' | 'cancel'): Promise<void> => {
    setClosePromptOpen(false)
    try {
      const saved = await window.labApi.windowControls.resolveCloseAction(action, rememberCloseChoice)
      setSettings(saved)
    } catch (error) {
      notify(error instanceof Error ? error.message : '关闭操作失败', 'error')
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><LabDeckMark /></div>
          <div className="brand-wordmark"><strong>LabDeck</strong><span>实验室算力工作台</span></div>
        </div>
        <nav>
          <div className="nav-caption">工作区</div>
          <NavButton active={workspace?.type !== 'localTerminal' && page === 'dashboard'} icon={<LayoutDashboard size={18} />} label="运行总览" onClick={() => goToPage('dashboard')} />
          <NavButton active={workspace?.type !== 'localTerminal' && page === 'gpus'} icon={<Cpu size={18} />} label="GPU 资源" badge={summary.gpuCount} onClick={() => goToPage('gpus')} />
          <NavButton active={workspace?.type !== 'localTerminal' && (page === 'servers' || page === 'serverDetail')} icon={<ServerIcon size={18} />} label="服务器" badge={servers.length} onClick={() => goToPage('servers')} />
          <NavButton active={workspace?.type !== 'localTerminal' && page === 'tasks'} icon={<ListTodo size={18} />} label="我的任务" badge={myTasks.length} onClick={() => goToPage('tasks')} />
          <NavButton active={workspace?.type !== 'localTerminal' && page === 'terminals'} icon={<SquareTerminal size={18} />} label="SSH 终端" badge={terminalSessions.length || undefined} onClick={() => goToPage('terminals')} />
          <NavButton active={workspace?.type === 'localTerminal'} icon={<SquareTerminal size={18} />} label="本地终端" onClick={() => setWorkspace({ type: 'localTerminal' })} />
          <div className="nav-caption second server-shortcut-caption"><span>服务器快捷入口</span><b>{servers.length}</b></div>
          <div className="sidebar-server-list">
            {servers.map((server) => <SidebarServerLink key={server.id} server={server} snapshot={snapshots[server.id]} active={workspace?.type !== 'localTerminal' && page === 'serverDetail' && selectedServerId === server.id} onClick={() => openServerDetail(server)} />)}
            {!servers.length && <span className="sidebar-server-empty">还没有服务器</span>}
          </div>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-badge"><ShieldCheck size={16} /><div><strong>本地安全模式</strong><span>凭据由 Windows 加密</span></div></div>
          <button type="button" className={`sidebar-settings-entry ${workspace?.type !== 'localTerminal' && page === 'settings' ? 'active' : ''}`} onClick={() => goToPage('settings')}>
            <Settings size={18} />
            <span><strong>偏好设置</strong><small>主题、监控与通知</small></span>
            <ChevronRight size={16} />
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="page-heading">
            <h1>{workspace?.type === 'localTerminal' ? '本地终端' : page === 'serverDetail' ? (selectedServer?.name ?? '服务器详情') : page === 'dashboard' ? '运行总览' : page === 'gpus' ? 'GPU 资源' : page === 'tasks' ? '我的任务' : page === 'servers' ? '服务器管理' : page === 'terminals' ? 'SSH 终端' : page === 'alerts' ? '告警中心' : '偏好设置'}</h1>
            <p>{workspace?.type === 'localTerminal' ? '独立 PowerShell 会话，不依赖服务器连接' : page === 'serverDetail' && selectedServer ? (() => { const route = getAccessRoute(selectedServer, accessRouteIdFor(selectedServer)); return `${route.host}:${route.port} · ${routeLabel(selectedServer, accessRouteIdFor(selectedServer))} · ${statusLabel(snapshots[selectedServer.id])}` })() : page === 'terminals' ? `${terminalSessions.length} 个 SSH 会话 · 切换页面后连接会继续运行` : page === 'tasks' ? `按 SSH 用户名汇总 · ${myTasks.length} 个运行中进程` : new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</p>
          </div>
          <div className="topbar-actions">
            {workspace?.type !== 'localTerminal' && (page === 'dashboard' || page === 'servers') && <div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索服务器、IP 或标签" /></div>}
            <button
              type="button"
              className={`icon-button top title-alert-button ${workspace?.type !== 'localTerminal' && page === 'alerts' ? 'active' : ''} ${alerts.length ? 'has-alerts' : ''}`}
              onClick={() => goToPage('alerts')}
              title={alerts.length ? `告警中心（${alerts.length} 条活动告警）` : '告警中心（当前无活动告警）'}
              aria-label={alerts.length ? `打开告警中心，当前有 ${alerts.length} 条活动告警` : '打开告警中心，当前无活动告警'}
            >
              <Bell size={18} />
              {alerts.length > 0 && <span aria-hidden="true">{alerts.length > 99 ? '99+' : alerts.length}</span>}
            </button>
            {workspace?.type !== 'localTerminal' && page !== 'terminals' && page !== 'serverDetail' && <button className="icon-button top" onClick={() => void refreshSnapshots(servers, { force: true })} title="手动刷新全部服务器"><RefreshCw size={18} className={refreshing ? 'spin' : ''} /></button>}
            {workspace?.type !== 'localTerminal' && (page === 'dashboard' || page === 'servers') && <button className="secondary-button import-button" onClick={() => void importSshConfig()} disabled={importingConfig}><FileDown size={16} />{importingConfig ? '正在读取…' : '导入 SSH Config'}{sshConfigCount > 0 && <b>{sshConfigCount}</b>}</button>}
            {workspace?.type !== 'localTerminal' && page !== 'terminals' && <button className="primary-button" onClick={() => setDialogServer(null)}><Plus size={17} />添加服务器</button>}
          </div>
          <div className="window-controls" aria-label="窗口控制">
            <button onClick={() => window.labApi.windowControls.minimize()} title="最小化" aria-label="最小化"><Minus size={16} /></button>
            <button onClick={() => void window.labApi.windowControls.toggleMaximize().then(setWindowMaximized)} title={windowMaximized ? '还原窗口' : '最大化'} aria-label={windowMaximized ? '还原窗口' : '最大化'}>{windowMaximized ? <Copy size={13} /> : <Square size={12} />}</button>
            <button className="window-close" onClick={() => window.labApi.windowControls.close()} title="关闭" aria-label="关闭"><X size={15} /></button>
          </div>
        </header>

        <div className={`page-content ${workspace?.type === 'localTerminal' ? 'local-terminal-page' : page === 'serverDetail' ? 'server-detail-page-content' : ''} ${workspace?.type !== 'localTerminal' && page === 'terminals' ? 'ssh-terminal-page' : ''}`}>
          {workspace?.type === 'localTerminal' ? <LocalTerminalWorkspace onClose={() => setWorkspace(null)} /> : loading ? <LoadingState /> : page === 'dashboard' ? (
            <Dashboard servers={filteredServers} snapshots={snapshots} summary={summary} alerts={alerts} testingId={testingId} vscodeConnectingId={vscodeConnectingId} accessRouteId={accessRouteIdFor} onAccessRouteChange={selectAccessRoute} onOverview={openServerDetail} onTest={testServer} onTerminal={openServerTerminal} onSftp={openSftp} onVsCode={(server) => void openVsCode(server)} onGpu={(server, gpuIndex) => setGpuSelection({ server, gpuIndex })} onEdit={(server) => setDialogServer(server)} onRemove={removeServer} onMerge={mergeServerPath} />
          ) : page === 'gpus' ? (
            <GpuOverview servers={filteredServers} snapshots={snapshots} watches={settings.gpuWatches} onToggleWatch={(target) => void toggleGpuWatch(target)} onSelect={(server, gpuIndex) => setGpuSelection({ server, gpuIndex })} />
          ) : page === 'tasks' ? (
            <MyTasksPage tasks={myTasks} onOpenGpu={(server, gpuIndex) => setGpuSelection({ server, gpuIndex })} />
          ) : page === 'servers' ? (
            <ServerTable servers={filteredServers} snapshots={snapshots} testingId={testingId} vscodeConnectingId={vscodeConnectingId} accessRouteId={accessRouteIdFor} onAccessRouteChange={selectAccessRoute} onOverview={openServerDetail} onTest={testServer} onTerminal={openServerTerminal} onSftp={openSftp} onVsCode={(server) => void openVsCode(server)} onGpu={(server, gpuIndex) => setGpuSelection({ server, gpuIndex })} onEdit={(server) => setDialogServer(server)} onRemove={removeServer} onMerge={mergeServerPath} />
          ) : page === 'serverDetail' && selectedServer ? (
            <ServerDetailPage key={selectedServer.id} server={selectedServer} snapshot={snapshots[selectedServer.id]} refreshing={refreshing} accessRouteId={accessRouteIdFor(selectedServer)} onAccessRouteChange={(routeId) => selectAccessRoute(selectedServer, routeId)} vscodeConnecting={vscodeConnectingId === selectedServer.id} onTerminal={() => openServerTerminal(selectedServer)} onRefresh={() => void refreshSnapshots([selectedServer], { force: true })} onSftp={() => openSftp(selectedServer)} onVsCode={() => void openVsCode(selectedServer)} onEdit={() => setDialogServer(selectedServer)} onGpu={(gpuIndex) => setGpuSelection({ server: selectedServer, gpuIndex })} />
          ) : page === 'terminals' ? null : page === 'alerts' ? (
            <AlertsPage alerts={alerts} />
          ) : (
            <SettingsPage settings={settings} onChange={setSettings} onSave={saveSettings} />
          )}
          <ServerTerminalWorkspace
            sessions={terminalSessions}
            activeId={activeTerminalSessionId}
            visible={!loading && workspace?.type !== 'localTerminal' && page === 'terminals'}
            servers={servers}
            accessRouteIdFor={accessRouteIdFor}
            onActivate={setActiveTerminalSessionId}
            onAdd={addTerminalSession}
            onClose={closeTerminalSession}
            onOpenFiles={(session) => {
              const server = servers.find((item) => item.id === session.server.id) ?? session.server
              openSftp(server, session.accessRouteId)
            }}
            onOpenServerFiles={(server) => openSftp(server)}
            onTrusted={async () => { await loadServers() }}
          />
        </div>
      </main>

      {dialogServer !== undefined && <ServerDialog server={dialogServer} onClose={() => setDialogServer(undefined)} onSaved={(server) => void saved(server)} />}
      {gpuSelection && <GpuDetailPanel server={gpuSelection.server} snapshot={snapshots[gpuSelection.server.id]} initialGpuIndex={gpuSelection.gpuIndex} watches={settings.gpuWatches} onToggleWatch={(gpuUuid) => void toggleGpuWatch({ serverId: gpuSelection.server.id, gpuUuid })} onClose={() => setGpuSelection(null)} />}
      {closePromptOpen && <ClosePrompt remember={rememberCloseChoice} onRememberChange={setRememberCloseChoice} onChoose={(action) => void resolveCloseAction(action)} />}
      <div className="toast-stack">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}<span>{toast.message}</span></div>)}</div>
    </div>
  )
}

function NavButton({ active, icon, label, badge, danger, onClick }: { active: boolean; icon: React.ReactNode; label: string; badge?: number; danger?: boolean; onClick(): void }): React.JSX.Element {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{badge !== undefined && <b className={danger ? 'danger' : ''}>{badge}</b>}</button>
}

function SidebarServerLink({ server, snapshot, active, onClick }: { server: ServerProfile; snapshot?: ServerSnapshot; active: boolean; onClick(): void }): React.JSX.Element {
  const visualStatus = snapshot?.cached ? 'cached' : snapshot?.status ?? 'unknown'
  const busyCount = snapshot?.gpus.filter(isGpuBusy).length ?? 0
  return <button type="button" className={`sidebar-server-link ${active ? 'active' : ''}`} onClick={onClick} title={`${server.name} · ${statusLabel(snapshot)}`}><i className={visualStatus} /><span>{server.name}</span>{snapshot?.gpus.length ? <b>{busyCount}/{snapshot.gpus.length}</b> : null}</button>
}

interface CommonServerActions {
  testingId: string | null
  vscodeConnectingId: string | null
  accessRouteId(server: ServerProfile): string
  onAccessRouteChange(server: ServerProfile, routeId: string): void
  onOverview(server: ServerProfile): void
  onTest(server: ServerProfile): void
  onTerminal(server: ServerProfile): void
  onSftp(server: ServerProfile): void
  onVsCode(server: ServerProfile): void
  onGpu(server: ServerProfile, gpuIndex: number): void
  onEdit(server: ServerProfile): void
  onRemove(server: ServerProfile): void
  onMerge(server: ServerProfile): void
}

function Dashboard({ servers, snapshots, summary, alerts, ...actions }: { servers: ServerProfile[]; snapshots: Record<string, ServerSnapshot>; summary: { online: number; warning: number; gpuCount: number; averageGpu: number }; alerts: Array<{ server: ServerProfile; level: 'critical' | 'warning'; title: string; detail: string }> } & CommonServerActions): React.JSX.Element {
  return <>
    <section className="summary-grid">
      <SummaryCard tone="teal" icon={<ServerIcon size={20} />} label="在线服务器" value={`${summary.online}/${servers.length}`} hint="本地轮询状态" />
      <SummaryCard tone="blue" icon={<Cpu size={20} />} label="GPU 设备" value={String(summary.gpuCount)} hint={`平均利用率 ${Math.round(summary.averageGpu)}%`} />
      <SummaryCard tone="amber" icon={<AlertTriangle size={20} />} label="需要关注" value={String(alerts.length)} hint={alerts.length ? `${summary.warning} 台服务器有告警` : '当前无活动告警'} />
      <SummaryCard tone="violet" icon={<Gauge size={20} />} label="采集模式" value="本地" hint="Agentless · SSH" />
    </section>

    <section className="section-block">
      <div className="section-header"><div><h2>服务器状态</h2><p>点击终端或文件按钮开始操作真实服务器</p></div><span className="live-indicator"><i />本地实时采集</span></div>
      <div className="server-grid">
        {servers.map((server) => <ServerCard key={server.id} server={server} snapshot={snapshots[server.id]} {...actions} />)}
        {!servers.length && <EmptyServers />}
      </div>
    </section>

    <section className="dashboard-lower">
      <div className="panel recent-alerts"><div className="panel-title"><div><h3>活动告警</h3><p>磁盘、温度与连接状态</p></div><Bell size={19} /></div>{alerts.length ? alerts.slice(0, 4).map((alert, index) => <div className="alert-row" key={`${alert.server.id}-${index}`}><div className={`alert-icon ${alert.level}`}><AlertTriangle size={16} /></div><div><strong>{alert.title}</strong><span>{alert.server.name} · {alert.detail}</span></div><time>刚刚</time></div>) : <div className="healthy-state"><CheckCircle2 size={30} /><strong>一切正常</strong><span>当前没有需要处理的告警</span></div>}</div>
      <div className="panel quick-guide"><div className="panel-title"><div><h3>Demo 使用指引</h3><p>三步连接第一台真实服务器</p></div><ShieldCheck size={19} /></div><ol><li><b>1</b><div><strong>添加连接</strong><span>填写服务器地址和个人 SSH 凭据</span></div></li><li><b>2</b><div><strong>核对主机指纹</strong><span>首次连接时通过可信渠道确认</span></div></li><li><b>3</b><div><strong>终端与监控</strong><span>应用自动采集只读指标并打开 Shell</span></div></li></ol></div>
    </section>
  </>
}

function SummaryCard({ tone, icon, label, value, hint }: { tone: string; icon: React.ReactNode; label: string; value: string; hint: string }): React.JSX.Element {
  return <div className="summary-card"><div className={`summary-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></div>
}

function ServerCard({ server, snapshot, testingId, vscodeConnectingId, accessRouteId, onAccessRouteChange, onOverview, onTest, onTerminal, onSftp, onVsCode, onGpu, onEdit, onRemove, onMerge }: { server: ServerProfile; snapshot?: ServerSnapshot } & CommonServerActions): React.JSX.Element {
  const memoryPercent = snapshot?.memoryTotalBytes && snapshot.memoryUsedBytes ? snapshot.memoryUsedBytes / snapshot.memoryTotalBytes * 100 : null
  const disk = snapshot?.fileSystems.find((item) => item.mountPoint === '/') ?? snapshot?.fileSystems[0]
  const gpus = snapshot?.gpus ?? []
  const busyGpuCount = gpus.filter(isGpuBusy).length
  const primaryGpu = [...gpus].sort((left, right) => {
    const processDifference = right.processes.length - left.processes.length
    return processDifference || right.utilizationPercent - left.utilizationPercent || right.memoryUsedMiB - left.memoryUsedMiB
  })[0]
  const peakGpuTemperature = gpus.reduce((maximum, gpu) => Math.max(maximum, gpu.temperatureC), 0)
  const offline = snapshot?.status === 'offline' && !snapshot.cached
  const visualStatus = snapshot?.cached ? 'cached' : snapshot?.status ?? 'unknown'
  const selectedRouteId = accessRouteId(server)
  const selectedRoute = getAccessRoute(server, selectedRouteId)
  return <article className={`server-card status-${visualStatus}`}>
    <div className="server-card-head"><button type="button" className="server-title server-title-button" onClick={() => onOverview(server)} title="打开服务器总览"><div className="server-symbol"><ServerIcon size={20} /></div><div><div className="name-row"><h3>{server.name}</h3>{server.mode === 'demo' && <span className="demo-chip">演示</span>}</div><p>{selectedRoute.username}@{selectedRoute.host}:{selectedRoute.port}</p></div></button><div className={`status-dot ${visualStatus}`} title={statusLabel(snapshot)} /></div>
    <div className="server-meta"><span className="monitor-policy-chip">采集：{monitorPolicyLabel[server.monitorPolicy]}</span><span>{server.group}</span>{server.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
    {offline ? <div className="offline-message"><WifiOff size={18} /><div><strong>暂时无法连接</strong><span>{snapshot.error}</span></div></div> : <div className="metric-list">
      <MetricRow icon={<Cpu size={15} />} label="CPU" value={formatPercent(snapshot?.cpuUsagePercent)} percent={snapshot?.cpuUsagePercent ?? 0} />
      <MetricRow icon={<MemoryStick size={15} />} label="内存" value={formatPercent(memoryPercent)} percent={memoryPercent ?? 0} />
      <MetricRow icon={<HardDrive size={15} />} label="系统盘" value={formatPercent(disk?.usagePercent)} percent={disk?.usagePercent ?? 0} warn={(disk?.usagePercent ?? 0) >= 80} />
      {primaryGpu && <button className="gpu-metric-button" onClick={() => onGpu(server, primaryGpu.index)} title="查看每块 GPU 和当前进程"><MetricRow icon={<Activity size={15} />} label="GPU" value={`${busyGpuCount}/${gpus.length}`} percent={gpus.length ? busyGpuCount / gpus.length * 100 : 0} warn={peakGpuTemperature >= 80} /></button>}
    </div>}
    <div className="server-card-foot"><AccessRouteSelect server={server} value={selectedRouteId} onChange={(routeId) => onAccessRouteChange(server, routeId)} /><div className="card-actions">{isLegacyJumpProfile(server.name) && <button onClick={() => onMerge(server)} title="将此条目合并为主服务器的连接路径"><GitMerge size={15} /></button>}<button onClick={() => onTest(server)} disabled={testingId === server.id} title="测试连接"><RefreshCw size={15} className={testingId === server.id ? 'spin' : ''} /></button><button onClick={() => onSftp(server)} title="独立文件传输窗口"><FolderOpen size={15} /></button><button className="server-vscode-action" onClick={() => onVsCode(server)} disabled={vscodeConnectingId === server.id} title={vscodeConnectingId === server.id ? 'VS Code 连接中' : '独立 VS Code Remote-SSH 窗口'} aria-label={vscodeConnectingId === server.id ? 'VS Code 连接中' : '打开 VS Code'}><Code2 size={15} /></button><button className="terminal-action" onClick={() => onTerminal(server)} title="打开终端" aria-label="打开终端"><SquareTerminal size={15} /></button><button onClick={() => onEdit(server)} title="编辑"><Pencil size={14} /></button><button onClick={() => onRemove(server)} title="删除"><Trash2 size={14} /></button></div></div>
  </article>
}

function MetricRow({ icon, label, value, percent, detail, warn }: { icon: React.ReactNode; label: string; value: string; percent: number; detail?: string; warn?: boolean }): React.JSX.Element {
  const level = warn || percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : percent >= 40 ? 'active' : 'normal'
  return <div className={`metric-row load-${level}`}><div className="metric-label">{icon}<span>{label}</span></div><div className="metric-track"><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div><strong>{value}</strong>{detail && <small>{detail}</small>}</div>
}

function ServerTable({ servers, snapshots, ...actions }: { servers: ServerProfile[]; snapshots: Record<string, ServerSnapshot> } & CommonServerActions): React.JSX.Element {
  return <section className="panel server-table-panel"><div className="table-heading"><div><h2>全部服务器</h2><p>{servers.length} 台物理服务器 · 每台可切换连接路径</p></div></div><div className="server-table"><div className="server-table-head"><span>服务器</span><span>状态</span><span>资源摘要</span><span>分组/标签</span><span>操作</span></div>{servers.map((server) => {
    const snapshot = snapshots[server.id]
    const disk = snapshot?.fileSystems.find((fileSystem) => fileSystem.mountPoint === '/') ?? snapshot?.fileSystems[0]
    const visualStatus = snapshot?.cached ? 'cached' : snapshot?.status ?? 'unknown'
    const busyGpus = snapshot?.gpus.filter(isGpuBusy) ?? []
    const firstGpuIndex = busyGpus[0]?.index ?? snapshot?.gpus[0]?.index
    const selectedRoute = getAccessRoute(server, actions.accessRouteId(server))
    return <div className="server-table-row" key={server.id}><button type="button" className="table-server table-server-button" onClick={() => actions.onOverview(server)}><div className="server-symbol small"><ServerIcon size={17} /></div><div><strong>{server.name}</strong><span>{selectedRoute.host}:{selectedRoute.port} · {selectedRoute.username}</span></div></button><div><span className={`table-status ${visualStatus}`}><i />{statusLabel(snapshot)}</span><small className="table-policy">{monitorPolicyLabel[server.monitorPolicy]}采集</small></div><div className="resource-summary"><span><Cpu size={14} />{formatPercent(snapshot?.cpuUsagePercent)}</span><span><MemoryStick size={14} />{snapshot?.memoryUsedBytes ? formatBytes(snapshot.memoryUsedBytes) : '—'}</span><span><HardDrive size={14} />{formatPercent(disk?.usagePercent)}</span>{snapshot?.gpus.length && firstGpuIndex !== undefined ? <button onClick={() => actions.onGpu(server, firstGpuIndex)}><Activity size={14} />{busyGpus.length}/{snapshot.gpus.length} 忙碌</button> : null}</div><div className="table-tags"><b>{server.group}</b>{server.tags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}</div><div className="table-actions"><AccessRouteSelect server={server} value={actions.accessRouteId(server)} compact onChange={(routeId) => actions.onAccessRouteChange(server, routeId)} />{isLegacyJumpProfile(server.name) && <button className="icon-button small" onClick={() => actions.onMerge(server)} title="将此条目合并为主服务器的连接路径"><GitMerge size={15} /></button>}<button className="icon-button small" onClick={() => actions.onTest(server)}><RefreshCw size={15} className={actions.testingId === server.id ? 'spin' : ''} /></button><button className="icon-button small" onClick={() => actions.onSftp(server)} title="独立文件传输窗口"><FolderOpen size={15} /></button><button className="icon-button small server-vscode-icon" onClick={() => actions.onVsCode(server)} disabled={actions.vscodeConnectingId === server.id} title="独立 VS Code Remote-SSH 窗口"><Code2 size={15} /></button><button className="table-terminal" onClick={() => actions.onTerminal(server)}><SquareTerminal size={15} />终端</button><button className="icon-button small" onClick={() => actions.onEdit(server)}><Pencil size={14} /></button><button className="icon-button small danger-hover" onClick={() => actions.onRemove(server)}><Trash2 size={14} /></button></div></div>
  })}</div></section>
}

function MyTasksPage({ tasks, onOpenGpu }: { tasks: UserGpuTask[]; onOpenGpu(server: ServerProfile, gpuIndex: number): void }): React.JSX.Element {
  const serverCount = new Set(tasks.map((task) => task.server.id)).size
  const gpuCount = new Set(tasks.map((task) => `${task.server.id}:${task.gpuIndex}`)).size
  const memoryMiB = tasks.reduce((sum, task) => sum + task.process.memoryUsedMiB, 0)
  return <section className="my-tasks-page">
    <div className="my-task-summary">
      <div><ListTodo size={18} /><span>运行中任务</span><strong>{tasks.length}</strong></div>
      <div><ServerIcon size={18} /><span>涉及服务器</span><strong>{serverCount}</strong></div>
      <div><Cpu size={18} /><span>占用 GPU</span><strong>{gpuCount}</strong></div>
      <div><MemoryStick size={18} /><span>任务显存</span><strong>{memoryMiB >= 1024 ? `${(memoryMiB / 1024).toFixed(1)} GB` : `${Math.round(memoryMiB)} MB`}</strong></div>
    </div>
    <div className="my-task-panel">
      <div className="my-task-heading"><div><h2>当前 GPU 任务</h2><p>仅展示进程用户名与服务器 SSH 用户名一致的实时任务</p></div><span>{tasks.length} 个进程</span></div>
      {tasks.length ? <div className="my-task-table">
        <div className="my-task-table-head"><span>任务</span><span>服务器 / GPU</span><span>运行时长</span><span>显存占用</span><span /></div>
        {tasks.map((task) => <button type="button" className="my-task-row" key={`${task.server.id}-${task.gpuIndex}-${task.process.pid}`} onClick={() => onOpenGpu(task.server, task.gpuIndex)}>
          <span className="my-task-process"><i><ListTodo size={15} /></i><span><strong title={task.process.processName}>{task.process.processName}</strong><small>PID {task.process.pid} · {task.process.username}</small></span></span>
          <span className="my-task-target"><strong>{task.server.name} · GPU {task.gpuIndex}</strong><small>{task.gpuName.replace('NVIDIA ', '')}</small></span>
          <time>{formatTaskDuration(task.process.elapsedSeconds)}</time>
          <b>{task.process.memoryUsedMiB >= 1024 ? `${(task.process.memoryUsedMiB / 1024).toFixed(1)} GB` : `${Math.round(task.process.memoryUsedMiB)} MB`}</b>
          <ChevronRight size={16} />
        </button>)}
      </div> : <div className="my-task-empty"><ListTodo size={38} /><strong>当前没有检测到你的 GPU 任务</strong><span>任务按各服务器配置的 SSH 用户名识别；点击顶部刷新可立即重新采集。</span></div>}
    </div>
  </section>
}

function GpuOverview({ servers, snapshots, watches, onToggleWatch, onSelect }: { servers: ServerProfile[]; snapshots: Record<string, ServerSnapshot>; watches: GpuWatchTarget[]; onToggleWatch(target: GpuWatchTarget): void; onSelect(server: ServerProfile, gpuIndex: number): void }): React.JSX.Element {
  const devices = servers.flatMap((server) => {
    const snapshot = snapshots[server.id]
    return (snapshot?.gpus ?? []).map((gpu) => ({ server, gpu, cached: Boolean(snapshot?.cached) }))
  })
  const [statusFilter, setStatusFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')
  const [serverFilter, setServerFilter] = useState('all')
  const liveDevices = devices.filter(({ cached }) => !cached)
  const idleCount = liveDevices.filter(({ gpu }) => gpuLoadState(gpu) === 'idle').length
  const busyCount = liveDevices.filter(({ gpu }) => isGpuBusy(gpu)).length
  const totalMemory = devices.reduce((sum, { gpu }) => sum + gpu.memoryTotalMiB, 0)
  const usedMemory = devices.reduce((sum, { gpu }) => sum + gpu.memoryUsedMiB, 0)
  const models = [...new Set(devices.map(({ gpu }) => gpu.name))].sort()
  const deviceServers = [...new Map(devices.map(({ server }) => [server.id, server])).values()]
  const recommendations = liveDevices
    .map((item) => ({ ...item, recommendation: gpuRecommendation(item.gpu) }))
    .sort((left, right) => right.recommendation.score - left.recommendation.score)
    .slice(0, 3)
  const filtered = devices.filter(({ server, gpu }) => {
    const state = gpuLoadState(gpu)
    const statusMatches = statusFilter === 'all' || (statusFilter === 'busy' ? isGpuBusy(gpu) : state === statusFilter)
    return statusMatches &&
      (modelFilter === 'all' || gpu.name === modelFilter) &&
      (serverFilter === 'all' || server.id === serverFilter)
  })
  const resetFilters = (): void => {
    setStatusFilter('all')
    setModelFilter('all')
    setServerFilter('all')
  }
  const selectedFilterServer = deviceServers.find((server) => server.id === serverFilter)
  const selectedServerWatched = selectedFilterServer
    ? watches.some((watch) => watch.serverId === selectedFilterServer.id && !watch.gpuUuid)
    : false
  return <>
    <section className="gpu-pool-summary">
      <div><Activity size={20} /><span>GPU 总数</span><strong>{devices.length}</strong></div>
      <div className="idle"><CheckCircle2 size={20} /><span>空闲</span><strong>{idleCount}</strong></div>
      <div className="busy"><Gauge size={20} /><span>使用中</span><strong>{busyCount}</strong></div>
      <div><MemoryStick size={20} /><span>显存使用</span><strong>{totalMemory ? `${Math.round(usedMemory / totalMemory * 100)}%` : '—'}</strong></div>
    </section>
    <section className="gpu-recommendation-strip">
      <div className="gpu-recommendation-intro"><Zap size={19} /><div><h2>推荐可用 GPU</h2><p>综合显存余量、利用率、温度和进程数量排序</p></div></div>
      {recommendations.length ? <div className="gpu-recommendation-list">{recommendations.map(({ server, gpu, recommendation }, index) => <button type="button" key={`${server.id}-${gpu.uuid}`} onClick={() => onSelect(server, gpu.index)}>
        <span>{index + 1}</span>
        <div><strong>{server.name} · GPU {gpu.index} · {gpu.name.replace('NVIDIA ', '')}</strong><small>{(recommendation.freeMemoryMiB / 1024).toFixed(1)} GB 空闲 · {Math.round(gpu.utilizationPercent)}% 利用率 · {gpu.processes.length} 个进程 · {Math.round(gpu.temperatureC)}°C</small></div>
        <b className={recommendation.score >= 75 ? 'recommended' : recommendation.score >= 50 ? 'available' : 'loaded'}>{recommendation.label}<em>{recommendation.score}</em></b>
      </button>)}</div> : <div className="gpu-recommendation-empty">等待实时 GPU 数据</div>}
    </section>
    <section className="section-block">
      <div className="section-header"><div><h2>GPU 资源池</h2><p>点击任意显卡查看运行用户、进程和历史曲线</p></div><span className="result-count">{filtered.length} / {devices.length} 张</span></div>
      <div className="gpu-filter-bar">
        <label><span>状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部</option><option value="idle">空闲</option><option value="busy">使用中</option><option value="warning">温度告警</option></select></label>
        <label><span>型号</span><select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}><option value="all">全部型号</option>{models.map((model) => <option key={model} value={model}>{model.replace('NVIDIA ', '')}</option>)}</select></label>
        <label><span>服务器</span><select value={serverFilter} onChange={(event) => setServerFilter(event.target.value)}><option value="all">全部服务器</option>{deviceServers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label>
        <button type="button" className={`gpu-server-watch ${selectedServerWatched ? 'active' : ''}`} disabled={!selectedFilterServer} onClick={() => selectedFilterServer && onToggleWatch({ serverId: selectedFilterServer.id })} title={selectedFilterServer ? (selectedServerWatched ? '取消关注这台服务器' : '任意 GPU 空闲时通知我') : '先选择一台服务器'}><Bell size={14} />{selectedServerWatched ? '已关注服务器' : '关注服务器'}</button>
        <button onClick={resetFilters}>重置</button>
      </div>
      {filtered.length ? <div className="gpu-overview-grid">{filtered.map(({ server, gpu, cached }) => {
        const state = gpuLoadState(gpu)
        const memoryPercent = gpuMemoryPercent(gpu)
        const users = [...new Set(gpu.processes.map((process) => process.username))]
        const utilizationLevel = gpu.utilizationPercent >= 90 ? 'critical' : gpu.utilizationPercent >= 70 ? 'warning' : gpu.utilizationPercent >= 40 ? 'active' : 'normal'
        const memoryLevel = memoryPercent >= 90 ? 'critical' : memoryPercent >= 70 ? 'warning' : memoryPercent >= 40 ? 'active' : 'normal'
        const watched = watches.some((watch) => watch.serverId === server.id && (!watch.gpuUuid || watch.gpuUuid === gpu.uuid))
        return <div role="button" tabIndex={0} className={`gpu-overview-card state-${cached ? 'cached' : state}`} key={`${server.id}-${gpu.uuid}`} onClick={() => onSelect(server, gpu.index)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelect(server, gpu.index) } }}>
          <div className="gpu-overview-head"><div className="gpu-chip"><Cpu size={19} /></div><div><span>{server.name}</span><strong>GPU {gpu.index} · {gpu.name.replace('NVIDIA ', '')}</strong></div><i className={cached ? 'cached' : state}>{cached ? '缓存' : state === 'warning' ? '温度告警' : state === 'idle' ? '空闲' : '使用中'}</i></div>
          <div className="gpu-overview-metrics"><div><span>利用率</span><strong>{Math.round(gpu.utilizationPercent)}%</strong></div><div><span>显存</span><strong>{(gpu.memoryUsedMiB / 1024).toFixed(1)} / {(gpu.memoryTotalMiB / 1024).toFixed(0)}G</strong></div><div><span>温度</span><strong>{Math.round(gpu.temperatureC)}°C</strong></div><div><span>功耗</span><strong>{gpu.powerW === null ? '—' : `${Math.round(gpu.powerW)}W`}</strong></div></div>
          <div className="gpu-overview-bars" aria-label="GPU 负载摘要">
            <div className="gpu-overview-bar"><span>GPU 利用率</span><div className={`gpu-overview-track load-${utilizationLevel}`}><i style={{ width: `${Math.min(100, Math.max(0, gpu.utilizationPercent))}%` }} /></div><strong>{Math.round(gpu.utilizationPercent)}%</strong></div>
            <div className="gpu-overview-bar"><span>显存占用</span><div className={`gpu-overview-track load-${memoryLevel}`}><i style={{ width: `${Math.min(100, Math.max(0, memoryPercent))}%` }} /></div><strong>{Math.round(memoryPercent)}%</strong></div>
          </div>
          <div className="gpu-overview-foot"><span><CircleUserRound size={15} />{users.length ? users.join('、') : '暂无运行用户'}</span><b>{watched && <Bell size={13} />}{gpu.processes.length} 个进程 <ChevronRight size={15} /></b></div>
        </div>
      })}</div> : <div className="gpu-empty-page"><Cpu size={40} /><strong>{devices.length ? '没有符合筛选条件的 GPU' : '尚未检测到 GPU'}</strong><span>{devices.length ? '调整筛选条件或重置筛选。' : '刷新监控或检查服务器上的 NVIDIA 驱动。'}</span>{devices.length ? <button onClick={resetFilters}>重置筛选</button> : null}</div>}
    </section>
  </>
}

function AlertsPage({ alerts }: { alerts: Array<{ server: ServerProfile; level: 'critical' | 'warning'; title: string; detail: string }> }): React.JSX.Element {
  return <section className="panel alerts-page"><div className="table-heading"><div><h2>当前活动告警</h2><p>仅在应用运行并能连接服务器时持续检测</p></div><span className="local-only-chip">本地监控</span></div>{alerts.length ? <div className="alert-cards">{alerts.map((alert, index) => <div className={`alert-card ${alert.level}`} key={`${alert.server.id}-${index}`}><div className="alert-icon large"><AlertTriangle size={19} /></div><div><span>{alert.level === 'critical' ? '严重' : '警告'}</span><h3>{alert.title}</h3><p>{alert.server.name} · {alert.detail}</p></div><time>{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>)}</div> : <div className="healthy-state large"><CheckCircle2 size={42} /><strong>当前没有活动告警</strong><span>保持应用在后台运行可继续检测服务器状态</span></div>}</section>
}

function ClosePrompt({ remember, onRememberChange, onChoose }: { remember: boolean; onRememberChange(value: boolean): void; onChoose(action: 'tray' | 'exit' | 'cancel'): void }): React.JSX.Element {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onChoose('cancel')
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onChoose])

  return <div className="close-choice-overlay app-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onChoose('cancel') }}>
    <section className="close-choice-dialog app-modal" role="dialog" aria-modal="true" aria-labelledby="close-choice-title">
      <div className="close-choice-rail"><div className="close-choice-mark"><LabDeckMark /></div><span>后台服务</span></div>
      <div className="close-choice-content">
        <header><div><h2 id="close-choice-title">关闭 LabDeck？</h2><p>你可以让监控继续运行，或者完全退出应用。</p></div><button type="button" className="close-choice-dismiss" onClick={() => onChoose('cancel')} title="取消关闭"><X size={17} /></button></header>
        <div className="close-choice-actions">
          <button type="button" className="close-choice-action tray" autoFocus onClick={() => onChoose('tray')}><span className="close-choice-action-icon"><Bell size={18} /></span><span><strong>留在系统托盘</strong><small>隐藏主窗口，SSH 会话和监控继续运行</small></span><ChevronRight size={17} /></button>
          <button type="button" className="close-choice-action exit" onClick={() => onChoose('exit')}><span className="close-choice-action-icon"><Power size={18} /></span><span><strong>退出应用</strong><small>关闭 SSH，前台命令可能中断；停止后台监控</small></span><ChevronRight size={17} /></button>
        </div>
        <footer><button type="button" className={`close-choice-remember ${remember ? 'checked' : ''}`} role="checkbox" aria-checked={remember} onClick={() => onRememberChange(!remember)}><i>{remember && <Check size={12} />}</i><span>记住我的选择</span></button><button type="button" className="close-choice-cancel" onClick={() => onChoose('cancel')}>取消</button></footer>
      </div>
    </section>
  </div>
}

function SettingsPage({ settings, onChange, onSave }: { settings: AppSettings; onChange(settings: AppSettings): void; onSave(): void }): React.JSX.Element {
  return <div className="settings-page-stack">
    <section className="panel appearance-panel">
      <div className="panel-title"><div><h3>界面主题</h3><p>选择适合当前环境的控制台外观，切换会立即预览</p></div><LayoutDashboard size={19} /></div>
      <div className="theme-options">
        <ThemeOption name="深海蓝灰" description="低干扰，适合日常运维" value="ocean" selected={settings.theme === 'ocean'} onSelect={() => onChange({ ...settings, theme: 'ocean' })} />
        <ThemeOption name="浅色仪器台" description="明亮环境与投影展示" value="instrument" selected={settings.theme === 'instrument'} onSelect={() => onChange({ ...settings, theme: 'instrument' })} />
        <ThemeOption name="深色机房" description="高对比，适合暗光值守" value="machineRoom" selected={settings.theme === 'machineRoom'} onSelect={() => onChange({ ...settings, theme: 'machineRoom' })} />
      </div>
    </section>
    <div className="settings-layout"><section className="panel settings-panel"><div className="panel-title"><div><h3>监控设置</h3><p>控制持续监控服务器的轮询频率与并发连接</p></div><Gauge size={19} /></div><SettingToggle label="启用后台监控" description="仅定时采集标记为“持续监控”的服务器" checked={settings.monitoringEnabled} onChange={(value) => onChange({ ...settings, monitoringEnabled: value })} /><SettingToggle label="告警系统通知" description="发现离线、磁盘或温度异常时通知" checked={settings.notifyOnWarning} onChange={(value) => onChange({ ...settings, notifyOnWarning: value })} /><label className="settings-field"><div><strong>关闭窗口时</strong><span>退出会关闭 SSH，前台命令可能中断</span></div><select value={settings.closeBehavior} onChange={(event) => onChange({ ...settings, closeBehavior: event.target.value as AppSettings['closeBehavior'] })}><option value="ask">每次询问</option><option value="tray">总是留在系统托盘</option><option value="exit">直接退出应用</option></select></label><label className="settings-field"><div><strong>轮询间隔</strong><span>建议不少于 30 秒，避免频繁建立 SSH 连接</span></div><select value={settings.pollingIntervalSeconds} onChange={(event) => onChange({ ...settings, pollingIntervalSeconds: Number(event.target.value) })}><option value={30}>30 秒</option><option value={60}>60 秒</option><option value={120}>2 分钟</option><option value={300}>5 分钟</option></select></label><label className="settings-field"><div><strong>最大并发采集</strong><span>服务器较多时限制同时建立的 SSH 连接数</span></div><select value={settings.maxConcurrentPolls} onChange={(event) => onChange({ ...settings, maxConcurrentPolls: Number(event.target.value) })}><option value={3}>3 个</option><option value={5}>5 个</option><option value={10}>10 个</option></select></label><div className="settings-footer"><button className="primary-button" onClick={onSave}>保存设置</button></div></section><section className="panel security-panel"><div className="panel-title"><div><h3>安全状态</h3><p>当前应用的安全保护</p></div><ShieldCheck size={19} /></div><div className="security-check"><CheckCircle2 size={17} /><div><strong>进程隔离已启用</strong><span>Renderer 无法直接访问 Node.js</span></div></div><div className="security-check"><CheckCircle2 size={17} /><div><strong>凭据加密存储</strong><span>由当前 Windows 用户的 DPAPI 保护</span></div></div><div className="security-check"><CheckCircle2 size={17} /><div><strong>主机指纹校验</strong><span>首次连接确认，变化时拒绝连接</span></div></div><div className="settings-warning"><AlertTriangle size={17} /><p>退出托盘程序或电脑进入睡眠后，本地监控和告警会停止。</p></div></section></div>
  </div>
}

function ThemeOption({ name, description, value, selected, onSelect }: { name: string; description: string; value: string; selected: boolean; onSelect(): void }): React.JSX.Element {
  return <button type="button" className={`theme-option ${selected ? 'selected' : ''}`} onClick={onSelect}><span className={`theme-preview ${value}`}><i /><i /><i /></span><strong>{name}</strong><small>{description}</small>{selected && <CheckCircle2 size={16} />}</button>
}

function SettingToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <label className="settings-field"><div><strong>{label}</strong><span>{description}</span></div><button type="button" className={`toggle ${checked ? 'active' : ''}`} onClick={() => onChange(!checked)}><i /></button></label>
}

function LoadingState(): React.JSX.Element { return <div className="loading-state"><Activity size={28} className="pulse" /><strong>正在加载本地工作区</strong><span>准备服务器配置与监控数据…</span></div> }
function EmptyServers(): React.JSX.Element { return <div className="empty-servers"><ServerIcon size={34} /><strong>还没有服务器</strong><span>点击右上角“添加服务器”开始</span></div> }
