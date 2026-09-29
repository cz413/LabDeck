import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppSettings, ExperimentRun, ExperimentRunFinishInput, ExperimentRunStartInput, ExperimentTask, ExperimentTaskDraft, ExperimentTaskStatus, GpuHistoryPoint, GpuHistoryRange, JumpHostConfig, ServerAccessRoute, ServerProfile, ServerProfileInput, ServerSnapshot } from '../shared/types'
import { appSettingsSchema, experimentRunFinishInputSchema, experimentRunStartInputSchema, experimentTaskDraftSchema, experimentTaskSchema, experimentTaskStatusSchema, serverProfileInputSchema } from '../shared/schemas'
import { getAccessRoutes } from '../shared/access-routes'

interface PersistedData {
  version: number
  servers: ServerProfile[]
  secrets: Record<string, string>
  settings: AppSettings
  gpuHistory: Record<string, GpuHistoryPoint[]>
  lastSnapshots: Record<string, ServerSnapshot>
  experimentTasks: ExperimentTask[]
}

const MAX_GPU_HISTORY_POINTS = 2880

export interface ServerSecrets {
  password?: string
  passphrase?: string
  jumpPassword?: string
  jumpPassphrase?: string
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

const now = (): string => new Date().toISOString()

const parseExperimentTasks = (value: unknown): ExperimentTask[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((task, index) => {
    const parsed = experimentTaskSchema.safeParse(task)
    if (!parsed.success) {
      console.warn(`实验任务记录 ${index + 1} 格式无效，已跳过：`, parsed.error.message)
      return []
    }
    return [parsed.data]
  })
}

const demoServers = (): ServerProfile[] => [
  {
    id: randomUUID(),
    name: 'GPU-01 · 演示节点',
    host: '10.20.0.21',
    port: 22,
    username: 'researcher',
    authType: 'privateKey',
    tags: ['GPU', '训练'],
    group: '深度学习集群',
    mode: 'demo',
    monitorPolicy: 'background',
    hasSecret: false,
    createdAt: now(),
    updatedAt: now()
  },
  {
    id: randomUUID(),
    name: 'GPU-02 · 演示节点',
    host: '10.20.0.22',
    port: 22,
    username: 'researcher',
    authType: 'privateKey',
    tags: ['GPU', '推理'],
    group: '深度学习集群',
    mode: 'demo',
    monitorPolicy: 'background',
    hasSecret: false,
    createdAt: now(),
    updatedAt: now()
  },
  {
    id: randomUUID(),
    name: 'Storage-01 · 演示节点',
    host: '10.20.0.31',
    port: 22,
    username: 'lab',
    authType: 'password',
    tags: ['存储'],
    group: '基础设施',
    mode: 'demo',
    monitorPolicy: 'background',
    hasSecret: false,
    createdAt: now(),
    updatedAt: now()
  }
]

export class AppStore {
  private readonly filePath: string
  private data: PersistedData | null = null
  private persistQueue: Promise<void> = Promise.resolve()
  private historyPersistTimer: NodeJS.Timeout | null = null

  constructor() {
    this.filePath = join(app.getPath('userData'), 'lab-server-manager.json')
  }

  async initialize(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as PersistedData
      const persistedSettings = parsed.settings as Partial<AppSettings> | undefined
      const migratePollingInterval = parsed.version < 6
      this.data = {
        version: 6,
        servers: Array.isArray(parsed.servers)
          ? parsed.servers.map((server) => ({
              ...server,
              monitorPolicy: server.monitorPolicy ?? (server.mode === 'demo' ? 'background' : 'manual')
            }))
          : [],
        secrets: parsed.secrets ?? {},
        settings: appSettingsSchema.parse({
          ...(persistedSettings ?? defaultSettings),
          pollingIntervalSeconds: migratePollingInterval
            ? Math.min(persistedSettings?.pollingIntervalSeconds ?? defaultSettings.pollingIntervalSeconds, 30)
            : persistedSettings?.pollingIntervalSeconds ?? defaultSettings.pollingIntervalSeconds,
          closeBehavior: persistedSettings?.closeBehavior ?? (persistedSettings?.minimizeToTray === false ? 'exit' : 'ask')
        }),
        gpuHistory: parsed.gpuHistory ?? {},
        lastSnapshots: parsed.lastSnapshots ?? {},
        experimentTasks: parseExperimentTasks(parsed.experimentTasks)
      }
      if (migratePollingInterval) await this.persist()
    } catch (error) {
      const isMissing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      if (!isMissing) {
        console.warn('配置读取失败，将使用新的本地配置：', error)
      }
      this.data = {
        version: 6,
        servers: demoServers(),
        secrets: {},
        settings: defaultSettings,
        gpuHistory: {},
        lastSnapshots: {},
        experimentTasks: []
      }
      await this.persist()
    }
  }

