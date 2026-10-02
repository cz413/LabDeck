import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Check,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Cpu,
  FolderOpen,
  FileDown,
  GitMerge,
  Gauge,
  GripVertical,
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
  Trash2,
  X,
  XCircle
} from 'lucide-react'
import type { AppSettings, ConnectionTestResult, ExperimentTask, GpuMetric, GpuProcessMetric, GpuWatchTarget, MonitorPolicy, ServerProfile, ServerSnapshot } from '@shared/types'
import { isGpuBusy } from '@shared/gpu-status'
import { getAccessRoute, getAccessRoutes, getDefaultAccessRouteId, routeLabel } from '@shared/access-routes'
import { ServerDialog } from './components/ServerDialog'
import { AccessRouteSelect } from './components/AccessRouteSelect'
import { GpuDetailPanel } from './components/GpuDetailPanel'
import { ServerTerminalWorkspace, type ServerTerminalSession, type TerminalWorkspaceSession } from './components/ServerTerminalWorkspace'
import { TerminalDock } from './components/TerminalDock'
import { GpuResourcePool } from './components/GpuResourcePool'
import { ConfirmDialog, type ConfirmationRequest } from './components/ConfirmDialog'
import { ExperimentTaskPool } from './components/ExperimentTaskPool'
import { ResourceWorkbench } from './components/ResourceWorkbench'
import { SftpPanel } from './components/SftpPanel'

