import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppSettings, GpuHistoryPoint, GpuHistoryRange, ServerAccessRoute, ServerProfile, ServerProfileInput, ServerSnapshot } from '../shared/types'
import { appSettingsSchema, serverProfileInputSchema } from '../shared/schemas'
import { getAccessRoutes } from '../shared/access-routes'

interface PersistedData {
  version: 3
  servers: ServerProfile[]
  secrets: Record<string, string>
  settings: AppSettings
  gpuHistory: Record<string, GpuHistoryPoint[]>
  lastSnapshots: Record<string, ServerSnapshot>
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
  pollingIntervalSeconds: 60,
  maxConcurrentPolls: 5,
  minimizeToTray: true,
  closeBehavior: 'ask',
  notifyOnWarning: true,
  gpuWatches: []
}

const now = (): string => new Date().toISOString()

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
      this.data = {
        version: 3,
        servers: Array.isArray(parsed.servers)
          ? parsed.servers.map((server) => ({
              ...server,
              monitorPolicy: server.monitorPolicy ?? (server.mode === 'demo' ? 'background' : 'manual')
            }))
          : [],
        secrets: parsed.secrets ?? {},
        settings: appSettingsSchema.parse({
          ...(persistedSettings ?? defaultSettings),
          closeBehavior: persistedSettings?.closeBehavior ?? (persistedSettings?.minimizeToTray === false ? 'exit' : 'ask')
        }),
        gpuHistory: parsed.gpuHistory ?? {},
        lastSnapshots: parsed.lastSnapshots ?? {}
      }
    } catch (error) {
      const isMissing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      if (!isMissing) {
        console.warn('配置读取失败，将使用新的本地配置：', error)
      }
      this.data = {
        version: 3,
        servers: demoServers(),
        secrets: {},
        settings: defaultSettings,
        gpuHistory: {},
        lastSnapshots: {}
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
    for (const key of Object.keys(data.gpuHistory)) {
      if (key.startsWith(`${id}::`)) delete data.gpuHistory[key]
    }
    await this.persist()
  }

  /**
   * Consolidate a legacy duplicate (for example `gpu8-jump`) into the
   * canonical server record while keeping its endpoint as another route.
   * The caller is expected to confirm this user-visible operation first.
   */
  async mergeAccessRoute(serverId: string, sourceServerId: string): Promise<ServerProfile> {
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
    const routeId = `jump-${source.id.slice(0, 8).toLowerCase()}`
    const mergedRoute: ServerAccessRoute = {
      ...sourceRoute,
      id: existingRoutes.some((route) => route.id === routeId) ? `${routeId}-${Date.now()}` : routeId,
      name: sourceRoute.kind === 'jump' ? '跳板机' : `${source.name} · 备用路径`,
      kind: 'jump'
    }
    const accessRoutes = [
      ...existingRoutes,
      ...(existingRoutes.some((route) => route.host === mergedRoute.host && route.port === mergedRoute.port && route.username === mergedRoute.username)
        ? []
        : [mergedRoute])
    ]
    const baseSecrets = data.secrets[base.id] ? this.getSecrets(base.id) : {}
    const sourceSecrets = data.secrets[source.id] ? this.getSecrets(source.id) : {}
    const mergedSecrets: ServerSecrets = {
      password: baseSecrets.password ?? sourceSecrets.password,
      passphrase: baseSecrets.passphrase ?? sourceSecrets.passphrase,
      jumpPassword: baseSecrets.jumpPassword ?? sourceSecrets.jumpPassword ?? sourceSecrets.password,
      jumpPassphrase: baseSecrets.jumpPassphrase ?? sourceSecrets.jumpPassphrase ?? sourceSecrets.passphrase
    }
    if (Object.values(mergedSecrets).some(Boolean)) this.setSecrets(base.id, mergedSecrets)
    const mergedProfile: ServerProfile = {
      ...base,
      accessRoutes,
      defaultAccessRouteId: base.defaultAccessRouteId ?? 'direct',
      jumpHost: base.jumpHost ?? mergedRoute.jumpHost,
      hasSecret: Boolean(base.hasSecret || source.hasSecret || Object.values(mergedSecrets).some(Boolean)),
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