  listServers(): ServerProfile[] {
    return structuredClone(this.ensureData().servers)
  }

  getServer(id: string): ServerProfile {
    const server = this.ensureData().servers.find((item) => item.id === id)
    if (!server) throw new Error('服务器不存在或已被删除')
    return structuredClone(server)
  }

  async saveServer(rawInput: ServerProfileInput): Promise<ServerProfile> {
    const input = serverProfileInputSchema.parse(rawInput)
    const data = this.ensureData()
    const existingIndex = input.id
      ? data.servers.findIndex((item) => item.id === input.id)
      : -1
    const existing = existingIndex >= 0 ? data.servers[existingIndex] : undefined
    const id = existing?.id ?? randomUUID()
    const timestamp = now()
    const existingSecret = data.secrets[id]
    const endpointChanged = Boolean(existing && (
      existing.host !== input.host ||
      existing.port !== input.port ||
      existing.username !== input.username ||
      JSON.stringify(existing.accessRoutes ?? []) !== JSON.stringify(input.accessRoutes ?? [])
    ))

    const routeInput = input.accessRoutes?.map((route): ServerAccessRoute => {
      const previous = existing?.accessRoutes?.find((item) => item.id === route.id)
      const sameEndpoint = previous && previous.host === route.host && previous.port === route.port && previous.username === route.username
      const jumpHost = route.jumpHost
        ? {
            ...route.jumpHost,
            hostFingerprint:
              previous?.jumpHost?.host === route.jumpHost.host && previous.jumpHost.port === route.jumpHost.port
                ? previous.jumpHost.hostFingerprint
                : route.jumpHost.hostFingerprint
          }
        : undefined
      return {
        ...route,
        hostFingerprint: sameEndpoint ? previous.hostFingerprint : route.hostFingerprint,
        jumpHost
      }
    })
    const jumpRoute = routeInput?.find((route) => route.kind === 'jump')
    const jumpHostInput = input.jumpHost ?? jumpRoute?.jumpHost

    const profile: ServerProfile = {
      id,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      privateKeyPath: input.privateKeyPath,
      hostFingerprint:
        existing && existing.host === input.host && existing.port === input.port
          ? existing.hostFingerprint
          : undefined,
      tags: input.tags ?? [],
      group: input.group ?? '未分组',
      mode: input.mode ?? 'real',
      monitorPolicy:
        input.monitorPolicy ??
        existing?.monitorPolicy ??
        ((input.mode ?? 'real') === 'demo' ? 'background' : 'manual'),
      jumpHost: jumpHostInput
        ? {
            host: jumpHostInput.host,
            port: jumpHostInput.port,
            username: jumpHostInput.username,
            authType: jumpHostInput.authType,
            privateKeyPath: jumpHostInput.privateKeyPath,
            hostFingerprint:
              existing?.jumpHost?.host === jumpHostInput.host &&
              existing?.jumpHost?.port === jumpHostInput.port
                ? existing.jumpHost.hostFingerprint
                : jumpHostInput.hostFingerprint,
            hasSecret: Boolean(
              input.jumpHost?.password ||
              input.jumpHost?.passphrase ||
              (existing?.jumpHost?.host === jumpHostInput.host &&
                existing.jumpHost.port === jumpHostInput.port &&
                existing.jumpHost.hasSecret)
            )
          }
        : undefined,
      accessRoutes: routeInput,
      defaultAccessRouteId:
        input.defaultAccessRouteId ??
        existing?.defaultAccessRouteId ??
        routeInput?.[0]?.id,
      hasSecret: Boolean(input.password || input.passphrase || existingSecret),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    }

    if (
      input.password ||
      input.passphrase ||
      input.jumpHost?.password ||
      input.jumpHost?.passphrase
    ) {
      const oldSecrets = existingSecret ? this.getSecrets(id) : {}
      this.setSecrets(id, {
        ...oldSecrets,
        password: input.password || oldSecrets.password,
        passphrase: input.passphrase || oldSecrets.passphrase,
        jumpPassword: input.jumpHost?.password || oldSecrets.jumpPassword,
        jumpPassphrase: input.jumpHost?.passphrase || oldSecrets.jumpPassphrase
      })
      profile.hasSecret = true
    }

    if (existingIndex >= 0) data.servers[existingIndex] = profile
    else data.servers.push(profile)
    if (endpointChanged) {
      delete data.lastSnapshots[id]
      for (const key of Object.keys(data.gpuHistory)) {
        if (key.startsWith(`${id}::`)) delete data.gpuHistory[key]
      }
    }
    await this.persist()
    return structuredClone(profile)
  }

