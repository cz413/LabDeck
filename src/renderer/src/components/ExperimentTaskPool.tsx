import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, Ban, CheckCircle2, ChevronDown, CircleAlert, Code2, Cpu, FolderOpen, ListTodo, LoaderCircle, MoreHorizontal, Play, Plus, RotateCcw, Server, SquareTerminal, Trash2 } from 'lucide-react'
import type {
  CondaEnvironmentConfig,
  CondaEnvironmentInfo,
  CondaManager,
  ExperimentRunFinishInput,
  ExperimentRunStartInput,
  ExperimentTask,
  ExperimentTaskDraft,
  ExperimentTaskStatus,
  GpuMetric,
  RemoteCondaResult,
  ServerProfile,
  ServerSnapshot
} from '@shared/types'
import { getAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '@shared/access-routes'
import { AccessRouteSelect } from './AccessRouteSelect'
import type { ConfirmationRequest } from './ConfirmDialog'

type PoolTab = 'pool' | 'live'

interface ExperimentTaskPoolProps {
  tasks: ExperimentTask[]
  servers: ServerProfile[]
  snapshots: Record<string, ServerSnapshot>
  liveTasks: ReactNode
  liveTaskCount: number
  vscodeConnectingId: string | null
  defaultServerId?: string
  request?: { id: number; taskId?: string; serverId?: string; accessRouteId?: string; gpu?: GpuMetric } | null
  onRequestHandled?(): void
  onChanged(task: ExperimentTask): void
  notify(message: string, kind?: 'success' | 'error'): void
  confirm(request: ConfirmationRequest): Promise<boolean>
  onTrusted(): Promise<void>
  onOpenTerminal(server: ServerProfile, accessRouteId: string, path?: string, initialCommand?: string, label?: string): boolean
  onOpenFiles(server: ServerProfile, accessRouteId: string, path: string): void
  onOpenVsCode(server: ServerProfile, accessRouteId: string, path?: string): void
}

const statusNames: Record<ExperimentTaskStatus, string> = {
  planned: '待开始', queued: '等待 GPU', preparing: '准备运行', running: '进行中', paused: '已暂停', completed: '已完成', failed: '运行失败', cancelled: '已取消'
}

const priorityNames = { low: '低', normal: '普通', high: '高' } as const

const quoteShell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const initialDraft = (): ExperimentTaskDraft => ({
  title: '', project: '', objective: '', tags: [], priority: 'normal', status: 'planned',
  codePath: '', dataPath: '', launchCommand: '', artifactPath: '', resultSummary: '', notes: ''
})

export function ExperimentTaskPool(props: ExperimentTaskPoolProps): React.JSX.Element {
  const [tab, setTab] = useState<PoolTab>('pool')
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [editor, setEditor] = useState<ExperimentTaskDraft | null>(null)
  const [tagsText, setTagsText] = useState('')
  const [condaEnabled, setCondaEnabled] = useState(false)
  const [envs, setEnvs] = useState<CondaEnvironmentInfo[]>([])
  const condaRequestId = useRef(0)
  const [condaBusy, setCondaBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [finishing, setFinishing] = useState<ExperimentTask | null>(null)
  const [starting, setStarting] = useState<ExperimentTask | null>(null)
  const [runDraft, setRunDraft] = useState<ExperimentRunStartInput | null>(null)
  const [runGpuSnapshot, setRunGpuSnapshot] = useState<ServerSnapshot | null>(null)
  const [runGpuRefreshBusy, setRunGpuRefreshBusy] = useState(false)
  const runGpuSnapshotRequestId = useRef(0)
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null)
  const [cancelingRunId, setCancelingRunId] = useState<string | null>(null)
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [inspectedTaskId, setInspectedTaskId] = useState<string | null>(null)
  const [filterProject, setFilterProject] = useState('all')
  const [filterServer, setFilterServer] = useState('all')
  const [filterPriority, setFilterPriority] = useState('all')
  const [filterTag, setFilterTag] = useState('all')
  const [finishInput, setFinishInput] = useState<ExperimentRunFinishInput>({ status: 'completed', resultSummary: '', notes: '', artifactPath: '' })

  const visibleTasks = useMemo(() => props.tasks
    .filter((task) => task.archived === showArchived)
    .filter((task) => statusFilter === 'all' || task.status === statusFilter)
    .filter((task) => filterProject === 'all' || task.project === filterProject)
    .filter((task) => filterServer === 'all' || task.serverId === filterServer)
    .filter((task) => filterPriority === 'all' || task.priority === filterPriority)
    .filter((task) => filterTag === 'all' || task.tags.includes(filterTag))
    .filter((task) => !query.trim() || `${task.title} ${task.project} ${task.objective} ${task.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
  [props.tasks, showArchived, statusFilter, filterProject, filterServer, filterPriority, filterTag, query])

  const activeCount = props.tasks.filter((task) => !task.archived && (task.status === 'queued' || task.status === 'preparing' || task.status === 'running' || task.status === 'paused')).length
  const filterTasks = props.tasks.filter((task) => task.archived === showArchived)
  const projectOptions = [...new Set(filterTasks.filter((task) => task.project).map((task) => task.project))].sort()
  const tagOptions = [...new Set(filterTasks.flatMap((task) => task.tags))].sort()
  const activeRun = (task: ExperimentTask) => task.runs.find((run) => run.status === 'queued' || run.status === 'preparing' || run.status === 'running') ?? (task.status === 'paused' ? [...task.runs].reverse().find((run) => run.status === 'paused') : undefined)

  const openEditor = (task?: ExperimentTask): void => {
    const next = task ? structuredClone({
      id: task.id, title: task.title, project: task.project, objective: task.objective,
      tags: task.tags, priority: task.priority, status: task.status, serverId: task.serverId,
      serverNameSnapshot: task.serverNameSnapshot, accessRouteId: task.accessRouteId,
      gpuUuid: task.gpuUuid, gpuIndex: task.gpuIndex, gpuNameSnapshot: task.gpuNameSnapshot,
      codePath: task.codePath, dataPath: task.dataPath, launchCommand: task.launchCommand,
      condaEnvironment: task.condaEnvironment, minimumFreeVramGiB: task.minimumFreeVramGiB,
      maximumGpuUtilizationPercent: task.maximumGpuUtilizationPercent,
      artifactPath: task.artifactPath, resultSummary: task.resultSummary, notes: task.notes
    }) : { ...initialDraft(), serverId: props.defaultServerId }
    setEditor(next)
    setTagsText(next.tags.join(', '))
    setCondaEnabled(Boolean(next.condaEnvironment))
    setEnvs([])
  }

  useEffect(() => {
    const request = props.request
    if (!request) return
    if (request.taskId) {
      const task = props.tasks.find((item) => item.id === request.taskId)
      setShowArchived(task?.archived ?? false)
      setQuery('')
      setStatusFilter('all')
      setFilterProject('all')
      setFilterServer('all')
      setFilterPriority('all')
      setFilterTag('all')
      setInspectedTaskId(request.taskId)
      setExpandedTaskId(request.taskId)
    } else {
      openEditor()
      setEditor({ ...initialDraft(), serverId: request.serverId, accessRouteId: request.accessRouteId,
        gpuUuid: request.gpu?.uuid, gpuIndex: request.gpu?.index, gpuNameSnapshot: request.gpu?.name })
    }
    props.onRequestHandled?.()
  }, [props.request?.id])

  const updateDraft = (patch: Partial<ExperimentTaskDraft>): void => {
    setEditor((current) => current ? { ...current,
      ...(patch.serverId !== undefined && patch.serverId !== current.serverId ? { gpuUuid: undefined, gpuIndex: undefined, gpuNameSnapshot: undefined } : {}), ...patch } : current)
  }

  const updateConda = (patch: Partial<CondaEnvironmentConfig>): void => {
    const managerChanged = 'manager' in patch
    setEditor((current) => {
      if (!current) return current
      const previous = current.condaEnvironment ?? { manager: 'conda' as CondaManager }
      return { ...current, condaEnvironment: { ...previous, ...patch } }
    })
    if (managerChanged) {
      setEnvs([])
    }
  }

  const selectedServer = editor?.serverId ? props.servers.find((server) => server.id === editor.serverId) : undefined
  const selectedRouteId = editor && selectedServer
    ? editor.accessRouteId && getAccessRoutes(selectedServer).some((route) => route.id === editor.accessRouteId)
      ? editor.accessRouteId
      : getDefaultAccessRouteId(selectedServer)
    : undefined
  const updateRunDraft = (patch: Partial<ExperimentRunStartInput>): void => {
    setRunDraft((current) => current ? { ...current, ...patch } : current)
  }

  const updateRunConda = (patch: Partial<CondaEnvironmentConfig>): void => {
    if (!runDraft) return
    const targetChanged = ['manager', 'managerPath', 'environmentName', 'environmentPrefix'].some((key) => key in patch)
    updateRunDraft({
      condaEnvironment: {
        ...(runDraft.condaEnvironment ?? { manager: 'conda' as CondaManager }),
        ...patch,
        ...(targetChanged ? { lastCheckStatus: 'unknown' as const, lastCheckedAt: undefined, pythonInterpreterPath: undefined, pythonVersion: undefined } : {})
      }
    })
  }

  const runServer = runDraft?.serverId ? props.servers.find((server) => server.id === runDraft.serverId) : undefined
  const runServerSnapshot = runServer && runGpuSnapshot?.serverId === runServer.id
    ? runGpuSnapshot
    : runServer ? props.snapshots[runServer.id] : undefined
  const manuallySelectedGpu = Boolean(runDraft && (runDraft.gpuUuid || runDraft.gpuIndex !== null))
  const runSelectedGpu = runDraft && runServerSnapshot?.gpus.find((gpu) => runDraft.gpuUuid ? gpu.uuid === runDraft.gpuUuid : gpu.index === runDraft.gpuIndex)
  const runRouteId = runServer && runDraft
    ? runDraft.accessRouteId && getAccessRoutes(runServer).some((route) => route.id === runDraft.accessRouteId)
      ? runDraft.accessRouteId
      : getDefaultAccessRouteId(runServer)
    : undefined
  const refreshRunGpuSnapshot = async (quiet = false): Promise<void> => {
    if (!runServer || !runRouteId || runServer.mode !== 'real') return
    const requestId = ++runGpuSnapshotRequestId.current
    setRunGpuRefreshBusy(true)
    try {
      const snapshot = await window.labApi.monitor.snapshot(runServer.id, runRouteId)
      if (requestId === runGpuSnapshotRequestId.current) {
        setRunGpuSnapshot(snapshot)
        if (!quiet && snapshot.status === 'offline') props.notify(`读取 GPU 状态失败：${snapshot.error ?? '服务器当前离线'}`, 'error')
      }
    } catch (error) {
      if (requestId === runGpuSnapshotRequestId.current) {
        const message = error instanceof Error ? error.message : '刷新 GPU 状态失败'
        const cached = props.snapshots[runServer.id]
        setRunGpuSnapshot(cached ? { ...cached, status: 'offline', error: message } : null)
        if (!quiet) props.notify(message, 'error')
      }
    } finally {
      if (requestId === runGpuSnapshotRequestId.current) setRunGpuRefreshBusy(false)
    }
  }

  useEffect(() => {
    if (!starting || !runServer || !runRouteId) {
      setRunGpuSnapshot(null)
      setRunGpuRefreshBusy(false)
      return
    }
    setRunGpuSnapshot(props.snapshots[runServer.id] ?? null)
    void refreshRunGpuSnapshot(true)
    return () => { runGpuSnapshotRequestId.current += 1 }
  }, [starting?.id, runServer?.id, runRouteId])
  const saveTask = async (queueAfterSave = false): Promise<void> => {
    if (!editor) return
    setSaving(true)
    try {
      for (const [label, path] of [['代码目录', editor.codePath], ['数据目录', editor.dataPath], ['产物路径', editor.artifactPath]] as const) {
        if (path.trim() && (!path.trim().startsWith('/') || path.includes('\0'))) throw new Error(`${label}必须填写服务器上的绝对路径`)
      }
      const draft: ExperimentTaskDraft = {
        ...editor,
        title: editor.title.trim(),
        accessRouteId: selectedRouteId ?? editor.accessRouteId,
        tags: [...new Set(tagsText.split(',').map((tag) => tag.trim()).filter(Boolean))],
        condaEnvironment: condaEnabled ? {
          manager: editor.condaEnvironment?.manager ?? 'conda',
          managerPath: editor.condaEnvironment?.managerPath?.trim() || undefined,
          environmentName: editor.condaEnvironment?.environmentName?.trim() || undefined,
          environmentPrefix: editor.condaEnvironment?.environmentPrefix?.trim() || undefined,
          environmentFilePath: editor.condaEnvironment?.environmentFilePath?.trim() || undefined,
          pythonInterpreterPath: editor.condaEnvironment?.pythonInterpreterPath?.trim() || undefined,
          pythonVersion: editor.condaEnvironment?.pythonVersion?.trim() || undefined,
          lastCheckStatus: editor.condaEnvironment?.lastCheckStatus,
          lastCheckedAt: editor.condaEnvironment?.lastCheckedAt
        } : undefined
      }
      if (draft.condaEnvironment?.environmentName && draft.condaEnvironment.environmentPrefix) {
        throw new Error('Conda 环境名和前缀路径只能填写一项')
      }
      let queueInput: ExperimentRunStartInput | undefined
      if (queueAfterSave) {
        const server = draft.serverId ? props.servers.find((item) => item.id === draft.serverId) : undefined
        if (!server || server.mode !== 'real') throw new Error('加入队列前请选择一台真实服务器')
        if (!selectedRouteId) throw new Error('所选服务器没有可用的 SSH 连接路径')
        if (!draft.codePath.trim() || !draft.codePath.trim().startsWith('/')) throw new Error('加入队列需要填写服务器上的代码目录绝对路径')
        if (!draft.launchCommand.trim()) throw new Error('加入队列需要填写启动命令')
        if (draft.condaEnvironment && !draft.condaEnvironment.environmentName?.trim() && !draft.condaEnvironment.environmentPrefix?.trim()) {
          throw new Error('请填写 Conda 环境名或环境前缀路径')
        }
        queueInput = {
          serverId: server.id,
          accessRouteId: selectedRouteId,
          gpuUuid: draft.gpuUuid ?? null,
          gpuIndex: draft.gpuIndex ?? null,
          gpuNameSnapshot: draft.gpuNameSnapshot ?? null,
          codePath: draft.codePath.trim(),
          dataPath: draft.dataPath.trim(),
          launchCommand: draft.launchCommand.trim(),
          condaEnvironment: draft.condaEnvironment ? structuredClone(draft.condaEnvironment) : null,
          artifactPath: draft.artifactPath.trim(),
          minimumFreeVramGiB: draft.gpuUuid ? null : draft.minimumFreeVramGiB ?? null,
          maximumGpuUtilizationPercent: draft.gpuUuid ? null : draft.maximumGpuUtilizationPercent ?? null,
          notes: draft.notes.trim()
        }
      }
      const saved = await window.labApi.experiments.save(draft)
      if (queueInput) {
        const queued = await window.labApi.experiments.startRun(saved.id, queueInput)
        props.onChanged(queued)
        props.notify(queueInput.gpuUuid ? `已请求在 GPU ${queueInput.gpuIndex} 上启动任务` : '任务已加入队列；系统会按显存和 GPU 利用率条件自动分配')
      } else {
        props.onChanged(saved)
        props.notify('实验任务已保存')
      }
      setEditor(null)
    } catch (error) {
      props.notify(error instanceof Error ? error.message : '无法保存实验任务', 'error')
    } finally {
      setSaving(false)
    }
  }

  const performCondaRequest = async <T,>(request: () => Promise<RemoteCondaResult<T>>): Promise<T | null> => {
    let result = await request()
    for (let attempt = 0; attempt < 2 && result.status === 'host-key-required'; attempt += 1) {
      if (!editor?.serverId || !selectedServer || !selectedRouteId) return null
      const targetName = result.hostKeyTarget === 'jumpHost' ? '跳板机' : '目标服务器'
      const trusted = await props.confirm({
        title: '信任 SSH 主机指纹？',
        message: `首次连接 ${selectedServer.name} 的${targetName}。请先通过可信渠道核对：\n\n${result.fingerprint}`,
        confirmLabel: '信任并继续'
      })
      if (!trusted) return null
      await window.labApi.servers.trustHost(editor.serverId, result.fingerprint, result.hostKeyTarget, selectedRouteId)
      await props.onTrusted()
      result = await request()
    }
    if (result.status === 'host-key-required') throw new Error('主机指纹仍未受信任，请重新检查服务器连接配置')
    return result.value
  }

  const requireCondaConnection = (): { config: CondaEnvironmentConfig; server: ServerProfile; routeId: string } => {
    if (!editor || !selectedServer || !selectedRouteId) throw new Error('请先选择服务器')
    if (selectedServer.mode !== 'real') throw new Error('演示服务器不支持 Conda 操作')
    const config = editor.condaEnvironment ?? { manager: 'conda' as CondaManager }
    return { config, server: selectedServer, routeId: selectedRouteId }
  }

  const requireCondaTarget = (): { config: CondaEnvironmentConfig; server: ServerProfile; routeId: string } => {
    const { config, server, routeId } = requireCondaConnection()
    if (Boolean(config.environmentName?.trim()) === Boolean(config.environmentPrefix?.trim())) {
      throw new Error('请填写 Conda 环境名或环境前缀路径其中一项')
    }
    return { config, server, routeId }
  }

  const detectEnvironments = async (): Promise<void> => {
    const requestId = ++condaRequestId.current
    setCondaBusy(true)
    try {
      const { config, server, routeId } = requireCondaConnection()
      const result = await performCondaRequest(() => window.labApi.experiments.listCondaEnvironments(server.id, routeId, config.manager, config.managerPath))
      if (!result || requestId !== condaRequestId.current) return
      updateConda({ managerPath: result.managerPath })
      setEnvs(result.environments)
      props.notify(`发现 ${result.environments.length} 个 Conda 环境`)
    } catch (error) {
      if (requestId !== condaRequestId.current) return
      updateConda({ lastCheckStatus: 'unknown', lastCheckedAt: new Date().toISOString() })
      props.notify(error instanceof Error ? error.message : '读取 Conda 环境失败', 'error')
    } finally {
      if (requestId === condaRequestId.current) setCondaBusy(false)
    }
  }

  const checkEnvironment = async (): Promise<void> => {
    setCondaBusy(true)
    try {
      const { config, server, routeId } = requireCondaTarget()
      const result = await performCondaRequest(() => window.labApi.experiments.checkCondaEnvironment(server.id, routeId, config))
      if (!result) return
      updateConda({
        managerPath: result.managerPath,
        lastCheckStatus: result.found ? 'found' : 'missing',
        lastCheckedAt: new Date().toISOString(),
        pythonInterpreterPath: result.pythonInterpreterPath,
        pythonVersion: result.pythonVersion
      })
      if (result.found) {
        props.notify(`已找到环境 ${result.name}${result.pythonVersion ? ` · Python ${result.pythonVersion}` : ''}`)
      } else props.notify(`没有找到环境 ${result.name}`, 'error')
    } catch (error) {
      updateConda({ lastCheckStatus: 'unknown', lastCheckedAt: new Date().toISOString() })
      props.notify(error instanceof Error ? error.message : '检查 Conda 环境失败', 'error')
    } finally {
      setCondaBusy(false)
    }
  }

  useEffect(() => {
    if (!editor || !condaEnabled || !selectedServer || selectedServer.mode !== 'real' || !selectedRouteId) {
      condaRequestId.current += 1
      setCondaBusy(false)
      return
    }
    void detectEnvironments()
    return () => { condaRequestId.current += 1 }
  }, [Boolean(editor), editor?.id, editor?.serverId, condaEnabled, selectedRouteId, editor?.condaEnvironment?.manager])

  const startTask = async (task: ExperimentTask): Promise<void> => {
    if (task.status === 'queued' || task.status === 'preparing' || task.status === 'running') return
    const server = task.serverId ? props.servers.find((item) => item.id === task.serverId) : undefined
    const routeId = server && task.accessRouteId && getAccessRoutes(server).some((route) => route.id === task.accessRouteId)
      ? task.accessRouteId
      : server ? getDefaultAccessRouteId(server) : null
    setRunDraft({
      serverId: server?.id ?? null,
      accessRouteId: routeId,
      gpuUuid: null,
      gpuIndex: null,
      gpuNameSnapshot: null,
      codePath: task.codePath,
      dataPath: task.dataPath,
      launchCommand: task.launchCommand,
      condaEnvironment: task.condaEnvironment ? structuredClone(task.condaEnvironment) : null,
      minimumFreeVramGiB: task.minimumFreeVramGiB ?? null,
      maximumGpuUtilizationPercent: task.maximumGpuUtilizationPercent ?? null,
      artifactPath: task.artifactPath,
      notes: ''
    })
    setStarting(task)
  }

  const recordRun = async (): Promise<void> => {
    if (!starting || !runDraft || startingTaskId) return
    const selectedRunServer = runDraft.serverId ? props.servers.find((server) => server.id === runDraft.serverId) : undefined
    if (!selectedRunServer) {
      props.notify('请先为任务指定一台服务器和连接路径。', 'error')
      return
    }
    if (!runRouteId) {
      props.notify('该服务器没有可用的连接路径，请先编辑服务器配置。', 'error')
      return
    }
    if (selectedRunServer.mode !== 'real') {
      props.notify('演示服务器不能作为实验运行目标，请选择真实服务器。', 'error')
      return
    }
    if (selectedRunServer.id !== starting.serverId) {
      props.notify('任务只能在当前指定服务器内调度，请编辑任务的目标服务器后再重试。', 'error')
      return
    }
    if (runDraft.condaEnvironment && !runDraft.condaEnvironment.environmentName?.trim() && !runDraft.condaEnvironment.environmentPrefix?.trim()) {
      props.notify('本次运行配置了 Conda 管理器，请填写环境名或环境前缀路径', 'error')
      return
    }
    if (!runDraft.codePath.trim() || !runDraft.launchCommand.trim()) {
      props.notify('自动运行需要填写代码目录和启动命令', 'error')
      return
    }
    for (const [label, path] of [['代码目录', runDraft.codePath], ['数据目录', runDraft.dataPath], ['产物路径', runDraft.artifactPath]] as const) {
      if (path && (!path.startsWith('/') || path.includes('\0'))) {
        props.notify(`${label}必须填写服务器上的绝对路径`, 'error')
        return
      }
    }
    setStartingTaskId(starting.id)
    try {
      props.onChanged(await window.labApi.experiments.startRun(starting.id, {
        ...runDraft,
        accessRouteId: runRouteId,
        ...(manuallySelectedGpu ? { minimumFreeVramGiB: null, maximumGpuUtilizationPercent: null } : {})
      }))
      props.notify(runDraft.gpuUuid || runDraft.gpuIndex !== null
        ? `已请求在 GPU ${runDraft.gpuIndex ?? ''} 上立即启动任务`
        : '任务已加入自动队列；系统会按显存和利用率条件选择 GPU')
      setStarting(null)
      setRunDraft(null)
    } catch (error) {
      props.notify(error instanceof Error ? error.message : '无法创建运行记录', 'error')
    } finally {
      setStartingTaskId(null)
    }
  }

  const cancelRun = async (task: ExperimentTask, run: ExperimentTask['runs'][number]): Promise<void> => {
    const accepted = await props.confirm({
      title: '取消正在准备/运行的任务？',
      message: run.status === 'running'
        ? 'LabDeck 会向服务器上的任务进程组发送终止信号，等待 3 秒后仍未退出则强制终止。'
        : '任务会立即标记为已取消；如果远程启动命令正在返回，LabDeck 会在检测到后清理该进程。',
      confirmLabel: '取消任务',
      tone: 'danger'
    })
    if (!accepted) return
    setCancelingRunId(run.id)
    try {
      props.onChanged(await window.labApi.experiments.cancelRun(task.id, run.id))
      props.notify('任务已取消')
    } catch (error) {
      props.notify(error instanceof Error ? error.message : '无法取消远程任务', 'error')
    } finally {
      setCancelingRunId(null)
    }
  }

  const deleteQueuedRun = async (task: ExperimentTask, runId: string): Promise<void> => {
    if (!await props.confirm({ title: '删除本次排队？', message: '仅移除这次尚未启动的运行，保留任务和其他运行记录。', confirmLabel: '删除排队项', tone: 'danger' })) return
    setDeletingItemId(runId)
    try {
      const updated = await window.labApi.experiments.deleteQueuedRun(task.id, runId)
      if (updated) props.onChanged(updated)
      props.notify('排队项已删除')
    } catch (error) {
      props.notify(error instanceof Error ? error.message : '无法删除排队项', 'error')
    } finally {
      setDeletingItemId(null)
    }
  }

  const deleteTask = async (task: ExperimentTask): Promise<void> => {
    const accepted = await props.confirm({
      title: '删除任务？',
      message: `将删除“${task.title}”的任务配置、排队项及 ${task.runs.length} 次运行记录，无法恢复。服务器上的代码、数据和日志文件不会被删除。`,
      confirmLabel: '删除任务',
      tone: 'danger'
    })
    if (!accepted) return
    setDeletingItemId(task.id)
    try {
      await window.labApi.experiments.deleteTask(task.id)
      if (expandedTaskId === task.id) setExpandedTaskId(null)
      if (inspectedTaskId === task.id) setInspectedTaskId(null)
      props.notify('任务已删除')
    } catch (error) {
      props.notify(error instanceof Error ? error.message : '无法删除任务', 'error')
    } finally {
      setDeletingItemId(null)
    }
  }

  const finishRun = async (): Promise<void> => {
    if (!finishing) return
    const run = activeRun(finishing)
    if (!run) return
    try {
      props.onChanged(await window.labApi.experiments.finishRun(finishing.id, run.id, finishInput))
      props.notify('运行记录已更新')
      setFinishing(null)
    } catch (error) {
      props.notify(error instanceof Error ? error.message : '无法保存运行结果', 'error')
    }
  }

  const taskContext = (task: ExperimentTask): { server: ServerProfile; routeId: string; codePath: string; dataPath: string; conda?: CondaEnvironmentConfig } | null => {
    const run = activeRun(task)
    const serverId = run ? run.serverId : task.serverId
    const server = serverId ? props.servers.find((item) => item.id === serverId) : undefined
    if (!server) return null
    const routeCandidate = run ? run.accessRouteId : task.accessRouteId
    const routeId = routeCandidate && getAccessRoutes(server).some((route) => route.id === routeCandidate)
      ? routeCandidate
      : getDefaultAccessRouteId(server)
    return {
      server,
      routeId,
      codePath: run ? run.codePath ?? '' : task.codePath,
      dataPath: run ? run.dataPath ?? '' : task.dataPath,
      conda: run ? run.condaEnvironment : task.condaEnvironment
    }
  }

  const openTaskTerminal = (task: ExperimentTask, activateEnvironment = false): void => {
    const context = taskContext(task)
    if (!context) {
      props.notify('请为任务选择一台仍然可用的真实服务器', 'error')
      return
    }
    if (context.server.mode !== 'real') {
      props.notify('演示服务器不能打开远程终端', 'error')
      return
    }
    const workingDirectory = context.codePath || undefined
    let command = workingDirectory ? `cd -- ${quoteShell(workingDirectory)}` : undefined
    if (activateEnvironment) {
      const config = context.conda
      if (!config || (!config.environmentName?.trim() && !config.environmentPrefix?.trim())) {
        props.notify('请先为任务配置 Conda 环境名称或前缀路径', 'error')
        return
      }
      const target = quoteShell(config.environmentName?.trim() || config.environmentPrefix!.trim())
      const manager = quoteShell(config.managerPath?.trim() || config.manager)
      const hook = config.manager === 'conda'
        ? `${manager} shell.bash hook`
        : `${manager} shell hook -s bash`
      const activate = `eval "$(${hook})" && ${manager} activate ${target}`
      command = command ? `${command} && ${activate}` : activate
    }
    const opened = props.onOpenTerminal(context.server, context.routeId, workingDirectory, command, activateEnvironment ? `Conda · ${task.title}` : `实验 · ${task.title}`)
    if (opened && activateEnvironment) {
      props.notify('已在终端准备 Conda shell 初始化和激活命令；请查看终端输出确认激活结果。')
    }
  }

  const openTaskVsCode = (server: ServerProfile, routeId: string, codePath: string, conda?: CondaEnvironmentConfig): void => {
    props.onOpenVsCode(server, routeId, codePath || undefined)
    if (conda?.pythonInterpreterPath) {
      props.notify(`VS Code Remote-SSH 已请求打开。若未自动选择此 Conda 环境，请运行“Python: Select Interpreter”→“Enter interpreter path”，填写：${conda.pythonInterpreterPath}`)
    } else if (conda) {
      props.notify('VS Code Remote-SSH 已请求打开。此环境还没有检测到 Python 解释器路径；可先在任务编辑器中检查环境，再在 VS Code 运行“Python: Select Interpreter”。')
    }
  }

  const copyTask = async (task: ExperimentTask): Promise<void> => {
    try {
      const serverAvailable = Boolean(task.serverId && props.servers.some((server) => server.id === task.serverId))
      const copy = await window.labApi.experiments.save({
        title: `${task.title} · 副本`,
        project: task.project,
        objective: task.objective,
        tags: [...task.tags],
        priority: task.priority,
        status: 'planned',
        serverId: serverAvailable ? task.serverId : undefined,
        serverNameSnapshot: task.serverNameSnapshot,
        accessRouteId: serverAvailable ? task.accessRouteId : undefined,
        gpuUuid: serverAvailable ? task.gpuUuid : undefined,
        gpuIndex: serverAvailable ? task.gpuIndex : undefined,
        gpuNameSnapshot: serverAvailable ? task.gpuNameSnapshot : undefined,
        codePath: task.codePath,
        dataPath: task.dataPath,
        launchCommand: task.launchCommand,
        condaEnvironment: task.condaEnvironment ? structuredClone(task.condaEnvironment) : undefined,
        minimumFreeVramGiB: task.minimumFreeVramGiB,
        maximumGpuUtilizationPercent: task.maximumGpuUtilizationPercent,
        artifactPath: '',
        resultSummary: '',
        notes: task.notes
      })
      props.onChanged(copy)
      props.notify('已复制实验任务')
    } catch (error) {
      props.notify(error instanceof Error ? error.message : '无法复制实验任务', 'error')
    }
  }

  return <div className="experiment-pool-page">
    <div className="experiment-pool-tabs" role="tablist" aria-label="我的任务视图">
      <button type="button" role="tab" aria-selected={tab === 'pool'} className={tab === 'pool' ? 'active' : ''} onClick={() => setTab('pool')}><ListTodo size={16} />实验任务池<span>{props.tasks.filter((task) => !task.archived).length}</span></button>
      <button type="button" role="tab" aria-selected={tab === 'live'} className={tab === 'live' ? 'active' : ''} onClick={() => setTab('live')}><Cpu size={16} />GPU 实时进程<span>{props.liveTaskCount}</span></button>
    </div>
    {tab === 'live' ? props.liveTasks : <>
      <section className="experiment-pool-overview">
        <div><div className="experiment-pool-icon"><ListTodo size={19} /></div><span>待开始<strong>{props.tasks.filter((task) => !task.archived && task.status === 'planned').length}</strong></span></div>
        <div><div className="experiment-pool-icon running"><Play size={18} /></div><span>排队 / 运行 / 暂停<strong>{activeCount}</strong></span></div>
        <div><div className="experiment-pool-icon done"><CheckCircle2 size={19} /></div><span>已完成<strong>{props.tasks.filter((task) => !task.archived && task.status === 'completed').length}</strong></span></div>
      </section>
      <section className="panel experiment-task-panel">
        <div className="experiment-task-toolbar">
          <div><h2>{showArchived ? '已归档任务' : '实验任务池'}</h2><p>按服务器排队，自动分配空闲 GPU</p></div>
          <div className="experiment-task-toolbar-actions">
            <input aria-label="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、项目或标签" />
            <select aria-label="筛选任务状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">全部状态</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select aria-label="筛选服务器" value={filterServer} onChange={(event) => setFilterServer(event.target.value)}><option value="all">全部服务器</option>{props.servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select>
            <details className="experiment-task-filters">
              <summary>更多筛选{[filterProject, filterPriority, filterTag].filter((value) => value !== 'all').length > 0 && <span>{[filterProject, filterPriority, filterTag].filter((value) => value !== 'all').length}</span>}<ChevronDown size={13} /></summary>
              <div>
                <label>项目<select aria-label="筛选项目" value={filterProject} onChange={(event) => setFilterProject(event.target.value)}><option value="all">全部项目</option>{projectOptions.map((project) => <option key={project} value={project}>{project}</option>)}</select></label>
                <label>优先级<select aria-label="筛选优先级" value={filterPriority} onChange={(event) => setFilterPriority(event.target.value)}><option value="all">全部优先级</option>{Object.entries(priorityNames).map(([value, label]) => <option key={value} value={value}>{label}优先级</option>)}</select></label>
                <label>标签<select aria-label="筛选标签" value={filterTag} onChange={(event) => setFilterTag(event.target.value)}><option value="all">全部标签</option>{tagOptions.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>
                <button type="button" className="secondary-button" onClick={() => { setFilterProject('all'); setFilterPriority('all'); setFilterTag('all') }}>清除更多筛选</button>
              </div>
            </details>
            <button type="button" className="secondary-button" onClick={() => setShowArchived((value) => !value)}>{showArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{showArchived ? '返回任务池' : '已归档'}</button>
            {!showArchived && <button type="button" className="primary-button" onClick={() => openEditor()}><Plus size={16} />添加实验任务</button>}
          </div>
        </div>
        {visibleTasks.length ? <div className="experiment-task-list">
          <div className="wb-table-scroll"><table className="wb-table experiment-pool-table"><thead><tr><th>任务</th><th>状态</th><th>优先级</th><th>服务器</th><th>运行记录</th><th>更新于</th><th>操作</th></tr></thead><tbody>{visibleTasks.map((task) => <tr key={task.id} className={inspectedTaskId === task.id ? 'selected' : ''}>
            <td><button className="wb-text-button" onClick={() => setInspectedTaskId((current) => current === task.id ? null : task.id)}>{task.title}</button>{task.project && <small>{task.project}</small>}</td>
            <td><span className={`wb-state ${task.status}`}><i />{statusNames[task.status]}</span></td><td>{priorityNames[task.priority]}</td>
            <td>{props.servers.find((server) => server.id === task.serverId)?.name ?? task.serverNameSnapshot ?? '未指定'}</td><td>{task.runs.length} 次</td><td>{new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
            <td><div className="experiment-row-actions"><button className="wb-text-button" onClick={() => setInspectedTaskId((current) => current === task.id ? null : task.id)}>{inspectedTaskId === task.id ? '收起' : '详情'}</button><button className="icon-button small" aria-label={`删除任务 ${task.title}`} title={['preparing', 'running'].includes(task.status) ? '先取消运行，再删除任务' : '删除任务及运行记录'} disabled={deletingItemId === task.id || ['preparing', 'running'].includes(task.status) || task.runs.some((run) => run.status === 'preparing' || run.status === 'running')} onClick={() => void deleteTask(task)}><Trash2 size={13} /></button></div></td>
          </tr>)}</tbody></table></div>
          {visibleTasks.filter((task) => task.id === inspectedTaskId).map((task) => {
            const run = activeRun(task)
            const serverId = run ? run.serverId : task.serverId
            const server = serverId ? props.servers.find((item) => item.id === serverId) : undefined
            const serverSnapshot = server ? props.snapshots[server.id] : undefined
            const serverOffline = serverSnapshot?.status === 'offline'
            const candidateRouteId = run ? run.accessRouteId : task.accessRouteId
            const routeId = server && candidateRouteId && getAccessRoutes(server).some((route) => route.id === candidateRouteId)
              ? candidateRouteId
              : server ? getDefaultAccessRouteId(server) : undefined
            const codePath = run ? run.codePath ?? '' : task.codePath
            const dataPath = run ? run.dataPath ?? '' : task.dataPath
            const launchCommand = run ? run.launchCommand ?? '' : task.launchCommand
            const artifactPath = run ? run.artifactPath ?? '' : task.artifactPath
            const gpuNameSnapshot = run?.gpuNameSnapshot
            const gpuIndex = run?.gpuIndex
            const minimumFreeVramGiB = run ? run.minimumFreeVramGiB : task.minimumFreeVramGiB
            const maximumGpuUtilizationPercent = run ? run.maximumGpuUtilizationPercent : task.maximumGpuUtilizationPercent
            const failureRun = [...task.runs].reverse().find((item) => item.status === 'failed')
            const condaConfig = run ? run.condaEnvironment : task.condaEnvironment
            const serverNameSnapshot = run ? run.serverNameSnapshot : task.serverNameSnapshot
            return <article className={`experiment-task-card status-${task.status}`} key={task.id}>
              <header className="experiment-task-card-heading">
                <div><h3>{task.title}</h3><span className={`experiment-status-pill ${task.status}`}>{task.status === 'failed' && <CircleAlert size={12} />}{statusNames[task.status]}</span><span className={`experiment-priority ${task.priority}`}>{priorityNames[task.priority]}优先级</span>{task.project && <span className="experiment-project-label">{task.project}</span>}</div>
                <small>更新于 {new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
              </header>
              <div className="experiment-task-card-main">
                <div className="experiment-task-copy">{task.objective && <p>{task.objective}</p>}
                  <div className="experiment-task-meta">
                    {server ? <span><Server size={13} />{server.name}{routeId ? ` · ${getAccessRoute(server, routeId).name}` : ''}</span> : serverNameSnapshot ? <span><Server size={13} />{serverNameSnapshot}（服务器已移除）</span> : null}
                    {serverOffline && <span className="experiment-server-offline">服务器离线 · 远程操作不可用</span>}
                    {gpuNameSnapshot && <span><Cpu size={13} />{gpuNameSnapshot}{gpuIndex !== undefined ? ` · GPU ${gpuIndex}` : ''}</span>}
                    {minimumFreeVramGiB !== undefined && minimumFreeVramGiB !== null && <span><Cpu size={13} />空闲显存 ≥ {minimumFreeVramGiB} GiB</span>}
                    {maximumGpuUtilizationPercent !== undefined && maximumGpuUtilizationPercent !== null && <span><Cpu size={13} />GPU 利用率 ≤ {maximumGpuUtilizationPercent}%</span>}
                    {condaConfig?.environmentName && <span>Conda · {condaConfig.environmentName}</span>}
                    {!condaConfig?.environmentName && condaConfig?.environmentPrefix && <span title={condaConfig.environmentPrefix}>Conda · {condaConfig.environmentPrefix.split(/[\\/]/).filter(Boolean).pop()}</span>}
                    {condaConfig?.pythonVersion && <span>Python {condaConfig.pythonVersion}</span>}
                  </div>
                  {!!task.tags.length && <div className="experiment-tags">{task.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
                  <details className="experiment-task-details">
                    <summary><Code2 size={13} />命令与配置<ChevronDown size={13} /></summary>
                    <div className="experiment-task-detail-content">
                      <div className="experiment-task-meta">                    {condaConfig?.pythonInterpreterPath && <span className="experiment-path" title={condaConfig.pythonInterpreterPath}>解释器 · {condaConfig.pythonInterpreterPath}</span>}
                    {condaConfig?.lastCheckStatus && <span className={`experiment-conda-check ${condaConfig.lastCheckStatus}`}>{condaConfig.lastCheckStatus === 'found' ? '环境已验证' : condaConfig.lastCheckStatus === 'missing' ? '环境不存在' : '环境未验证'}{condaConfig.lastCheckedAt ? ` · ${new Date(condaConfig.lastCheckedAt).toLocaleDateString('zh-CN')}` : ''}</span>}
                    {codePath && <span className="experiment-path" title={codePath}>代码 · {codePath}</span>}
                    {dataPath && <span className="experiment-path" title={dataPath}>数据 · {dataPath}</span>}</div>
                  {task.resultSummary && <p className="experiment-result"><strong>最近结果：</strong>{task.resultSummary}</p>}
                  {task.notes && <p><strong>任务备注：</strong>{task.notes}</p>}
                  {artifactPath && <p><strong>日志/模型：</strong>{artifactPath}</p>}
                  {launchCommand && <code className="experiment-launch-preview">{launchCommand}</code>}

                    </div>
                  </details>
                  {run && <div className={`experiment-run-active ${run.status}`}><span>第 {run.number} 次 · {run.startedAt ? `启动于 ${new Date(run.startedAt).toLocaleString('zh-CN')}` : `排队于 ${new Date(run.queuedAt ?? task.updatedAt).toLocaleString('zh-CN')}`}</span>{run.message && <span>{run.message}</span>}{run.logPath && <span className="experiment-path" title={run.logPath}>日志 · {run.logPath}</span>}</div>}
                  {task.status === 'failed' && failureRun && <div className="experiment-run-failure"><strong><CircleAlert size={14} />本次运行异常</strong><span>{failureRun.message || '任务进程异常结束'}</span>{failureRun.logPath && <span className="experiment-path" title={failureRun.logPath}>远程日志 · {failureRun.logPath}</span>}</div>}
                </div>
                <div className="experiment-task-actions">
                  {!showArchived && !['queued', 'preparing', 'running'].includes(task.status) && <button type="button" className="primary-button" onClick={() => void startTask(task)} disabled={startingTaskId === task.id}><Play size={15} />{task.status === 'paused' ? '再次排队' : task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed' ? '再次排队' : '加入队列'}</button>}
                  {!showArchived && run && (run.status === 'preparing' || run.status === 'running') && <button type="button" className="secondary-button danger-button" disabled={cancelingRunId === run.id} onClick={() => void cancelRun(task, run)}><Ban size={14} />{cancelingRunId === run.id ? '正在取消…' : '取消运行'}</button>}
                  {server?.mode === 'real' && routeId && <button type="button" className="secondary-button" onClick={() => openTaskTerminal(task)} disabled={serverOffline} title={serverOffline ? '服务器离线，远程操作暂不可用' : undefined}><SquareTerminal size={15} />终端</button>}
                  {server?.mode === 'real' && routeId && <button type="button" className="secondary-button" title={serverOffline ? '服务器离线，远程操作暂不可用' : condaConfig?.pythonInterpreterPath ? `VS Code 解释器参考路径：${condaConfig.pythonInterpreterPath}` : '打开代码目录；Conda 解释器需在 VS Code 中手动选择'} onClick={() => openTaskVsCode(server, routeId, codePath, condaConfig)} disabled={serverOffline || props.vscodeConnectingId === server.id}><Code2 size={15} />VS Code</button>}
                  {!showArchived && <button type="button" className="secondary-button" onClick={() => openEditor(task)}>编辑</button>}
                  <details className="experiment-task-more" onKeyDown={(event) => { if (event.key === 'Escape') event.currentTarget.open = false }}>
                    <summary><MoreHorizontal size={16} />更多</summary>
                    <div className="experiment-task-more-menu" onClick={(event) => { if ((event.target as HTMLElement).closest('button:not(:disabled)')) { const details = event.currentTarget.closest('details'); if (details) details.open = false } }}>
                      {run?.status === 'queued' && task.runs.length > 1 && <button type="button" className="secondary-button" disabled={deletingItemId === run.id} onClick={() => void deleteQueuedRun(task, run.id)}><Trash2 size={14} />删除本次排队</button>}
                  {server?.mode === 'real' && routeId && codePath && <button type="button" className="secondary-button" onClick={() => props.onOpenFiles(server, routeId, codePath)} disabled={serverOffline} title={serverOffline ? '服务器离线，远程操作暂不可用' : undefined}><FolderOpen size={15} />代码目录</button>}
                  {server?.mode === 'real' && routeId && dataPath && <button type="button" className="secondary-button" onClick={() => props.onOpenFiles(server, routeId, dataPath)} disabled={serverOffline} title={serverOffline ? '服务器离线，远程操作暂不可用' : undefined}><FolderOpen size={15} />数据目录</button>}
                  {server?.mode === 'real' && routeId && condaConfig && (condaConfig.environmentName || condaConfig.environmentPrefix) && <button type="button" className="secondary-button" onClick={() => openTaskTerminal(task, true)} disabled={serverOffline} title={serverOffline ? '服务器离线，远程操作暂不可用' : undefined}><SquareTerminal size={15} />激活 Conda</button>}
                  {!showArchived && run && (run.status === 'paused' || (run.status === 'running' && !run.remoteRunDir)) && <button type="button" className="secondary-button" onClick={() => { setFinishing(task); setFinishInput({ status: run.status === 'paused' ? 'completed' : 'paused', resultSummary: run.resultSummary, notes: run.notes, artifactPath: run.artifactPath ?? '' }) }}><CheckCircle2 size={15} />结束/暂停</button>}
                  {!showArchived && !run && task.status === 'planned' && <button type="button" className="secondary-button" onClick={() => void window.labApi.experiments.setStatus(task.id, 'completed').then(props.onChanged).catch((error: unknown) => props.notify(error instanceof Error ? error.message : '无法完成任务', 'error'))}><CheckCircle2 size={15} />完成</button>}
                  {!showArchived && !run && task.status === 'planned' && <button type="button" className="secondary-button" onClick={() => void window.labApi.experiments.setStatus(task.id, 'cancelled').then(props.onChanged).catch((error: unknown) => props.notify(error instanceof Error ? error.message : '无法取消任务', 'error'))}>取消</button>}
                  {!showArchived && <button type="button" className="secondary-button" onClick={() => void copyTask(task)}>复制</button>}
                  <button type="button" className="secondary-button" disabled={!task.archived && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled'} title={!task.archived && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled' ? '完成、失败或取消任务后可归档' : undefined} onClick={() => void window.labApi.experiments.setArchived(task.id, !task.archived).then(props.onChanged).catch((error: unknown) => props.notify(error instanceof Error ? error.message : '归档失败', 'error'))}>{task.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{task.archived ? '恢复' : '归档'}</button>
                    </div>
                  </details>
                  <button type="button" className="secondary-button danger-button experiment-delete-task" disabled={deletingItemId === task.id || ['preparing', 'running'].includes(task.status) || task.runs.some((item) => item.status === 'preparing' || item.status === 'running')} title={['preparing', 'running'].includes(task.status) ? '先取消运行，再删除任务' : '删除任务及运行记录'} onClick={() => void deleteTask(task)}><Trash2 size={14} />{deletingItemId === task.id ? '删除中…' : '删除任务'}</button>
                </div>
              </div>
              <footer className="experiment-task-card-footer"><span>{task.runs.length} 次运行记录</span>{task.runs.length > 0 && <button type="button" onClick={() => setExpandedTaskId((current) => current === task.id ? null : task.id)}>{expandedTaskId === task.id ? '收起运行记录' : '查看运行记录'}</button>}</footer>
              {expandedTaskId === task.id && <div className="experiment-run-history">{[...task.runs].reverse().map((item) => <section className={`experiment-run-record ${item.status === 'failed' ? 'failed' : ''}`} key={item.id}><header><strong>{item.status === 'failed' && <CircleAlert size={13} />}第 {item.number} 次运行</strong><span className={`experiment-status-pill ${item.status}`}>{statusNames[item.status]}</span><time>{item.startedAt ? new Date(item.startedAt).toLocaleString('zh-CN') : item.queuedAt ? `排队于 ${new Date(item.queuedAt).toLocaleString('zh-CN')}` : '时间未知'}{item.finishedAt ? ` — ${new Date(item.finishedAt).toLocaleString('zh-CN')}` : item.status === 'paused' ? ' — 已暂停' : item.status === 'queued' ? ' — 等待 GPU' : item.status === 'preparing' ? ' — 准备运行' : item.status === 'running' ? ' — 进行中' : ''}</time></header>{item.message && <p className={`experiment-run-message ${item.status === 'failed' ? 'failed' : ''}`}>{item.message}</p>}<div className="experiment-run-snapshot">{item.serverNameSnapshot && <span>服务器：{item.serverNameSnapshot}</span>}{item.gpuNameSnapshot && <span>GPU：{item.gpuNameSnapshot}{item.gpuIndex !== undefined ? ` · ${item.gpuIndex}` : ''}</span>}{item.codePath && <span>代码：{item.codePath}</span>}{item.dataPath && <span>数据：{item.dataPath}</span>}{item.condaEnvironment && <span>管理器：{item.condaEnvironment.manager}</span>}{item.condaEnvironment?.environmentName && <span>Conda：{item.condaEnvironment.environmentName}</span>}{item.condaEnvironment?.environmentPrefix && <span>Conda：{item.condaEnvironment.environmentPrefix}</span>}{item.condaEnvironment?.pythonVersion && <span>Python：{item.condaEnvironment.pythonVersion}</span>}{item.condaEnvironment?.pythonInterpreterPath && <span>解释器：{item.condaEnvironment.pythonInterpreterPath}</span>}{item.condaEnvironment?.environmentFilePath && <span>环境文件：{item.condaEnvironment.environmentFilePath}</span>}{item.artifactPath && <span>日志/模型：{item.artifactPath}</span>}{item.logPath && <span>运行日志：{item.logPath}</span>}</div>{item.launchCommand && <code className="experiment-run-command">{item.launchCommand}</code>}{item.resultSummary && <p><strong>结果：</strong>{item.resultSummary}</p>}{item.notes && <p><strong>备注：</strong>{item.notes}</p>}</section>)}</div>}
            </article>
          })}
        </div> : <div className="experiment-task-empty"><ListTodo size={34} /><strong>{showArchived ? '还没有归档的任务' : '任务池还是空的'}</strong><span>先添加一个实验任务，再记录代码目录、数据位置和运行命令。</span>{!showArchived && <button type="button" className="primary-button" onClick={() => openEditor()}><Plus size={15} />创建第一个任务</button>}</div>}
      </section>
    </>}

    {editor && <div className="app-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !condaBusy) setEditor(null) }}>
      <section className="app-modal experiment-editor" role="dialog" aria-modal="true" aria-labelledby="experiment-editor-title">
        <header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><ListTodo size={19} /></div><div><h2 id="experiment-editor-title">{editor.id ? '编辑实验任务' : '添加实验任务'}</h2><p>填写服务器、代码目录、启动命令和可选 Conda 环境</p></div></div><button type="button" className="icon-button" onClick={() => setEditor(null)} aria-label="关闭" disabled={condaBusy}>×</button></header>
        <div className="experiment-editor-body">
          {editor.gpuUuid && <div className="experiment-auto-gpu-note">指定运行设备：GPU {editor.gpuIndex} · {editor.gpuNameSnapshot}<button type="button" className="wb-text-button" onClick={() => updateDraft({ gpuUuid: undefined, gpuIndex: undefined, gpuNameSnapshot: undefined })}>改为自动分配</button></div>}
          <div className="form-grid">
            <label className="field field-wide"><span>任务名称 *</span><input autoFocus value={editor.title} maxLength={160} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="例如：ResNet50 消融实验" /></label>
            <label className="field"><span>项目/课题</span><input value={editor.project ?? ''} onChange={(event) => updateDraft({ project: event.target.value })} placeholder="项目名称" /></label>
            <label className="field"><span>优先级</span><select value={editor.priority} onChange={(event) => updateDraft({ priority: event.target.value as ExperimentTaskDraft['priority'] })}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option></select></label>
            <label className="field field-wide"><span>实验目标</span><textarea value={editor.objective ?? ''} onChange={(event) => updateDraft({ objective: event.target.value })} placeholder="记录假设、对比项或预期指标" rows={2} /></label>
            <label className="field"><span>目标服务器</span><select value={editor.serverId ?? ''} disabled={condaBusy} onChange={async (event) => {
              const server = props.servers.find((item) => item.id === event.target.value)
              if (editor.serverId !== server?.id && (editor.codePath || editor.dataPath)) {
                const accepted = await props.confirm({
                  title: '更换任务服务器？',
                  message: '代码目录和数据目录属于各自服务器本地路径。更换目标后路径内容会保留，请先检查新服务器上是否存在这些目录。',
                  confirmLabel: '更换服务器'
                })
                if (!accepted) return
              }
              const condaEnvironment = editor.condaEnvironment ? {
                ...editor.condaEnvironment,
                managerPath: undefined,
                lastCheckStatus: 'unknown' as const,
                lastCheckedAt: undefined,
                pythonInterpreterPath: undefined,
                pythonVersion: undefined
              } : undefined
              updateDraft({ serverId: server?.id, serverNameSnapshot: server?.name, accessRouteId: server ? getDefaultAccessRouteId(server) : undefined, gpuUuid: undefined, gpuIndex: undefined, gpuNameSnapshot: undefined, condaEnvironment })
              setEnvs([])
            }}><option value="">暂不指定</option>{editor.serverId && !props.servers.some((server) => server.id === editor.serverId) && <option value={editor.serverId} disabled>{editor.serverNameSnapshot ?? '已删除的服务器'} · 已删除（仅保留历史）</option>}{props.servers.map((server) => <option key={server.id} value={server.id}>{server.name}{server.mode === 'demo' ? ' · 演示' : ''}</option>)}</select></label>
            <div className="field"><span>GPU 分配方式</span><div className="experiment-auto-gpu-note"><Cpu size={15} /><span>开始运行时可指定 GPU 立即启动；自动队列按显存与利用率筛选</span></div></div>
            <label className="field"><span>最低空闲显存（GiB，可选）</span><input type="number" min="0.1" max="1024" step="0.5" value={editor.minimumFreeVramGiB ?? ''} onChange={(event) => updateDraft({ minimumFreeVramGiB: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="不限制" /><small className="field-help">自动分配时，仅选择空闲显存达到此值的 GPU。</small></label>
            <label className="field"><span>最高 GPU 利用率（%，可选）</span><input type="number" min="0" max="100" step="1" value={editor.maximumGpuUtilizationPercent ?? ''} onChange={(event) => updateDraft({ maximumGpuUtilizationPercent: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="不限制" /><small className="field-help">自动分配时，只选当前利用率不高于此值的 GPU；可与显存条件同时使用。</small></label>
            {selectedServer && selectedRouteId && <div className="field field-wide"><span>连接路径</span><AccessRouteSelect server={selectedServer} value={selectedRouteId} onChange={(routeId) => {
              if (routeId !== selectedRouteId) {
                const condaEnvironment = editor.condaEnvironment ? {
                  ...editor.condaEnvironment,
                  managerPath: undefined,
                  lastCheckStatus: 'unknown' as const,
                  lastCheckedAt: undefined,
                  pythonInterpreterPath: undefined,
                  pythonVersion: undefined
                } : undefined
                updateDraft({ accessRouteId: routeId, condaEnvironment })
                setEnvs([])
              }
            }} /></div>}
            <label className="field field-wide"><span>代码目录（远程绝对路径）</span><input value={editor.codePath} onChange={(event) => updateDraft({ codePath: event.target.value })} placeholder="/home/user/project" /></label>
            <label className="field field-wide"><span>数据目录（远程绝对路径，可在 NAS）</span><input value={editor.dataPath} onChange={(event) => updateDraft({ dataPath: event.target.value })} placeholder="/mnt/nas/datasets/experiment" /></label>
            <label className="field field-wide"><span>启动命令</span><textarea className="experiment-command-input" value={editor.launchCommand} onChange={(event) => updateDraft({ launchCommand: event.target.value })} placeholder="python train.py --config configs/base.yaml" rows={3} /></label>
            <label className="field field-wide"><span>结果摘要</span><textarea value={editor.resultSummary ?? ''} onChange={(event) => updateDraft({ resultSummary: event.target.value })} placeholder="记录任务最近的结论" rows={2} /></label>
            <label className="field field-wide"><span>日志/模型文件路径（服务器上的绝对路径）</span><input value={editor.artifactPath ?? ''} onChange={(event) => updateDraft({ artifactPath: event.target.value })} placeholder="/home/user/project/runs/exp-01" /></label>
            <label className="field field-wide"><span>标签（逗号分隔）</span><input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="baseline, ablation, paper" /></label>
          </div>
          <section className="experiment-conda-section">
            <label className="experiment-conda-toggle"><input type="checkbox" checked={condaEnabled} disabled={condaBusy} onChange={(event) => { setCondaEnabled(event.target.checked); if (event.target.checked && !editor.condaEnvironment) updateConda({ manager: 'conda' }) }} /><span><strong>配置 Conda 环境</strong><small>自动读取服务器上已有的环境，选择后运行任务会使用该环境。</small></span></label>
            {condaEnabled && <div className="experiment-conda-fields form-grid">
              <label className="field"><span>环境管理器</span><select value={editor.condaEnvironment?.manager ?? 'conda'} disabled={condaBusy} onChange={(event) => updateConda({ manager: event.target.value as CondaManager, managerPath: undefined, lastCheckStatus: 'unknown', lastCheckedAt: undefined, pythonInterpreterPath: undefined, pythonVersion: undefined })}><option value="conda">conda</option><option value="mamba">mamba</option><option value="micromamba">micromamba</option></select></label>
              <label className="field"><span>管理器路径（高级，可留空自动识别）</span><input value={editor.condaEnvironment?.managerPath ?? ''} disabled={condaBusy} onChange={(event) => { setEnvs([]); updateConda({ managerPath: event.target.value || undefined }) }} placeholder="自动从服务器 shell 配置或常见安装位置识别" /></label>
              <label className="field field-wide"><span>服务器已有环境</span><select aria-label="服务器已有 Conda 环境" value={editor.condaEnvironment?.environmentPrefix ?? envs.find((env) => env.name === editor.condaEnvironment?.environmentName)?.prefix ?? ''} disabled={condaBusy || envs.length === 0} onChange={(event) => {
                const env = envs.find((item) => item.prefix === event.target.value)
                if (env) updateConda({ environmentPrefix: env.prefix, environmentName: undefined })
              }}><option value="">{condaBusy ? '正在读取服务器环境…' : envs.length ? '选择服务器已有环境' : '未读取到可用环境'}</option>{envs.map((env) => <option key={env.prefix} value={env.prefix}>{env.name} · {env.prefix}</option>)}</select><small className="field-help">配置单打开后会自动读取；环境列表可用下方按钮重新同步。</small></label>
              <div className="experiment-conda-actions field-wide">
                <button type="button" className="secondary-button" onClick={() => void detectEnvironments()} disabled={condaBusy || !selectedServer || selectedServer.mode !== 'real'}>{condaBusy ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}重新读取</button>
                <button type="button" className="secondary-button" onClick={() => void checkEnvironment()} disabled={condaBusy || !selectedServer || selectedServer.mode !== 'real'}>检查所选环境</button>
                {selectedServer?.mode === 'demo' && <small className="field-help">演示服务器仅用于界面预览，Conda 操作需要选择真实服务器。</small>}
              </div>
              {editor.condaEnvironment?.lastCheckStatus && <p className="experiment-conda-python field-wide">最近检查：{editor.condaEnvironment.lastCheckStatus === 'found' ? '环境存在' : editor.condaEnvironment.lastCheckStatus === 'missing' ? '环境不存在' : '状态未知'}{editor.condaEnvironment.lastCheckedAt ? ` · ${new Date(editor.condaEnvironment.lastCheckedAt).toLocaleString('zh-CN')}` : ''}{editor.condaEnvironment.pythonVersion ? ` · Python ${editor.condaEnvironment.pythonVersion}` : ''}</p>}
            </div>}
          </section>
          <label className="field experiment-notes-field"><span>备注</span><textarea value={editor.notes ?? ''} onChange={(event) => updateDraft({ notes: event.target.value })} rows={2} placeholder="记录实验条件或注意事项" /></label>
        </div>
        <footer className="dialog-footer app-modal-footer"><button type="button" className="secondary-button" onClick={() => setEditor(null)} disabled={condaBusy}>取消</button><button type="button" className="secondary-button" onClick={() => void saveTask(false)} disabled={saving || condaBusy || !editor.title.trim()}>保存草稿</button><button type="button" className="primary-button" onClick={() => void saveTask(true)} disabled={saving || condaBusy || !editor.title.trim() || ['queued', 'preparing', 'running'].includes(editor.status)}>{saving ? '保存中…' : '保存并排队'}</button></footer>
      </section>
    </div>}

    {starting && runDraft && <div className="app-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !startingTaskId) { setStarting(null); setRunDraft(null) } }}>
      <section className="app-modal experiment-editor" role="dialog" aria-modal="true" aria-labelledby="experiment-run-start-title">
        <header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><Play size={19} /></div><div><h2 id="experiment-run-start-title">启动实验运行</h2><p>{starting.title} · 可自动分配，也可指定 GPU 立即启动</p></div></div><button type="button" className="icon-button" onClick={() => { setStarting(null); setRunDraft(null) }} aria-label="关闭" disabled={Boolean(startingTaskId)}>×</button></header>
        <div className="experiment-editor-body">
          <p className="experiment-run-manual-note">任务会在指定服务器上通过 SSH 启动，Conda 环境和远程目录会先检查。手动指定 GPU 会按选择的卡执行，不受自动分配的显存和利用率筛选限制；请先确认该卡可用。</p>
          <div className="form-grid">
            {runServer && <div className="field field-wide"><span>指定服务器</span><div className="experiment-auto-gpu-note"><Server size={15} /><span>{runServer.name} · 本任务不会转移到其他服务器</span></div></div>}
            {runServer && runRouteId && <div className="field field-wide"><span>本次连接路径</span><AccessRouteSelect server={runServer} value={runRouteId} onChange={(routeId) => {
              const condaEnvironment = runDraft.condaEnvironment ? {
                ...runDraft.condaEnvironment,
                managerPath: undefined,
                lastCheckStatus: 'unknown' as const,
                lastCheckedAt: undefined,
                pythonInterpreterPath: undefined,
                pythonVersion: undefined
              } : null
              updateRunDraft({ accessRouteId: routeId, condaEnvironment })
            }} /></div>}
            <div className="field field-wide experiment-run-gpu-field"><div className="experiment-run-gpu-heading"><span>GPU 执行方式</span><button type="button" className="secondary-button" onClick={() => void refreshRunGpuSnapshot()} disabled={runGpuRefreshBusy || !runServer || runServer.mode !== 'real'}>{runGpuRefreshBusy ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}刷新 GPU 列表</button></div><select value={runDraft.gpuUuid ?? ''} onChange={(event) => {
              const gpu = runServerSnapshot?.gpus.find((item) => item.uuid === event.target.value)
              updateRunDraft({ gpuUuid: gpu?.uuid ?? null, gpuIndex: gpu?.index ?? null, gpuNameSnapshot: gpu?.name ?? null })
            }}><option value="">自动分配（等待符合条件的 GPU）</option>{manuallySelectedGpu && runDraft.gpuUuid && (runServerSnapshot?.status === 'offline' || !runServerSnapshot?.gpus.some((gpu) => gpu.uuid === runDraft.gpuUuid)) && <option value={runDraft.gpuUuid} disabled>GPU {runDraft.gpuIndex} · 当前采样不可用</option>}{runServerSnapshot?.status !== 'offline' && runServerSnapshot?.gpus.filter((gpu) => gpu.uuid).map((gpu) => {
              const freeGiB = Math.max(0, gpu.memoryTotalMiB - gpu.memoryUsedMiB) / 1024
              return <option key={gpu.uuid} value={gpu.uuid}>GPU {gpu.index} · {gpu.name} · 利用率 {gpu.utilizationPercent}% · 空闲显存 {freeGiB.toFixed(1)} GiB</option>
            })}</select><small className="field-help">{runServerSnapshot?.status === 'offline' ? '服务器最近采样为离线，手动 GPU 暂时不可选；自动队列会在服务器恢复后继续检查。' : runSelectedGpu ? `已选 GPU ${runSelectedGpu.index}，当前利用率 ${runSelectedGpu.utilizationPercent}%，空闲显存 ${(Math.max(0, runSelectedGpu.memoryTotalMiB - runSelectedGpu.memoryUsedMiB) / 1024).toFixed(1)} GiB；提交后会优先立即启动该卡。` : runGpuRefreshBusy ? '正在读取服务器 GPU 状态…' : runServerSnapshot?.sampledAt ? `自动模式将同时应用显存与利用率条件。GPU 状态采样于 ${new Date(runServerSnapshot.sampledAt).toLocaleTimeString('zh-CN')}` : '尚无 GPU 采样；可刷新列表，或使用自动队列等待服务器采样。'}</small></div>
            <label className="field"><span>最低空闲显存（GiB）</span><input type="number" min="0.1" max="1024" step="0.5" value={runDraft.minimumFreeVramGiB ?? ''} disabled={manuallySelectedGpu} onChange={(event) => updateRunDraft({ minimumFreeVramGiB: event.target.value === '' ? null : Number(event.target.value) })} placeholder="不限制" /><small className="field-help">自动模式生效；清空后不限制显存。</small></label>
            <label className="field"><span>最高 GPU 利用率（%）</span><input type="number" min="0" max="100" step="1" value={runDraft.maximumGpuUtilizationPercent ?? ''} disabled={manuallySelectedGpu} onChange={(event) => updateRunDraft({ maximumGpuUtilizationPercent: event.target.value === '' ? null : Number(event.target.value) })} placeholder="不限制" /><small className="field-help">自动模式只选利用率不高于此值的 GPU。</small></label>
            <label className="field field-wide"><span>本次代码目录</span><input value={runDraft.codePath} onChange={(event) => updateRunDraft({ codePath: event.target.value })} placeholder="/home/user/project" /></label>
            <label className="field field-wide"><span>本次数据目录</span><input value={runDraft.dataPath} onChange={(event) => updateRunDraft({ dataPath: event.target.value })} placeholder="/mnt/nas/datasets/experiment" /></label>
            <label className="field field-wide"><span>本次启动命令</span><textarea className="experiment-command-input" rows={3} value={runDraft.launchCommand} onChange={(event) => updateRunDraft({ launchCommand: event.target.value })} placeholder="python train.py --config configs/base.yaml" /></label>
            <label className="field field-wide"><span>日志/模型路径</span><input value={runDraft.artifactPath} onChange={(event) => updateRunDraft({ artifactPath: event.target.value })} placeholder="/home/user/project/runs/exp-01" /></label>
            <label className="field field-wide"><span>本次参数备注</span><textarea rows={2} value={runDraft.notes} onChange={(event) => updateRunDraft({ notes: event.target.value })} placeholder="例如 batch size、随机种子或本次改动" /></label>
          </div>
          <section className="experiment-conda-section">
            <label className="experiment-conda-toggle"><input type="checkbox" checked={Boolean(runDraft.condaEnvironment)} onChange={(event) => updateRunDraft({ condaEnvironment: event.target.checked ? { manager: 'conda', lastCheckStatus: 'unknown' } : null })} /><span><strong>本次使用 Conda 环境</strong><small>启动前会检查环境；未找到时任务留在队列中等待你准备环境。</small></span></label>
            {runDraft.condaEnvironment && <div className="experiment-conda-fields form-grid">
              <label className="field"><span>管理器</span><select value={runDraft.condaEnvironment.manager} onChange={(event) => updateRunConda({ manager: event.target.value as CondaManager, managerPath: undefined, lastCheckStatus: 'unknown', lastCheckedAt: undefined, pythonInterpreterPath: undefined, pythonVersion: undefined })}><option value="conda">conda</option><option value="mamba">mamba</option><option value="micromamba">micromamba</option></select></label>
              <label className="field"><span>管理器路径</span><input value={runDraft.condaEnvironment.managerPath ?? ''} onChange={(event) => updateRunConda({ managerPath: event.target.value || undefined })} placeholder="默认从 PATH 查找" /></label>
              <label className="field"><span>环境名</span><input value={runDraft.condaEnvironment.environmentName ?? ''} onChange={(event) => updateRunConda({ environmentName: event.target.value || undefined, environmentPrefix: undefined })} /></label>
              <label className="field"><span>或前缀路径</span><input value={runDraft.condaEnvironment.environmentPrefix ?? ''} onChange={(event) => updateRunConda({ environmentPrefix: event.target.value || undefined, environmentName: undefined })} /></label>
              <label className="field field-wide"><span>Python 解释器</span><input value={runDraft.condaEnvironment.pythonInterpreterPath ?? ''} onChange={(event) => updateRunConda({ pythonInterpreterPath: event.target.value || undefined })} placeholder="/opt/conda/envs/torch24/bin/python" /></label>
              <label className="field field-wide"><span>环境文件路径</span><input value={runDraft.condaEnvironment.environmentFilePath ?? ''} onChange={(event) => updateRunConda({ environmentFilePath: event.target.value || undefined })} placeholder="/home/user/project/environment.yml" /></label>
              {runDraft.condaEnvironment.lastCheckStatus && <p className="experiment-conda-python field-wide">环境状态：{runDraft.condaEnvironment.lastCheckStatus === 'found' ? '已验证' : runDraft.condaEnvironment.lastCheckStatus === 'missing' ? '不存在' : '未验证'}{runDraft.condaEnvironment.pythonVersion ? ` · Python ${runDraft.condaEnvironment.pythonVersion}` : ''}{runDraft.condaEnvironment.lastCheckedAt ? ` · ${new Date(runDraft.condaEnvironment.lastCheckedAt).toLocaleString('zh-CN')}` : ''}</p>}
            </div>}
          </section>
        </div>
        <footer className="dialog-footer app-modal-footer"><button type="button" className="secondary-button" onClick={() => { setStarting(null); setRunDraft(null) }} disabled={Boolean(startingTaskId)}>返回</button><button type="button" className="primary-button" onClick={() => void recordRun()} disabled={Boolean(startingTaskId)}><Play size={15} />{startingTaskId ? '提交中…' : manuallySelectedGpu && runServerSnapshot?.status === 'offline' ? '服务器恢复后启动所选 GPU' : manuallySelectedGpu ? '在所选 GPU 上立即启动' : '加入自动队列'}</button></footer>
      </section>
    </div>}

    {finishing && <div className="app-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFinishing(null) }}><section className="app-modal experiment-finish-dialog" role="dialog" aria-modal="true" aria-labelledby="experiment-finish-title"><header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><CheckCircle2 size={19} /></div><div><h2 id="experiment-finish-title">结束/暂停运行记录</h2><p>{finishing.title} · 第 {activeRun(finishing)?.number ?? '—'} 次</p></div></div></header><div className="experiment-finish-body"><label className="field"><span>运行状态</span><select value={finishInput.status} onChange={(event) => setFinishInput((value) => ({ ...value, status: event.target.value as ExperimentRunFinishInput['status'] }))}><option value="completed">完成</option><option value="paused">暂停</option></select></label>{finishInput.status === 'paused' && <p className="experiment-pause-help">“暂停”只更新任务记录，不会向服务器上的进程发送暂停信号；要终止远程任务，请使用“取消运行”。</p>}<label className="field"><span>结果摘要</span><textarea rows={3} value={finishInput.resultSummary} onChange={(event) => setFinishInput((value) => ({ ...value, resultSummary: event.target.value }))} placeholder="指标、checkpoint 或异常" /></label><label className="field"><span>运行备注</span><textarea rows={3} value={finishInput.notes} onChange={(event) => setFinishInput((value) => ({ ...value, notes: event.target.value }))} placeholder="本次参数、环境或问题" /></label><label className="field"><span>日志/模型路径</span><input value={finishInput.artifactPath} onChange={(event) => setFinishInput((value) => ({ ...value, artifactPath: event.target.value }))} placeholder="/home/user/project/runs/exp-01" /></label></div><footer className="dialog-footer app-modal-footer"><button type="button" className="secondary-button" onClick={() => setFinishing(null)}>取消</button><button type="button" className="primary-button" onClick={() => void finishRun()}>保存运行记录</button></footer></section></div>}
  </div>
}