type Page = 'gpus' | 'tasks' | 'servers' | 'serverDetail' | 'gpuDetail' | 'terminals' | 'files' | 'alerts' | 'settings'
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
  pollingIntervalSeconds: 30,
  maxConcurrentPolls: 5,
  minimizeToTray: true,
  closeBehavior: 'ask',
  notifyOnWarning: true,
  serverOrder: [],
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
  const [page, setPage] = useState<Page>('serverDetail')
  const [servers, setServers] = useState<ServerProfile[]>([])
  const [experimentTasks, setExperimentTasks] = useState<ExperimentTask[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, ServerSnapshot>>({})
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [dialogServer, setDialogServer] = useState<ServerProfile | null | undefined>(undefined)
  const [terminalSessions, setTerminalSessions] = useState<TerminalWorkspaceSession[]>([])
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null)
  const [terminalDockOpen, setTerminalDockOpen] = useState(false)
  const [fileTarget, setFileTarget] = useState<{ serverId: string; routeId: string; path?: string } | null>(null)
  const [taskRequest, setTaskRequest] = useState<{ id: number; taskId?: string; serverId?: string; accessRouteId?: string; gpu?: GpuMetric } | null>(null)
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationRequest | null>(null)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [gpuSelection, setGpuSelection] = useState<GpuSelection>(null)
  const [gpuPoolFilters, setGpuPoolFilters] = useState({ server: 'all', model: 'all', state: 'all' })
  const [testingId, setTestingId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [vscodeConnectingId, setVsCodeConnectingId] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [importingConfig, setImportingConfig] = useState(false)
  const [draggedShortcutServerId, setDraggedShortcutServerId] = useState<string | null>(null)
  const [dragOverShortcutServerId, setDragOverShortcutServerId] = useState<string | null>(null)
  const [windowMaximized, setWindowMaximized] = useState(false)
  const [closePromptOpen, setClosePromptOpen] = useState(false)
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false)
  const [accessRouteSelections, setAccessRouteSelections] = useState<Record<string, string>>({})
  const accessRouteSelectionsRef = useRef(accessRouteSelections)
  accessRouteSelectionsRef.current = accessRouteSelections
  const retryState = useRef<Record<string, { failures: number; nextRetryAt: number }>>({})
  const snapshotRefreshInFlight = useRef(false)
  const pendingForcedSnapshots = useRef<Map<string, ServerProfile>>(new Map())
  const nextTerminalNumber = useRef(1)
  const nextLocalTerminalNumber = useRef(1)
  const confirmationResolver = useRef<((confirmed: boolean) => void) | null>(null)
  const previousPage = useRef<Page>('serverDetail')
  const gpuReturnPage = useRef<Page>('gpus')
  const terminalReturnPage = useRef<Page>('serverDetail')

  const accessRouteIdFor = (server: ServerProfile): string => {
    const selected = accessRouteSelectionsRef.current[server.id]
    return selected && getAccessRoutes(server).some((route) => route.id === selected)
      ? selected
      : getDefaultAccessRouteId(server)
  }

  const selectAccessRoute = (server: ServerProfile, routeId: string): void => {
    if (!getAccessRoutes(server).some((route) => route.id === routeId)) return
    // Refreshes may start before React renders, or drain an older queued batch.
    accessRouteSelectionsRef.current = { ...accessRouteSelectionsRef.current, [server.id]: routeId }
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

  const requestConfirmation = (request: ConfirmationRequest): Promise<boolean> => new Promise((resolve) => {
    confirmationResolver.current?.(false)
    confirmationResolver.current = resolve
    setPendingConfirmation(request)
  })

  const settleConfirmation = (confirmed: boolean): void => {
    const resolve = confirmationResolver.current
    confirmationResolver.current = null
    setPendingConfirmation(null)
    resolve?.(confirmed)
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
    if (snapshotRefreshInFlight.current) {
      if (options.force) {
        for (const server of list) pendingForcedSnapshots.current.set(server.id, server)
      }
      return
    }
    const now = Date.now()
    const eligible = options.force
      ? list
      : list.filter((server) => (retryState.current[server.id]?.nextRetryAt ?? 0) <= now)
    if (!eligible.length) return
    snapshotRefreshInFlight.current = true
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
    try {
      await Promise.allSettled(
        Array.from(
          { length: Math.min(options.concurrency ?? settings.maxConcurrentPolls, eligible.length) },
          () => worker()
        )
      )
    } finally {
      snapshotRefreshInFlight.current = false
      setRefreshing(false)
      const pendingForced = [...pendingForcedSnapshots.current.values()]
      pendingForcedSnapshots.current.clear()
      if (pendingForced.length) {
        window.setTimeout(() => void refreshSnapshots(pendingForced, { force: true }), 0)
      }
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const [, savedSettings, cachedSnapshots, savedExperimentTasks] = await Promise.all([
          loadServers(),
          window.labApi.settings.get(),
          window.labApi.monitor.cachedSnapshots(),
          window.labApi.experiments.list()
        ])
        setSettings(savedSettings)
        setSnapshots(cachedSnapshots)
        setExperimentTasks(savedExperimentTasks)
        document.documentElement.dataset.theme = savedSettings.theme
        setLoading(false)
      } catch (error) {
        notify(error instanceof Error ? error.message : '应用初始化失败', 'error')
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => window.labApi.experiments.onChanged(() => {
    void window.labApi.experiments.list().then(setExperimentTasks).catch((error: unknown) => {
      console.warn('刷新实验任务状态失败', error)
    })
  }), [])

  useEffect(() => {
    const watchedServerIds = new Set(settings.gpuWatches.map((watch) => watch.serverId))
    const backgroundServers = servers.filter((server) => server.monitorPolicy === 'background' || watchedServerIds.has(server.id))
    if (loading || !settings.monitoringEnabled || !backgroundServers.length) return
    const intervalMs = settings.pollingIntervalSeconds * 1000
    const initialTimer = window.setTimeout(() => {
      void refreshSnapshots(backgroundServers)
    }, 0)
    const intervalTimer = window.setInterval(() => void refreshSnapshots(backgroundServers), intervalMs)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(intervalTimer)
    }
  }, [loading, settings.monitoringEnabled, settings.pollingIntervalSeconds, settings.maxConcurrentPolls, settings.gpuWatches, servers, accessRouteSelections])

  useEffect(() => window.labApi.notifications.onGpuAvailable((event) => {
    const server = servers.find((item) => item.id === event.serverId)
    if (!server) return
    gpuReturnPage.current = 'gpus'
    setSelectedServerId(server.id)
    setPage('gpuDetail')
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

  const orderedShortcutServers = useMemo(() => {
    const positions = new Map(settings.serverOrder.map((serverId, index) => [serverId, index]))
    return [...servers].sort((left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER))
  }, [servers, settings.serverOrder])

  const startShortcutDrag = (event: React.DragEvent<HTMLButtonElement>, server: ServerProfile): void => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', server.id)
    setDraggedShortcutServerId(server.id)
  }

  const dropShortcutServer = (event: React.DragEvent<HTMLButtonElement>, target: ServerProfile): void => {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData('text/plain') || draggedShortcutServerId
    if (sourceId && sourceId !== target.id) {
      const next = [...orderedShortcutServers]
      const sourceIndex = next.findIndex((server) => server.id === sourceId)
      const targetIndex = next.findIndex((server) => server.id === target.id)
      if (sourceIndex >= 0 && targetIndex >= 0) {
        const [moved] = next.splice(sourceIndex, 1)
        next.splice(targetIndex, 0, moved)
        void saveServerOrder(next.map((server) => server.id))
      }
    }
    setDraggedShortcutServerId(null)
    setDragOverShortcutServerId(null)
  }

  const selectedServer = servers.find((server) => server.id === selectedServerId) ?? orderedShortcutServers[0]

  useEffect(() => {
    if (!loading && page === 'serverDetail' && selectedServer?.monitorPolicy === 'onView') {
      void refreshSnapshots([selectedServer], { force: true })
    }
  }, [loading, page, selectedServer?.id])

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

  const openSftp = (server: ServerProfile, accessRouteId = accessRouteIdFor(server), initialPath?: string): void => {
    if (routeNeedsSecret(server, accessRouteId)) {
      notify('请先在服务器认证信息中输入并保存 SSH 密码', 'error')
      setDialogServer(server)
      return
    }
    const route = getAccessRoute(server, accessRouteId)
    const defaultPath = `/home/${route.username.trim() || 'user'}`
    const targetPath = initialPath?.startsWith('/') ? initialPath : defaultPath
    setSelectedServerId(server.id)
    setAccessRouteSelections((current) => ({ ...current, [server.id]: accessRouteId }))
    setFileTarget({ serverId: server.id, routeId: accessRouteId, path: targetPath })
    setPage('files')
  }

  const openVsCode = async (server: ServerProfile, accessRouteId = accessRouteIdFor(server), remotePath?: string): Promise<void> => {
    if (vscodeConnectingId === server.id) return
    setVsCodeConnectingId(server.id)
    try {
      const result = await window.labApi.vscode.openRemote(server.id, accessRouteId, remotePath)
      notify(result.message)
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法打开 VS Code 远程连接', 'error')
    } finally {
      setVsCodeConnectingId(null)
    }
  }

  const createTerminalSession = (server: ServerProfile, accessRouteId: string, workingDirectory?: string, initialCommand?: string, taskTitle?: string): ServerTerminalSession => {
    const session = {
      id: crypto.randomUUID(),
      name: taskTitle ? `实验 · ${taskTitle}` : `SSH ${nextTerminalNumber.current++}`,
      type: 'server' as const,
      server,
      accessRouteId,
      currentPath: workingDirectory?.startsWith('/') ? workingDirectory : `/home/${getAccessRoute(server, accessRouteId).username.trim() || 'user'}`,
      initialCommand
    }
    setTerminalSessions((current) => [...current, session])
    setActiveTerminalSessionId(session.id)
    return session
  }

  const openExperimentTerminal = (
    server: ServerProfile,
    requestedRouteId: string,
    remotePath?: string,
    initialCommand?: string,
    label?: string
  ): boolean => {
    if (server.mode !== 'real') {
      notify('演示服务器不支持实验终端', 'error')
      return false
    }
    const accessRouteId = requestedRouteId && getAccessRoutes(server).some((route) => route.id === requestedRouteId)
      ? requestedRouteId
      : accessRouteIdFor(server)
    if (routeNeedsSecret(server, accessRouteId)) {
      notify('请先在服务器认证信息中输入并保存 SSH 密码', 'error')
      setDialogServer(server)
      return false
    }
    const session = createTerminalSession(server, accessRouteId, remotePath, initialCommand, label)
    setActiveTerminalSessionId(session.id)
    setSelectedServerId(server.id)
    setTerminalDockOpen(true)
    return true
  }

  const updateExperimentTask = (task: ExperimentTask): void => {
    setExperimentTasks((current) => {
      const index = current.findIndex((item) => item.id === task.id)
      if (index < 0) return [task, ...current]
      return current.map((item) => item.id === task.id ? task : item)
    })
  }

  const addLocalTerminalSession = (): void => {
    const session = {
      id: crypto.randomUUID(),
      name: `本地终端 ${nextLocalTerminalNumber.current++}`,
      type: 'local' as const
    }
    setTerminalSessions((current) => [...current, session])
    setActiveTerminalSessionId(session.id)
    setTerminalDockOpen(true)
  }

  const updateTerminalWorkingDirectory = (sessionId: string, path: string): void => {
    if (!path.startsWith('/')) return
    setTerminalSessions((current) => current.map((session) =>
      session.id === sessionId && session.type === 'server' && session.currentPath !== path
        ? { ...session, currentPath: path }
        : session
    ))
  }

  const openServerTerminal = (server: ServerProfile): void => {
    const accessRouteId = accessRouteIdFor(server)
    if (routeNeedsSecret(server, accessRouteId)) {
      notify('请先在服务器认证信息中输入并保存 SSH 密码', 'error')
      setDialogServer(server)
      return
    }
    const existing = terminalSessions.find((session) =>
      session.type === 'server' && session.server.id === server.id && session.accessRouteId === accessRouteId
    )
    const session = existing ?? createTerminalSession(server, accessRouteId)
    setActiveTerminalSessionId(session.id)
    setSelectedServerId(server.id)
    setTerminalDockOpen(true)
  }

  const addTerminalSession = (server: ServerProfile, accessRouteId = accessRouteIdFor(server)): void => {
    if (routeNeedsSecret(server, accessRouteId)) {
      notify('请先在服务器认证信息中输入并保存 SSH 密码', 'error')
      setDialogServer(server)
      return
    }
    createTerminalSession(server, accessRouteId)
    setSelectedServerId(server.id)
    setTerminalDockOpen(true)
  }

  const closeTerminalSession = async (sessionId: string): Promise<void> => {
    const sessionIndex = terminalSessions.findIndex((session) => session.id === sessionId)
    if (sessionIndex < 0) return
    const session = terminalSessions[sessionIndex]
    if (session.type === 'server') {
      const shouldClose = await requestConfirmation({
        title: '关闭 SSH 会话？',
        message: `关闭“${session.server.name}”的 ${session.name} 会断开 SSH，可能中断正在运行的前台命令。`,
        confirmLabel: '关闭会话',
        tone: 'danger'
      })
      if (!shouldClose) return
    }
    setTerminalSessions((current) => current.filter((item) => item.id !== sessionId))
    if (activeTerminalSessionId === sessionId) {
      const nextSession = terminalSessions[sessionIndex + 1] ?? terminalSessions[sessionIndex - 1]
      setActiveTerminalSessionId(nextSession?.id ?? null)
    }
  }

  const openServerDetail = (server: ServerProfile): void => {
    setSelectedServerId(server.id)
    setPage('serverDetail')
  }

  const testServer = async (server: ServerProfile): Promise<void> => {
    setTestingId(server.id)
    try {
      const accessRouteId = accessRouteIdFor(server)
      let result: ConnectionTestResult = await window.labApi.servers.test(server.id, accessRouteId)
      for (let attempt = 0; attempt < 2 && result.status === 'host-key-required' && result.fingerprint; attempt += 1) {
        const targetName = result.hostKeyTarget === 'jumpHost' ? '跳板机' : '目标服务器'
        const trusted = await requestConfirmation({
          title: '信任 SSH 主机指纹？',
          message: `首次连接 ${server.name} 的${targetName}。请通过可信渠道核对以下指纹后再继续：\n\n${result.fingerprint}`,
          confirmLabel: '信任并继续'
        })
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
    const shouldMerge = await requestConfirmation({
      title: '合并 SSH 跳板路径？',
      message: `将“${source.name}”的路径目标地址、端口、用户名、认证方式和私钥路径合并到“${target.name}”。合并时会重新读取 SSH Config，解析 ProxyJump 或 ssh -W %h:%p jumpserver 形式的 ProxyCommand，并写入真正跳板机的地址、端口、用户名和私钥；解析失败时不会执行合并。主服务器地址、连接凭据和监控历史会保留。`,
      confirmLabel: '合并路径'
    })
    if (!shouldMerge) return
    try {
      await window.labApi.servers.mergeAccessRoute(target.id, source.id)
      await loadServers()
      if (selectedServerId === source.id) {
        setSelectedServerId(target.id)
        setPage('serverDetail')
      }
      notify(`已将“${source.name}”的 SSH 路径合并到“${target.name}”`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '合并连接路径失败', 'error')
    }
  }

  const removeServer = async (server: ServerProfile): Promise<void> => {
    const shouldRemove = await requestConfirmation({
      title: '删除服务器？',
      message: `删除“${server.name}”后，本机保存的该服务器凭据也会一并删除。`,
      confirmLabel: '删除服务器',
      tone: 'danger'
    })
    if (!shouldRemove) return
    await window.labApi.servers.remove(server.id)
    if (selectedServerId === server.id) {
      setSelectedServerId(null)
      setPage('servers')
    }
    setServers((current) => current.filter((item) => item.id !== server.id))
    setSettings((current) => ({
      ...current,
      gpuWatches: current.gpuWatches.filter((watch) => watch.serverId !== server.id),
      serverOrder: current.serverOrder.filter((serverId) => serverId !== server.id)
    }))
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

  const saveServerOrder = async (visibleOrder: string[]): Promise<void> => {
    const visibleIds = new Set(visibleOrder)
    const knownOrder = [...new Set([...settings.serverOrder, ...servers.map((server) => server.id)])]
    let visibleIndex = 0
    const nextOrder = knownOrder.map((serverId) => visibleIds.has(serverId) ? visibleOrder[visibleIndex++] : serverId)
    for (const serverId of visibleOrder) {
      if (!nextOrder.includes(serverId)) nextOrder.push(serverId)
    }
    const nextSettings = { ...settings, serverOrder: nextOrder }
    setSettings((current) => ({ ...current, serverOrder: nextOrder }))
    try {
      await window.labApi.settings.save(nextSettings)
    } catch (error) {
      setSettings((current) => ({ ...current, serverOrder: settings.serverOrder }))
      notify(error instanceof Error ? error.message : '服务器卡片顺序保存失败', 'error')
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
      const importedServers = await loadServers()
      const demoServers = importedServers.filter((server) => server.mode === 'demo')
      if (demoServers.length) {
        await Promise.all(demoServers.map((server) => window.labApi.servers.remove(server.id)))
        await loadServers()
        setSettings((current) => ({
          ...current,
          serverOrder: current.serverOrder.filter((serverId) => !demoServers.some((server) => server.id === serverId)),
          gpuWatches: current.gpuWatches.filter((watch) => !demoServers.some((server) => server.id === watch.serverId))
        }))
      }
      if (result.imported.length) {
        notify(`已从 ${result.configPath} 导入或合并 ${result.imported.length} 台服务器${demoServers.length ? `，已清除 ${demoServers.length} 个演示节点` : ''}`)
      } else {
        notify(result.skipped.length ? `SSH Config 中的服务器均已导入${demoServers.length ? `，已清除 ${demoServers.length} 个演示节点` : ''}` : `未发现可导入的具体 Host${demoServers.length ? `，已清除 ${demoServers.length} 个演示节点` : ''}`, 'error')
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'SSH Config 导入失败', 'error')
    } finally {
      setImportingConfig(false)
    }
  }

  const goToPage = (nextPage: Page): void => {
    if (nextPage === 'terminals' && page !== 'terminals') terminalReturnPage.current = page
    setPage(nextPage)
  }

  function openGpu(server: ServerProfile, gpuIndex: number): void {
    if (page !== 'gpuDetail') gpuReturnPage.current = page
    setSelectedServerId(server.id)
    setGpuSelection({ server, gpuIndex })
    setPage('gpuDetail')
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

  const showTerminal = !loading && (page === 'terminals' || terminalDockOpen)
  const resourceActive = ['servers', 'serverDetail', 'gpuDetail', 'gpus'].includes(page)
  const openTask = (task?: ExperimentTask, gpu?: GpuMetric): void => {
    setTaskRequest({ id: Date.now(), taskId: task?.id, serverId: selectedServer?.id, accessRouteId: selectedServer ? accessRouteIdFor(selectedServer) : undefined, gpu })
    setPage('tasks')
  }
  const taskPool = <ExperimentTaskPool
    tasks={experimentTasks} servers={servers} snapshots={snapshots}
    liveTasks={<MyTasksPage tasks={myTasks} onOpenGpu={(server, gpuIndex) => openGpu(server, gpuIndex)} />}
    liveTaskCount={myTasks.length} vscodeConnectingId={vscodeConnectingId}
    onChanged={updateExperimentTask} notify={notify} confirm={requestConfirmation}
    onTrusted={async () => { await loadServers() }}
    onOpenTerminal={openExperimentTerminal} onOpenFiles={openSftp}
    onOpenVsCode={(server, routeId, path) => void openVsCode(server, routeId, path)}
    request={taskRequest} onRequestHandled={() => setTaskRequest(null)} defaultServerId={selectedServer?.id}
  />
  const fileServer = servers.find((server) => server.id === fileTarget?.serverId) ?? selectedServer
  const fileRouteId = fileServer ? (fileTarget?.serverId === fileServer.id ? fileTarget.routeId : accessRouteIdFor(fileServer)) : undefined
  const filePath = fileTarget?.serverId === fileServer?.id ? fileTarget?.path : undefined
  const browserServers = orderedShortcutServers.filter((server) => filteredServers.some((item) => item.id === server.id))

  return (
    <div className="app-shell workbench-shell">
      <header className="workbench-titlebar">
        <span className="workbench-wordmark"><LabDeckMark />LabDeck</span>
        <div className="window-controls" aria-label="窗口控制">
          <button onClick={() => window.labApi.windowControls.minimize()} aria-label="最小化"><Minus size={13} /></button>
          <button onClick={() => void window.labApi.windowControls.toggleMaximize().then(setWindowMaximized)} aria-label={windowMaximized ? '还原窗口' : '最大化'}>{windowMaximized ? <Copy size={12} /> : <Square size={12} />}</button>
          <button className="window-close" onClick={() => window.labApi.windowControls.close()} aria-label="关闭"><X size={14} /></button>
        </div>
      </header>
      <nav className="workbench-modulebar" aria-label="主要模块">
        <NavButton active={resourceActive} icon={<ServerIcon size={16} />} label="资源" onClick={() => goToPage('serverDetail')} />
        <NavButton active={page === 'tasks'} icon={<ListTodo size={16} />} label="实验任务" onClick={() => goToPage('tasks')} />
        <NavButton active={page === 'terminals'} icon={<SquareTerminal size={16} />} label="终端" badge={terminalSessions.length || undefined} onClick={() => goToPage('terminals')} />
        <NavButton active={page === 'files'} icon={<FolderOpen size={16} />} label="文件" onClick={() => { if (selectedServer && fileTarget?.serverId !== selectedServer.id) openSftp(selectedServer); else goToPage('files') }} />
        <label className="workbench-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索服务器" aria-label="搜索服务器" /></label>
        <button className={page === 'alerts' ? 'active' : ''} onClick={() => goToPage('alerts')}><Bell size={15} />告警{alerts.length > 0 && <b>{alerts.length}</b>}</button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => goToPage('settings')}><Settings size={15} />设置</button>
      </nav>
      <div className="workbench-body">
        <aside className="workbench-browser" aria-label="服务器资源列表">
          <header><h2>服务器</h2><button className="icon-button small" aria-label="添加服务器" title="添加服务器" onClick={() => setDialogServer(null)}><Plus size={16} /></button></header>
          <div className="workbench-browser-links"><button className={page === 'servers' ? 'active' : ''} onClick={() => goToPage('servers')}>全部服务器</button><button className={page === 'gpus' ? 'active' : ''} onClick={() => goToPage('gpus')}>GPU 总览</button></div>
          <div className="workbench-server-tree">
            {[...new Set(browserServers.map((server) => server.group || '未分组'))].map((group) => <details key={group} open className="workbench-server-group"><summary>{group}<small>{browserServers.filter((server) => (server.group || '未分组') === group).length}</small></summary><div>
              {browserServers.filter((server) => (server.group || '未分组') === group).map((server) => <SidebarServerLink key={server.id} server={server} accessRouteId={accessRouteIdFor(server)} snapshot={snapshots[server.id]} active={selectedServer?.id === server.id} dragging={draggedShortcutServerId === server.id} dragOver={dragOverShortcutServerId === server.id}
                onClick={() => { if (page === 'files') openSftp(server); else openServerDetail(server) }}
                onDragStart={(event) => startShortcutDrag(event, server)} onDragEnd={() => { setDraggedShortcutServerId(null); setDragOverShortcutServerId(null) }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverShortcutServerId(server.id) }} onDrop={(event) => dropShortcutServer(event, server)} />)}
            </div></details>)}
            {!browserServers.length && <p className="workbench-browser-empty">{servers.length ? '没有匹配的服务器' : '添加服务器或导入 SSH Config 开始使用。'}</p>}
          </div>
          <footer><button onClick={() => void importSshConfig()} disabled={importingConfig}><FileDown size={13} />{importingConfig ? '导入中…' : '导入 SSH Config'}</button><span>{servers.length} 台服务器 · {summary.gpuCount} 张 GPU</span><small>{settings.monitoringEnabled ? '持续监控已启用' : '后台监控已关闭'}</small></footer>
        </aside>
        <main className="main-content workbench-main">
          <div className={`page-content workbench-page ${page === 'terminals' ? 'terminal-full-page' : ''}`}>
            {loading ? <LoadingState /> : page === 'serverDetail' ? (selectedServer ? <ResourceWorkbench key={selectedServer.id}
              server={selectedServer} snapshot={snapshots[selectedServer.id]} initialGpuIndex={gpuSelection?.server.id === selectedServer.id ? gpuSelection.gpuIndex : undefined} tasks={experimentTasks} watches={settings.gpuWatches}
              accessRouteId={accessRouteIdFor(selectedServer)} onAccessRouteChange={(id) => selectAccessRoute(selectedServer, id)}
              refreshing={refreshing} testing={testingId === selectedServer.id} vscodeConnecting={vscodeConnectingId === selectedServer.id}
              onRefresh={() => void refreshSnapshots([selectedServer], { force: true })} onTerminal={() => openServerTerminal(selectedServer)}
              onFiles={(path) => openSftp(selectedServer, accessRouteIdFor(selectedServer), path)} onVsCode={() => void openVsCode(selectedServer)} onEdit={() => setDialogServer(selectedServer)}
              onTest={() => void testServer(selectedServer)} onRemove={() => void removeServer(selectedServer)} onMerge={() => void mergeServerPath(selectedServer)}
              onTask={(task) => openTask(task)} onNewTask={(gpu) => openTask(undefined, gpu)} onGpuDetail={(gpuIndex) => openGpu(selectedServer, gpuIndex)}
              onToggleWatch={(gpuUuid) => void toggleGpuWatch({ serverId: selectedServer.id, gpuUuid })}
            /> : <div className="workbench-welcome"><ServerIcon size={28} /><h1>还没有服务器</h1><p>导入 SSH Config 或添加服务器，查看 GPU 并调度实验。</p><button className="secondary-button" onClick={() => setDialogServer(null)}><Plus size={15} />添加服务器</button><button className="wb-text-button" onClick={() => void importSshConfig()}>导入 SSH Config</button></div>) : page === 'gpuDetail' && gpuSelection ? <GpuDetailPanel key={gpuSelection.server.id} server={servers.find(server => server.id === gpuSelection.server.id) ?? gpuSelection.server} snapshot={snapshots[gpuSelection.server.id]} initialGpuIndex={gpuSelection.gpuIndex} watches={settings.gpuWatches} accessRouteId={accessRouteIdFor(gpuSelection.server)} onToggleWatch={(gpuUuid) => void toggleGpuWatch({ serverId: gpuSelection.server.id, gpuUuid })} onClose={() => setPage(gpuReturnPage.current)} refreshing={refreshing} onRefresh={() => void refreshSnapshots([gpuSelection.server], { force: true })} onTerminal={() => openServerTerminal(gpuSelection.server)} onRun={(gpu) => openTask(undefined, gpu)} onSelectGpu={(gpuIndex) => setGpuSelection({ server: gpuSelection.server, gpuIndex })} /> : page === 'tasks' ? <><header className="workbench-page-heading"><h1>实验任务</h1><span>任务配置、排队与运行记录</span></header>{taskPool}</> : page === 'files' ? (fileServer && fileRouteId ? <div className="workbench-files"><div className="workbench-file-route"><AccessRouteSelect server={fileServer} value={fileRouteId} onChange={(id) => openSftp(fileServer, id)} /></div><SftpPanel key={`${fileServer.id}:${fileRouteId}`} server={fileServer} accessRouteId={fileRouteId} initialPath={filePath} onClose={() => goToPage('serverDetail')} onMessage={notify} /></div> : <div className="workbench-welcome"><FolderOpen size={28} /><h1>选择一台服务器</h1><p>从左侧服务器列表打开远程文件。</p></div>) : page === 'terminals' ? null : page === 'servers' ? <><header className="workbench-page-heading"><h1>全部服务器</h1><button className="secondary-button" onClick={() => void refreshSnapshots(servers, { force: true })}><RefreshCw size={14} className={refreshing ? 'spin' : ''} />刷新全部</button></header><ServerTable servers={filteredServers} snapshots={snapshots} testingId={testingId} vscodeConnectingId={vscodeConnectingId} accessRouteId={accessRouteIdFor} onAccessRouteChange={selectAccessRoute} onOverview={openServerDetail} onTest={testServer} onTerminal={openServerTerminal} onSftp={openSftp} onVsCode={(server) => void openVsCode(server)} onGpu={(server, gpuIndex) => openGpu(server, gpuIndex)} onEdit={(server) => setDialogServer(server)} onRemove={removeServer} onMerge={mergeServerPath} /></> : page === 'gpus' ? <GpuResourcePool servers={filteredServers} snapshots={snapshots} watches={settings.gpuWatches} refreshing={refreshing} onRefresh={() => void refreshSnapshots(servers, { force: true })} onToggleWatch={(target) => void toggleGpuWatch(target)} onSelect={openGpu} filters={gpuPoolFilters} onFiltersChange={setGpuPoolFilters} /> : page === 'alerts' ? <><header className="workbench-page-heading"><h1>告警</h1><span>{alerts.length} 条活动告警</span></header><AlertsPage alerts={alerts} /></> : <><header className="workbench-page-heading"><h1>设置</h1></header><SettingsPage settings={settings} onChange={setSettings} onSave={saveSettings} /></>}
          </div>
          <TerminalDock expanded={showTerminal} fullscreen={page === 'terminals'}>
            <header className="workbench-dock-heading"><button onClick={() => { if (page === 'terminals') { setPage(terminalReturnPage.current); setTerminalDockOpen(false) } else setTerminalDockOpen((open) => !open) }} aria-expanded={showTerminal} title={showTerminal ? '收起终端，会话继续运行' : '展开终端'}><SquareTerminal size={13} />终端<span>{terminalSessions.length ? `${terminalSessions.length} 个会话` : '未打开会话'}</span>{showTerminal ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</button><div>{showTerminal && (page === 'terminals' ? <button onClick={() => { setPage(terminalReturnPage.current); setTerminalDockOpen(true) }} aria-label="返回底部终端" title="返回底部终端"><Copy size={12} />返回底部</button> : <button onClick={() => goToPage('terminals')} aria-label="全屏终端" title="展开到完整终端页"><Square size={12} />展开终端</button>)}<button onClick={addLocalTerminalSession}><Plus size={13} />本地终端</button></div></header>
            <ServerTerminalWorkspace
              sessions={terminalSessions} activeId={activeTerminalSessionId} visible={showTerminal} servers={servers} accessRouteIdFor={accessRouteIdFor}
              onActivate={setActiveTerminalSessionId} onAdd={addTerminalSession} onAddLocal={addLocalTerminalSession} onClose={closeTerminalSession}
              onOpenVsCode={(server, routeId) => void openVsCode(server, routeId)} vscodeConnectingId={vscodeConnectingId}
              onOpenFiles={(session) => openSftp(servers.find((server) => server.id === session.server.id) ?? session.server, session.accessRouteId, session.currentPath)}
              onOpenServerFiles={openSftp} onWorkingDirectory={updateTerminalWorkingDirectory} onTrusted={async () => { await loadServers() }} confirm={requestConfirmation}
            />
          </TerminalDock>
        </main>
      </div>
      <footer className="workbench-statusbar"><span><i className={settings.monitoringEnabled ? 'on' : ''} />{settings.monitoringEnabled ? '监控已启用' : '监控已关闭'}<span>{terminalSessions.length} 个终端会话</span></span><span>{refreshing ? '正在采集…' : selectedServer && snapshots[selectedServer.id] ? `最近采集 ${new Date(snapshots[selectedServer.id].sampledAt).toLocaleTimeString('zh-CN')}` : '尚未采集'}<span>间隔 {settings.pollingIntervalSeconds} 秒</span></span></footer>

      {dialogServer !== undefined && <ServerDialog server={dialogServer} onClose={() => setDialogServer(undefined)} onSaved={(server) => void saved(server)} />}

      {closePromptOpen && <ClosePrompt remember={rememberCloseChoice} onRememberChange={setRememberCloseChoice} onChoose={(action) => void resolveCloseAction(action)} />}
      {pendingConfirmation && <ConfirmDialog {...pendingConfirmation} onCancel={() => settleConfirmation(false)} onConfirm={() => settleConfirmation(true)} />}
      <div className="toast-stack">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}<span>{toast.message}</span></div>)}</div>
    </div>
  )
}

function NavButton({ active, icon, label, badge, danger, onClick }: { active: boolean; icon: React.ReactNode; label: string; badge?: number; danger?: boolean; onClick(): void }): React.JSX.Element {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{badge !== undefined && <b className={danger ? 'danger' : ''}>{badge}</b>}</button>
}

function SidebarServerLink({ server, accessRouteId, snapshot, active, dragging, dragOver, onClick, onDragStart, onDragEnd, onDragOver, onDrop }: { server: ServerProfile; accessRouteId: string; snapshot?: ServerSnapshot; active: boolean; dragging: boolean; dragOver: boolean; onClick(): void; onDragStart(event: React.DragEvent<HTMLButtonElement>): void; onDragEnd(): void; onDragOver(event: React.DragEvent<HTMLButtonElement>): void; onDrop(event: React.DragEvent<HTMLButtonElement>): void }): React.JSX.Element {
  const visualStatus = snapshot?.cached ? 'cached' : snapshot?.status ?? 'unknown'
  const route = getAccessRoute(server, accessRouteId)
  const endpoint = `${route.host.includes(':') && !route.host.startsWith('[') ? `[${route.host}]` : route.host}:${route.port}`
  return <button type="button" draggable className={`sidebar-server-link ${active ? 'active' : ''}${dragging ? ' dragging' : ''}${dragOver ? ' drag-over' : ''}`} onClick={onClick} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop} title={`${server.name} · ${endpoint} · ${route.name} · ${statusLabel(snapshot)} · 拖动可调整顺序`}><i className={visualStatus} /><span><strong>{server.name}</strong><small>{endpoint}</small></span><GripVertical className="sidebar-server-drag-icon" size={13} aria-hidden="true" /></button>
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

function ServerTable({ servers, snapshots, ...actions }: { servers: ServerProfile[]; snapshots: Record<string, ServerSnapshot> } & CommonServerActions): React.JSX.Element {
  return <section className="wb-all-servers"><div className="wb-table-scroll"><table className="wb-table wb-all-server-table"><thead><tr><th>服务器</th><th>状态</th><th>CPU / 内存</th><th>GPU 设备</th><th>系统存储</th><th>连接路径</th><th>操作</th></tr></thead><tbody>{servers.map(server => {
    const snapshot = snapshots[server.id]
    const disk = snapshot?.fileSystems.find(item => item.mountPoint === '/') ?? snapshot?.fileSystems[0]
    const route = getAccessRoute(server, actions.accessRouteId(server))
    const live = !!snapshot && !snapshot.cached && (snapshot.status === 'online' || snapshot.status === 'warning')
    const state = snapshot?.cached ? 'cached' : snapshot?.status ?? 'unknown'
    return <tr key={server.id}><td><button className="wb-device-link" onClick={() => actions.onOverview(server)}><strong>{server.name}</strong><small>{route.username}@{route.host}:{route.port}</small></button><small className="wb-cell-secondary">{server.group || '未分组'}{server.tags.length ? ` · ${server.tags.join(' / ')}` : ''}</small></td><td><span className={`wb-state ${state}`}><i />{statusLabel(snapshot)}</span><small className="wb-cell-secondary">{monitorPolicyLabel[server.monitorPolicy]}采集</small></td><td><span>CPU {formatPercent(snapshot?.cpuUsagePercent)}</span><small className="wb-cell-secondary">{snapshot?.memoryUsedBytes == null ? '—' : formatBytes(snapshot.memoryUsedBytes)} / {snapshot?.memoryTotalBytes == null ? '—' : formatBytes(snapshot.memoryTotalBytes)}</small></td><td><div className="wb-server-gpu-links">{snapshot?.gpus.map(gpu => <button key={gpu.uuid} className={!live ? 'cached' : isGpuBusy(gpu) ? 'busy' : 'idle'} title={`${gpu.name} · ${(gpu.memoryUsedMiB / 1024).toFixed(1)} / ${(gpu.memoryTotalMiB / 1024).toFixed(0)} GiB`} aria-label={`查看 ${server.name} GPU ${gpu.index} 详情`} onClick={() => actions.onGpu(server, gpu.index)}><i />GPU {gpu.index}<small>{live ? `${Math.round(gpu.utilizationPercent)}%` : '待确认'}</small></button>) ?? null}{!snapshot?.gpus.length && <span className="wb-muted">{snapshot ? '无 GPU' : '尚未采集'}</span>}</div></td><td><span className={disk && disk.usagePercent >= 80 ? 'wb-warning' : ''}>{formatPercent(disk?.usagePercent)}</span><small className="wb-cell-secondary">{disk ? `${disk.mountPoint} · 可用 ${formatBytes(disk.availableBytes)}` : '—'}</small></td><td>{getAccessRoutes(server).length > 1 ? <AccessRouteSelect server={server} value={actions.accessRouteId(server)} compact onChange={id => actions.onAccessRouteChange(server, id)} /> : <span className="wb-muted">{route.name}</span>}</td><td><div className="wb-server-actions"><button className="secondary-button" onClick={() => actions.onTerminal(server)}><SquareTerminal size={13} />终端</button><button className="icon-button small" onClick={() => actions.onSftp(server)} aria-label={`打开 ${server.name} 文件`} title="打开文件"><FolderOpen size={14} /></button><button className="icon-button small" onClick={() => actions.onVsCode(server)} disabled={actions.vscodeConnectingId === server.id} aria-label={`打开 ${server.name} VS Code`} title="打开 VS Code"><Code2 size={14} /></button><button className="icon-button small" onClick={() => actions.onTest(server)} disabled={actions.testingId === server.id} aria-label={`测试 ${server.name} 连接`} title="测试连接"><RefreshCw size={14} className={actions.testingId === server.id ? 'spin' : ''} /></button><button className="icon-button small" onClick={() => actions.onEdit(server)} aria-label={`编辑 ${server.name}`} title="编辑服务器"><Pencil size={14} /></button>{isLegacyJumpProfile(server.name) && <button className="icon-button small" onClick={() => actions.onMerge(server)} title="合并连接路径"><GitMerge size={14} /></button>}<button className="icon-button small wb-danger" onClick={() => actions.onRemove(server)} aria-label={`删除 ${server.name}`} title="删除服务器"><Trash2 size={14} /></button></div></td></tr>
  })}</tbody></table>{!servers.length && <div className="wb-empty-inline">没有匹配的服务器。调整搜索，或从左侧添加服务器。</div>}</div></section>
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
      <header className="dialog-header app-modal-header close-choice-header">
        <div className="dialog-title-wrap app-modal-title">
          <div className="dialog-icon close-choice-icon"><Power size={19} /></div>
          <div><h2 id="close-choice-title">关闭 LabDeck？</h2><p>你可以让监控继续运行，或者完全退出应用。</p></div>
        </div>
        <button type="button" className="icon-button" onClick={() => onChoose('cancel')} aria-label="取消关闭"><X size={18} /></button>
      </header>
      <div className="close-choice-content">
        <div className="close-choice-actions">
          <button type="button" className="close-choice-action tray" autoFocus onClick={() => onChoose('tray')}><span className="close-choice-action-icon"><Bell size={18} /></span><span><strong>留在系统托盘</strong><small>隐藏主窗口，SSH 会话和监控继续运行</small></span><ChevronRight size={17} /></button>
          <button type="button" className="close-choice-action exit" onClick={() => onChoose('exit')}><span className="close-choice-action-icon"><Power size={18} /></span><span><strong>退出应用</strong><small>关闭 SSH，前台命令可能中断；停止后台监控</small></span><ChevronRight size={17} /></button>
        </div>
        <footer className="close-choice-footer app-modal-footer"><button type="button" className={`close-choice-remember ${remember ? 'checked' : ''}`} role="checkbox" aria-checked={remember} onClick={() => onRememberChange(!remember)}><i>{remember && <Check size={12} />}</i><span>记住我的选择</span></button><button type="button" className="secondary-button" onClick={() => onChoose('cancel')}>取消</button></footer>
      </div>
    </section>
  </div>
}

function SettingsPage({ settings, onChange, onSave }: { settings: AppSettings; onChange(settings: AppSettings): void; onSave(): void }): React.JSX.Element {
  return <div className="settings-page-stack">
    <section className="panel appearance-panel">
      <div className="panel-title"><div><h3>界面主题</h3><p>选择适合当前环境的控制台外观，切换会立即预览</p></div><LayoutDashboard size={19} /></div>
      <div className="theme-options">
        <ThemeOption name="石墨灰" description="中性色工作台，适合日常运维" value="ocean" selected={settings.theme === 'ocean'} onSelect={() => onChange({ ...settings, theme: 'ocean' })} />
        <ThemeOption name="浅色仪器台" description="明亮环境与投影展示" value="instrument" selected={settings.theme === 'instrument'} onSelect={() => onChange({ ...settings, theme: 'instrument' })} />
        <ThemeOption name="深色高对比" description="适合暗光环境" value="machineRoom" selected={settings.theme === 'machineRoom'} onSelect={() => onChange({ ...settings, theme: 'machineRoom' })} />
      </div>
    </section>
    <div className="settings-layout"><section className="panel settings-panel"><div className="panel-title"><div><h3>监控设置</h3><p>控制持续监控服务器的轮询频率与并发连接</p></div><Gauge size={19} /></div><SettingToggle label="启用后台监控" description="仅定时采集标记为“持续监控”的服务器" checked={settings.monitoringEnabled} onChange={(value) => onChange({ ...settings, monitoringEnabled: value })} /><SettingToggle label="告警系统通知" description="发现离线、磁盘或温度异常时通知" checked={settings.notifyOnWarning} onChange={(value) => onChange({ ...settings, notifyOnWarning: value })} /><label className="settings-field"><div><strong>关闭窗口时</strong><span>退出会关闭 SSH，前台命令可能中断</span></div><select value={settings.closeBehavior} onChange={(event) => onChange({ ...settings, closeBehavior: event.target.value as AppSettings['closeBehavior'] })}><option value="ask">每次询问</option><option value="tray">总是留在系统托盘</option><option value="exit">直接退出应用</option></select></label><label className="settings-field"><div><strong>轮询间隔</strong><span>较短间隔更新更及时；若上一轮未完成，不会重叠启动采集</span></div><select value={settings.pollingIntervalSeconds} onChange={(event) => onChange({ ...settings, pollingIntervalSeconds: Number(event.target.value) })}><option value={10}>10 秒</option><option value={15}>15 秒</option><option value={30}>30 秒</option><option value={60}>60 秒</option><option value={120}>2 分钟</option><option value={300}>5 分钟</option></select></label><label className="settings-field"><div><strong>最大并发采集</strong><span>服务器较多时限制同时建立的 SSH 连接数</span></div><select value={settings.maxConcurrentPolls} onChange={(event) => onChange({ ...settings, maxConcurrentPolls: Number(event.target.value) })}><option value={3}>3 个</option><option value={5}>5 个</option><option value={10}>10 个</option></select></label><div className="settings-footer"><button className="primary-button" onClick={onSave}>保存设置</button></div></section><section className="panel security-panel"><div className="panel-title"><div><h3>安全状态</h3><p>当前应用的安全保护</p></div><ShieldCheck size={19} /></div><div className="security-check"><CheckCircle2 size={17} /><div><strong>进程隔离已启用</strong><span>Renderer 无法直接访问 Node.js</span></div></div><div className="security-check"><CheckCircle2 size={17} /><div><strong>凭据加密存储</strong><span>由当前 Windows 用户的 DPAPI 保护</span></div></div><div className="security-check"><CheckCircle2 size={17} /><div><strong>主机指纹校验</strong><span>首次连接确认，变化时拒绝连接</span></div></div><div className="settings-warning"><AlertTriangle size={17} /><p>退出托盘程序或电脑进入睡眠后，本地监控和告警会停止。</p></div></section></div>
  </div>
}

function ThemeOption({ name, description, value, selected, onSelect }: { name: string; description: string; value: string; selected: boolean; onSelect(): void }): React.JSX.Element {
  return <button type="button" className={`theme-option ${selected ? 'selected' : ''}`} onClick={onSelect}><span className={`theme-preview ${value}`}><i /><i /><i /></span><strong>{name}</strong><small>{description}</small>{selected && <CheckCircle2 size={16} />}</button>
}

function SettingToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <label className="settings-field"><div><strong>{label}</strong><span>{description}</span></div><button type="button" className={`toggle ${checked ? 'active' : ''}`} onClick={() => onChange(!checked)}><i /></button></label>
}

function LoadingState(): React.JSX.Element { return <div className="loading-state"><Activity size={28} className="pulse" /><strong>正在加载本地工作区</strong><span>准备服务器配置与监控数据…</span></div> }