  async removeServer(id: string): Promise<void> {
    const data = this.ensureData()
    data.servers = data.servers.filter((item) => item.id !== id)
    delete data.secrets[id]
    delete data.lastSnapshots[id]
    data.settings.gpuWatches = data.settings.gpuWatches.filter((watch) => watch.serverId !== id)
    data.settings.serverOrder = data.settings.serverOrder.filter((serverId) => serverId !== id)
    for (const key of Object.keys(data.gpuHistory)) {
      if (key.startsWith(`${id}::`)) delete data.gpuHistory[key]
    }
    await this.persist()
  }

  /**
   * Consolidate a legacy duplicate (for example `gpu8-jump`) into the
   * canonical server record while keeping its resolved SSH route, including
   * the actual ProxyJump/ProxyCommand hop, intact.
   * The caller is expected to confirm this user-visible operation first.
   */
  async mergeAccessRoute(serverId: string, sourceServerId: string, resolvedJumpHost?: JumpHostConfig): Promise<ServerProfile> {
    if (serverId === sourceServerId) throw new Error('不能将服务器合并到自身')
    const data = this.ensureData()
    const baseIndex = data.servers.findIndex((item) => item.id === serverId)
    const sourceIndex = data.servers.findIndex((item) => item.id === sourceServerId)
    if (baseIndex < 0 || sourceIndex < 0) throw new Error('服务器不存在或已被删除')
    const base = data.servers[baseIndex]
    const source = data.servers[sourceIndex]
    const sourceRoute = getAccessRoutes(source).find((route) => route.kind === 'jump') ?? getAccessRoutes(source)[0]
    if (!sourceRoute) throw new Error('没有可合并的连接路径')
    const existingRoutes = getAccessRoutes(base)
    const existingJumpRoute = existingRoutes.find((route) => route.kind === 'jump')
    const routeWithSameTarget = existingRoutes.find((route) =>
      route.kind === 'jump' &&
      route.host === sourceRoute.host && route.port === sourceRoute.port && route.username === sourceRoute.username
    )
    const routeToReplace = routeWithSameTarget ?? existingJumpRoute
    const candidateJumpHost = resolvedJumpHost ?? sourceRoute.jumpHost ?? source.jumpHost
    const previousJumpHost = existingJumpRoute?.jumpHost ?? base.jumpHost
    const sameJumpHost = Boolean(
      previousJumpHost && candidateJumpHost &&
      previousJumpHost.host === candidateJumpHost.host &&
      previousJumpHost.port === candidateJumpHost.port &&
      previousJumpHost.username === candidateJumpHost.username
    )
    const mergedJumpHost = candidateJumpHost ? {
      ...candidateJumpHost,
      hostFingerprint: sameJumpHost ? previousJumpHost?.hostFingerprint : candidateJumpHost.hostFingerprint,
      hasSecret: sameJumpHost ? Boolean(previousJumpHost?.hasSecret || candidateJumpHost.hasSecret) : Boolean(candidateJumpHost.hasSecret)
    } : undefined
    let routeId = routeToReplace?.id ?? `jump-${source.id.slice(0, 8).toLowerCase()}`
    while (!routeToReplace && existingRoutes.some((route) => route.id === routeId)) routeId = `${routeId}-1`
    const mergedRoute: ServerAccessRoute = {
      ...sourceRoute,
      id: routeId,
      name: '跳板机',
      kind: 'jump',
      jumpHost: mergedJumpHost
    }
    const accessRoutes = routeToReplace
      ? existingRoutes.map((route) => route.id === routeToReplace.id ? mergedRoute : route)
      : [...existingRoutes, mergedRoute]
    const baseSecrets = data.secrets[base.id] ? this.getSecrets(base.id) : {}
    const sourceSecrets = data.secrets[source.id] ? this.getSecrets(source.id) : {}
    const mergedSecrets: ServerSecrets = {
      password: baseSecrets.password ?? sourceSecrets.password,
      passphrase: baseSecrets.passphrase ?? sourceSecrets.passphrase,
      jumpPassword: sourceSecrets.jumpPassword ?? (sameJumpHost ? baseSecrets.jumpPassword : undefined),
      jumpPassphrase: sourceSecrets.jumpPassphrase ?? (sameJumpHost ? baseSecrets.jumpPassphrase : undefined)
    }
    if (Object.values(mergedSecrets).some(Boolean)) this.setSecrets(base.id, mergedSecrets)
    else delete data.secrets[base.id]
    const mergedProfile: ServerProfile = {
      ...base,
      accessRoutes,
      defaultAccessRouteId: base.defaultAccessRouteId ?? 'direct',
      jumpHost: mergedRoute.jumpHost,
      hasSecret: Boolean(base.hasSecret || baseSecrets.password || baseSecrets.passphrase || sourceSecrets.password || sourceSecrets.passphrase),
      updatedAt: now()
    }
    data.servers[baseIndex] = mergedProfile
    data.servers.splice(sourceIndex, 1)
    delete data.secrets[source.id]
    delete data.lastSnapshots[source.id]
    data.settings.gpuWatches = data.settings.gpuWatches.filter((watch) => watch.serverId !== source.id)
    for (const key of Object.keys(data.gpuHistory)) {
      if (key.startsWith(`${source.id}::`)) delete data.gpuHistory[key]
    }
    await this.persist()
    return structuredClone(mergedProfile)
  }

  async mergeSshConfigJumpHost(serverId: string, inputJumpHost: NonNullable<ServerProfile['jumpHost']>, targetRouteId?: string): Promise<ServerProfile> {
    const data = this.ensureData()
    const index = data.servers.findIndex((item) => item.id === serverId)
    if (index < 0) throw new Error('服务器不存在或已被删除')
    const server = data.servers[index]
    const routes = getAccessRoutes(server)
    const directRoute = routes.find((route) => route.kind === 'direct') ?? routes[0]
    if (!directRoute) throw new Error('服务器没有可合并的目标连接路径')
    const existingJumpRoute = targetRouteId
      ? routes.find((route) => route.id === targetRouteId && route.kind === 'jump')
      : routes.find((route) => route.kind === 'jump')
    if (targetRouteId && !existingJumpRoute) throw new Error('要更新的 SSH 跳板路径不存在或已被修改')
    const previousJumpHost = existingJumpRoute?.jumpHost ?? server.jumpHost
    const sameJumpHost = Boolean(previousJumpHost && previousJumpHost.host === inputJumpHost.host && previousJumpHost.port === inputJumpHost.port && previousJumpHost.username === inputJumpHost.username)
    const jumpHost = {
      ...inputJumpHost,
      hostFingerprint: sameJumpHost ? previousJumpHost?.hostFingerprint : inputJumpHost.hostFingerprint,
      hasSecret: sameJumpHost ? Boolean(previousJumpHost?.hasSecret || inputJumpHost.hasSecret) : Boolean(inputJumpHost.hasSecret)
    }

    if (!sameJumpHost && data.secrets[serverId]) {
      const existingSecrets = this.getSecrets(serverId)
      const retainedSecrets: ServerSecrets = {
        password: existingSecrets.password,
        passphrase: existingSecrets.passphrase
      }
      if (Object.values(retainedSecrets).some(Boolean)) this.setSecrets(serverId, retainedSecrets)
      else delete data.secrets[serverId]
    }

    let routeId = existingJumpRoute?.id ?? 'ssh-config-jump'
    while (!existingJumpRoute && routes.some((route) => route.id === routeId)) routeId = `${routeId}-1`
    const mergedRoute: ServerAccessRoute = {
      ...(existingJumpRoute ?? directRoute),
      id: routeId,
      name: '跳板机',
      kind: 'jump',
      jumpHost
    }
    const mergedProfile: ServerProfile = {
      ...server,
      jumpHost,
      accessRoutes: [...routes.filter((route) => route.id !== existingJumpRoute?.id), mergedRoute],
      defaultAccessRouteId: server.defaultAccessRouteId ?? 'direct',
      updatedAt: now()
    }
    data.servers[index] = mergedProfile
    await this.persist()
    return structuredClone(mergedProfile)
  }

  async recordSnapshot(snapshot: ServerSnapshot, demo = false): Promise<void> {
    const data = this.ensureData()
    data.lastSnapshots[snapshot.serverId] = { ...snapshot, cached: false }
    if (!snapshot.gpus.length) {
      this.scheduleHistoryPersist()
      return
    }
    const sampledAtMs = Date.parse(snapshot.sampledAt)
    for (const gpu of snapshot.gpus) {
      const key = this.gpuHistoryKey(snapshot.serverId, gpu.uuid)
      let points = data.gpuHistory[key] ?? []
      if (demo && points.length === 0) {
        points = Array.from({ length: 288 }, (_, index) => {
          const minutesAgo = (288 - index) * 5
          const phase = index / 11 + gpu.index * 0.9
          const utilization = this.clamp(gpu.utilizationPercent + Math.sin(phase) * 22 + Math.sin(phase / 3) * 9, 0, 100)
          const memoryRatio = this.clamp(gpu.memoryUsedMiB / Math.max(1, gpu.memoryTotalMiB) + Math.sin(phase / 4) * 0.08, 0, 0.98)
          return {
            sampledAt: new Date(sampledAtMs - minutesAgo * 60_000).toISOString(),
            serverId: snapshot.serverId,
            gpuUuid: gpu.uuid,
            gpuIndex: gpu.index,
            utilizationPercent: Math.round(utilization * 10) / 10,
            memoryUsedMiB: Math.round(gpu.memoryTotalMiB * memoryRatio),
            memoryTotalMiB: gpu.memoryTotalMiB,
            temperatureC: Math.round(this.clamp(gpu.temperatureC + Math.sin(phase) * 6, 25, 92) * 10) / 10,
            powerW: gpu.powerW === null ? null : Math.round(Math.max(18, gpu.powerW + Math.sin(phase) * 48) * 10) / 10
          }
        })
      }
      const point: GpuHistoryPoint = {
        sampledAt: snapshot.sampledAt,
        serverId: snapshot.serverId,
        gpuUuid: gpu.uuid,
        gpuIndex: gpu.index,
        utilizationPercent: gpu.utilizationPercent,
        memoryUsedMiB: gpu.memoryUsedMiB,
        memoryTotalMiB: gpu.memoryTotalMiB,
        temperatureC: gpu.temperatureC,
        powerW: gpu.powerW
      }
      if (points.at(-1)?.sampledAt !== point.sampledAt) points.push(point)
      data.gpuHistory[key] = points.slice(-MAX_GPU_HISTORY_POINTS)
    }
    this.scheduleHistoryPersist()
  }

  getCachedSnapshots(): Record<string, ServerSnapshot> {
    return Object.fromEntries(
      Object.entries(this.ensureData().lastSnapshots).map(([serverId, snapshot]) => [
        serverId,
        { ...structuredClone(snapshot), cached: true }
      ])
    )
  }

  getGpuHistory(serverId: string, gpuUuid: string, range: GpuHistoryRange): GpuHistoryPoint[] {
    const rangeMs = range === '1h' ? 60 * 60_000 : range === '6h' ? 6 * 60 * 60_000 : 24 * 60 * 60_000
    const since = Date.now() - rangeMs
    return structuredClone(
      (this.ensureData().gpuHistory[this.gpuHistoryKey(serverId, gpuUuid)] ?? [])
        .filter((point) => Date.parse(point.sampledAt) >= since)
    )
  }

  async trustHost(
    id: string,
    fingerprint: string,
    target: 'server' | 'jumpHost' = 'server',
    accessRouteId?: string
  ): Promise<ServerProfile> {
    const data = this.ensureData()
    const index = data.servers.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('服务器不存在或已被删除')
    const current = data.servers[index]
    if (accessRouteId && current.accessRoutes?.length) {
      const routes = current.accessRoutes.map((route) => {
        if (route.id !== accessRouteId) return route
        if (target === 'jumpHost' && route.jumpHost) return { ...route, jumpHost: { ...route.jumpHost, hostFingerprint: fingerprint } }
        return { ...route, hostFingerprint: fingerprint }
      })
      data.servers[index] = { ...current, accessRoutes: routes, updatedAt: now() }
    } else data.servers[index] = target === 'jumpHost' && current.jumpHost
      ? {
          ...current,
          jumpHost: { ...current.jumpHost, hostFingerprint: fingerprint },
          updatedAt: now()
        }
      : { ...current, hostFingerprint: fingerprint, updatedAt: now() }
    await this.persist()
    return structuredClone(data.servers[index])
  }

  getSecrets(id: string): ServerSecrets {
    const encrypted = this.ensureData().secrets[id]
    if (!encrypted) return {}
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统无法解密凭据，请重新登录 Windows 后重试')
    }
    try {
      const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      return JSON.parse(plain) as ServerSecrets
    } catch {
      throw new Error('凭据解密失败，请编辑服务器并重新保存认证信息')
    }
  }

  getSettings(): AppSettings {
    return structuredClone(this.ensureData().settings)
  }

  async saveSettings(raw: AppSettings): Promise<AppSettings> {
    const settings = appSettingsSchema.parse(raw)
    this.ensureData().settings = settings
    await this.persist()
    return structuredClone(settings)
  }

  listExperimentTasks(): ExperimentTask[] {
    return structuredClone(this.ensureData().experimentTasks)
  }

  async saveExperimentTask(rawInput: ExperimentTaskDraft): Promise<ExperimentTask> {
    const input = experimentTaskDraftSchema.parse(rawInput)
    for (const [label, path] of [['代码目录', input.codePath], ['数据目录', input.dataPath], ['产物路径', input.artifactPath]] as const) {
      if (path && (!path.startsWith('/') || path.includes('\0'))) throw new Error(`${label}必须填写服务器上的绝对路径`)
    }
    const data = this.ensureData()
    const existingIndex = input.id
      ? data.experimentTasks.findIndex((task) => task.id === input.id)
      : -1
    if (input.id && existingIndex < 0) throw new Error('实验任务不存在或已被删除')
    const existing = existingIndex >= 0 ? data.experimentTasks[existingIndex] : undefined
    const server = input.serverId ? data.servers.find((item) => item.id === input.serverId) : undefined
    if (input.serverId && !server && existing?.serverId !== input.serverId) throw new Error('所选服务器不存在或已被删除')
    if (server && input.accessRouteId && !getAccessRoutes(server).some((route) => route.id === input.accessRouteId)) {
      throw new Error('任务所选连接路径已不存在，请重新选择')
    }
    const timestamp = now()
    const runs = structuredClone(existing?.runs ?? [])
    const activeRunIndex = runs.findIndex((run) => run.status === 'queued' || run.status === 'preparing' || run.status === 'running')
    if (activeRunIndex >= 0 && runs[activeRunIndex].status === 'queued') {
      runs[activeRunIndex] = {
        ...runs[activeRunIndex],
        serverId: input.serverId,
        serverNameSnapshot: server?.name ?? input.serverNameSnapshot,
        accessRouteId: input.accessRouteId,
        codePath: input.codePath,
        dataPath: input.dataPath,
        launchCommand: input.launchCommand,
        condaEnvironment: input.condaEnvironment ? structuredClone(input.condaEnvironment) : undefined,
        minimumFreeVramGiB: input.minimumFreeVramGiB,
        artifactPath: input.artifactPath,
        notes: input.notes
      }
    }
    const task: ExperimentTask = experimentTaskSchema.parse({
      ...input,
      id: existing?.id ?? randomUUID(),
      status: activeRunIndex >= 0 ? existing!.status : input.status,
      serverNameSnapshot: server?.name ?? input.serverNameSnapshot,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      archived: existing?.archived ?? false,
      runs
    })
    if (existingIndex >= 0) data.experimentTasks[existingIndex] = task
    else data.experimentTasks.unshift(task)
    await this.persist()
    return structuredClone(task)
  }

  async setExperimentTaskStatus(taskId: string, status: ExperimentTaskStatus): Promise<ExperimentTask> {
    status = experimentTaskStatusSchema.parse(status)
    const data = this.ensureData()
    const index = data.experimentTasks.findIndex((task) => task.id === taskId)
    if (index < 0) throw new Error('实验任务不存在或已被删除')
    if (status === 'running' || status === 'queued' || status === 'preparing') throw new Error('请通过“加入队列”创建一次自动运行')
    const task = data.experimentTasks[index]
    const activeRunIndex = task.runs.findIndex((run) => run.status === 'queued' || run.status === 'preparing' || run.status === 'running')
    const pausedOffset = [...task.runs].reverse().findIndex((run) => run.status === 'paused')
    const latestPausedIndex = pausedOffset < 0 ? -1 : task.runs.length - 1 - pausedOffset
    const targetRunIndex = activeRunIndex >= 0 ? activeRunIndex : task.status === 'paused' ? latestPausedIndex : -1
    if (targetRunIndex >= 0) {
      if (status === 'planned') throw new Error('请先记录或结束当前运行，再将任务设为待开始')
      if (task.runs[targetRunIndex].status === 'queued' || task.runs[targetRunIndex].status === 'preparing') {
        throw new Error('任务正在等待 GPU 或准备运行，请先移出队列')
      }
      if (status === 'paused') {
        if (activeRunIndex >= 0) task.runs[activeRunIndex] = { ...task.runs[activeRunIndex], status: 'paused' }
      } else if (status === 'completed' || status === 'cancelled') {
        task.runs[targetRunIndex] = { ...task.runs[targetRunIndex], status, finishedAt: now() }
      }
    }
    if (status === 'paused' && targetRunIndex < 0) throw new Error('没有可暂停的运行记录')
    task.status = status
    task.updatedAt = now()
    await this.persist()
    return structuredClone(task)
  }

  async startExperimentRun(taskId: string, rawInput: ExperimentRunStartInput): Promise<ExperimentTask> {
    const input = experimentRunStartInputSchema.parse(rawInput)
    const data = this.ensureData()
    const index = data.experimentTasks.findIndex((task) => task.id === taskId)
    if (index < 0) throw new Error('实验任务不存在或已被删除')
    const task = data.experimentTasks[index]
    if (task.archived) throw new Error('已归档的实验任务不能启动')
    const activeIndex = task.runs.findIndex((run) => run.status === 'queued' || run.status === 'preparing' || run.status === 'running')
    if (activeIndex >= 0) throw new Error('该任务已有正在运行的实验记录')
    for (const [label, path] of [['代码目录', input.codePath], ['数据目录', input.dataPath], ['产物路径', input.artifactPath]] as const) {
      if (path && (!path.startsWith('/') || path.includes('\0'))) throw new Error(`${label}必须填写服务器上的绝对路径`)
    }
    if (!input.serverId || !input.accessRouteId) throw new Error('开始记录前，请为本次运行选择服务器和连接路径')
    if (!task.serverId || input.serverId !== task.serverId) throw new Error('任务必须在其指定服务器内调度，请先编辑任务的目标服务器')
    const server = data.servers.find((item) => item.id === input.serverId)
    if (!server) throw new Error('本次运行所选服务器不存在或已被删除')
    if (server.mode !== 'real') throw new Error('演示服务器不能作为实验运行目标')
    if (!getAccessRoutes(server).some((route) => route.id === input.accessRouteId)) {
      throw new Error('本次运行所选连接路径已不存在，请重新选择')
    }
    if (input.condaEnvironment && Boolean(input.condaEnvironment.environmentName?.trim()) === Boolean(input.condaEnvironment.environmentPrefix?.trim())) {
      throw new Error('本次 Conda 环境必须填写环境名或环境前缀路径其中一项')
    }
    if (!input.codePath.trim() || !input.codePath.trim().startsWith('/')) throw new Error('自动运行需要填写服务器上的代码目录绝对路径')
    if (!input.launchCommand.trim()) throw new Error('自动运行需要填写启动命令')
    const queuedAt = now()
    const run: ExperimentRun = {
      id: randomUUID(),
      number: task.runs.reduce((maximum, item) => Math.max(maximum, item.number), 0) + 1,
      status: 'queued',
      queuedAt,
      serverId: input.serverId,
      serverNameSnapshot: server?.name,
      accessRouteId: input.accessRouteId,
      gpuUuid: undefined,
      gpuIndex: undefined,
      gpuNameSnapshot: undefined,
      codePath: input.codePath,
      dataPath: input.dataPath,
      launchCommand: input.launchCommand,
      condaEnvironment: input.condaEnvironment ? structuredClone(input.condaEnvironment) : undefined,
      minimumFreeVramGiB: input.minimumFreeVramGiB,
      artifactPath: input.artifactPath,
      message: '正在等待指定服务器上的空闲 GPU',
      resultSummary: '',
      notes: input.notes
    }
    task.runs.push(run)
    task.status = 'queued'
    task.updatedAt = queuedAt
    await this.persist()
    return structuredClone(task)
  }

  async updateExperimentRunState(
    taskId: string,
    runId: string,
    patch: Partial<Pick<ExperimentRun, 'status' | 'queuedAt' | 'startedAt' | 'finishedAt' | 'message' | 'gpuUuid' | 'gpuIndex' | 'gpuNameSnapshot' | 'minimumFreeVramGiB' | 'remotePid' | 'remoteRunDir' | 'logPath' | 'condaEnvironment'>>,
    expectedStatus?: ExperimentRun['status']
  ): Promise<ExperimentTask> {
    const data = this.ensureData()
    const task = data.experimentTasks.find((item) => item.id === taskId)
    if (!task) throw new Error('实验任务不存在或已被删除')
    const index = task.runs.findIndex((item) => item.id === runId)
    if (index < 0) throw new Error('实验运行记录不存在')
    const current = task.runs[index]
    if (expectedStatus && current.status !== expectedStatus) return structuredClone(task)
    const updated = { ...current, ...patch }
    task.runs[index] = updated
    const hasActiveRun = task.runs.some((item) => item.status === 'queued' || item.status === 'preparing' || item.status === 'running')
    if (patch.status && (current.status === 'queued' || current.status === 'preparing' || current.status === 'running' || !hasActiveRun)) {
      task.status = patch.status
    }
    task.updatedAt = now()
    await this.persist()
    return structuredClone(task)
  }

  async cancelQueuedExperimentRun(taskId: string, runId: string): Promise<ExperimentTask> {
    const task = this.ensureData().experimentTasks.find((item) => item.id === taskId)
    const run = task?.runs.find((item) => item.id === runId)
    if (!task || !run) throw new Error('实验运行记录不存在')
    if (run.status !== 'queued') throw new Error('任务已开始准备，当前不能移出队列')
    return this.updateExperimentRunState(taskId, runId, {
      status: 'cancelled',
      finishedAt: now(),
      message: '用户已将任务移出队列'
    })
  }

  async finishExperimentRun(taskId: string, runId: string, input: ExperimentRunFinishInput): Promise<ExperimentTask> {
    input = experimentRunFinishInputSchema.parse(input)
    const data = this.ensureData()
    const index = data.experimentTasks.findIndex((task) => task.id === taskId)
    if (index < 0) throw new Error('实验任务不存在或已被删除')
    const task = data.experimentTasks[index]
    const runIndex = task.runs.findIndex((run) => run.id === runId)
    if (runIndex < 0) throw new Error('实验运行记录不存在')
    const finishInput = {
      status: input.status,
      resultSummary: input.resultSummary.trim().slice(0, 4000),
      notes: input.notes.trim().slice(0, 8000),
      artifactPath: input.artifactPath.trim().slice(0, 4096)
    }
    if (finishInput.artifactPath && (!finishInput.artifactPath.startsWith('/') || finishInput.artifactPath.includes('\0'))) {
      throw new Error('日志/模型路径必须是服务器上的绝对路径')
    }
    const run = task.runs[runIndex]
    if (run.status !== 'running' && run.status !== 'paused') throw new Error('只有运行中或已暂停的记录可以手动结束')
    task.runs[runIndex] = {
      ...run,
      ...finishInput,
      ...(input.status === 'paused' ? {} : { finishedAt: now() })
    }
    if (run.status === 'running' || !task.runs.some((item) => item.status === 'queued' || item.status === 'preparing' || item.status === 'running')) {
      task.status = input.status === 'paused' ? 'paused' : input.status
    }
    task.resultSummary = finishInput.resultSummary
    task.artifactPath = finishInput.artifactPath || task.artifactPath
    task.updatedAt = now()
    await this.persist()
    return structuredClone(task)
  }

  async setExperimentTaskArchived(taskId: string, archived: boolean): Promise<ExperimentTask> {
    const data = this.ensureData()
    const index = data.experimentTasks.findIndex((task) => task.id === taskId)
    if (index < 0) throw new Error('实验任务不存在或已被删除')
    const task = data.experimentTasks[index]
    if (archived && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
      throw new Error('请先完成或取消任务，再归档')
    }
    task.archived = archived
    task.updatedAt = now()
    await this.persist()
    return structuredClone(task)
  }

  private setSecrets(id: string, secrets: ServerSecrets): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统不支持安全凭据存储，已拒绝保存密码')
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(secrets))
    this.ensureData().secrets[id] = encrypted.toString('base64')
  }

  private gpuHistoryKey(serverId: string, gpuUuid: string): string {
    return `${serverId}::${gpuUuid}`
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
  }

  private scheduleHistoryPersist(): void {
    if (this.historyPersistTimer) return
    this.historyPersistTimer = setTimeout(() => {
      this.historyPersistTimer = null
      void this.persist()
    }, 1000)
  }

  private ensureData(): PersistedData {
    if (!this.data) throw new Error('本地配置尚未初始化')
    return this.data
  }

  private async persist(): Promise<void> {
    const data = this.ensureData()
    this.persistQueue = this.persistQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, JSON.stringify(data), 'utf8')
    })
    await this.persistQueue
  }
}
