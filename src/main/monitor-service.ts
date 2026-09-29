import type { FileSystemMetric, GpuMetric, GpuProcessMetric, ServerProfile, ServerSnapshot } from '../shared/types'
import type { Client } from 'ssh2'
import type { ServerSecrets } from './store'
import { SshService } from './ssh-service'

const METRICS_COMMAND = [
  "printf '__LAB_CPU__\\n'",
  "head -n 1 /proc/stat",
  "printf '__LAB_UPTIME__\\n'",
  "cat /proc/uptime",
  "printf '__LAB_LOAD__\\n'",
  "cat /proc/loadavg",
  "printf '__LAB_MEM__\\n'",
  "cat /proc/meminfo",
  "printf '__LAB_DF__\\n'",
  "df -Pk -x tmpfs -x devtmpfs 2>/dev/null",
  "printf '__LAB_GPU__\\n'",
  "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,pstate --format=csv,noheader,nounits; else printf '__NO_NVIDIA_SMI__\\n'; fi",
  "printf '__LAB_GPUPROCESSES__\\n'",
  "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null | while IFS=',' read -r gpu_uuid pid process_name used_memory; do clean_pid=$(printf '%s' \"$pid\" | tr -d ' '); process_user=$(ps -o user= -p \"$clean_pid\" 2>/dev/null | awk '{$1=$1};1'); process_elapsed=$(ps -o etimes= -p \"$clean_pid\" 2>/dev/null | tr -d ' '); printf '%s,%s,%s,%s,%s,%s\\n' \"$gpu_uuid\" \"$clean_pid\" \"$process_user\" \"$used_memory\" \"$process_elapsed\" \"$process_name\"; done; fi"
].join('; ')

interface CpuCounters {
  idle: number
  total: number
}

interface PooledMonitorConnection {
  key: string
  serverId: string
  client: Client
  lastUsedAt: number
  closed: boolean
}

const CONNECTION_SWEEP_INTERVAL_MS = 15_000
const MIN_CONNECTION_IDLE_MS = 90_000
const MAX_CONNECTION_IDLE_MS = 10 * 60_000

export class MonitorService {
  private readonly previousCpu = new Map<string, CpuCounters>()
  private readonly connections = new Map<string, PooledMonitorConnection>()
  private readonly pendingConnections = new Map<string, Promise<PooledMonitorConnection>>()
  private readonly inFlightSnapshots = new Map<string, Promise<ServerSnapshot>>()
  private readonly snapshotQueues = new Map<string, Promise<void>>()
  private readonly serverGenerations = new Map<string, number>()
  private readonly cleanupTimer: ReturnType<typeof setInterval>
  private idleConnectionTimeoutMs = MIN_CONNECTION_IDLE_MS
  private shuttingDown = false

  constructor(private readonly ssh: SshService) {
    this.cleanupTimer = setInterval(() => this.closeExpiredConnections(), CONNECTION_SWEEP_INTERVAL_MS)
    this.cleanupTimer.unref()
  }

  setPollingInterval(seconds: number): void {
    this.idleConnectionTimeoutMs = Math.max(
      MIN_CONNECTION_IDLE_MS,
      Math.min(MAX_CONNECTION_IDLE_MS, seconds * 2_000)
    )
    this.closeExpiredConnections()
  }

  invalidateServer(serverId: string): void {
    this.serverGenerations.set(serverId, (this.serverGenerations.get(serverId) ?? 0) + 1)
    for (const connection of this.connections.values()) {
      if (connection.serverId === serverId) this.retireConnection(connection)
    }
  }

  closeAll(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    clearInterval(this.cleanupTimer)
    for (const connection of this.connections.values()) this.retireConnection(connection)
  }

  snapshot(profile: ServerProfile, secrets: ServerSecrets): Promise<ServerSnapshot> {
    if (profile.mode === 'demo') return Promise.resolve(this.demoSnapshot(profile))
    const key = this.connectionKey(profile)
    const current = this.inFlightSnapshots.get(key)
    if (current) return current

    const request = this.enqueueSnapshot(profile.id, () => this.collectSnapshot(profile, secrets, key))
    this.inFlightSnapshots.set(key, request)
    void request.then(
      () => { if (this.inFlightSnapshots.get(key) === request) this.inFlightSnapshots.delete(key) },
      () => { if (this.inFlightSnapshots.get(key) === request) this.inFlightSnapshots.delete(key) }
    )
    return request
  }

  private async collectSnapshot(
    profile: ServerProfile,
    secrets: ServerSecrets,
    key: string
  ): Promise<ServerSnapshot> {
    const startedAt = Date.now()
    try {
      const raw = await this.executeMetricsCommand(profile, secrets, key)
      return this.parseSnapshot(profile.id, raw, Math.max(1, Date.now() - startedAt))
    } catch (error) {
      return {
        serverId: profile.id,
        sampledAt: new Date().toISOString(),
        status: 'offline',
        latencyMs: null,
        uptimeSeconds: null,
        loadAverage: null,
        cpuUsagePercent: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        fileSystems: [],
        gpus: [],
        error: error instanceof Error ? error.message : '监控采集失败'
      }
    }
  }

  private async executeMetricsCommand(profile: ServerProfile, secrets: ServerSecrets, key: string): Promise<string> {
    let connection = await this.getConnection(profile, secrets, key)
    try {
      const raw = await this.ssh.exec(connection.client, METRICS_COMMAND, 15000)
      connection.lastUsedAt = Date.now()
      return raw
    } catch (error) {
      if (!connection.closed || this.shuttingDown) throw error
      this.retireConnection(connection)
      connection = await this.getConnection(profile, secrets, key)
      const raw = await this.ssh.exec(connection.client, METRICS_COMMAND, 15000)
      connection.lastUsedAt = Date.now()
      return raw
    }
  }

  private getConnection(
    profile: ServerProfile,
    secrets: ServerSecrets,
    key: string
  ): Promise<PooledMonitorConnection> {
    if (this.shuttingDown) return Promise.reject(new Error('应用正在退出'))
    if (key !== this.connectionKey(profile)) {
      return Promise.reject(new Error('服务器连接配置已变更，请重新采集'))
    }
    const existing = this.connections.get(key)
    if (existing && !existing.closed) {
      existing.lastUsedAt = Date.now()
      return Promise.resolve(existing)
    }
    const pending = this.pendingConnections.get(key)
    if (pending) return pending

    const generation = this.serverGenerations.get(profile.id) ?? 0
    const connectionPromise = this.ssh.connect(profile, secrets).then(({ client }) => {
      if (this.shuttingDown || generation !== (this.serverGenerations.get(profile.id) ?? 0)) {
        client.end()
        throw new Error('服务器连接配置已变更，请重新采集')
      }

      const connection: PooledMonitorConnection = {
        key,
        serverId: profile.id,
        client,
        lastUsedAt: Date.now(),
        closed: false
      }
      client.once('close', () => this.retireConnection(connection, false))
      client.on('error', (error) => {
        console.warn(`监控 SSH 连接中断（${profile.name}）：`, error instanceof Error ? error.message : error)
        this.retireConnection(connection)
      })
      this.connections.set(key, connection)
      return connection
    }).finally(() => {
      this.pendingConnections.delete(key)
    })
    this.pendingConnections.set(key, connectionPromise)
    return connectionPromise
  }

  private connectionKey(profile: ServerProfile): string {
    const jump = profile.jumpHost
    return JSON.stringify([
      profile.id,
      this.serverGenerations.get(profile.id) ?? 0,
      profile.host,
      profile.port,
      profile.username,
      profile.authType,
      profile.privateKeyPath ?? '',
      profile.hostFingerprint ?? '',
      jump ? [
        jump.host,
        jump.port,
        jump.username,
        jump.authType,
        jump.privateKeyPath ?? '',
        jump.hostFingerprint ?? ''
      ] : null
    ])
  }

  private enqueueSnapshot<T>(serverId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.snapshotQueues.get(serverId)
    const request = previous ? previous.then(run, run) : run()
    const queueTail = request.then(() => undefined, () => undefined)
    this.snapshotQueues.set(serverId, queueTail)
    void queueTail.then(() => {
      if (this.snapshotQueues.get(serverId) === queueTail) this.snapshotQueues.delete(serverId)
    })
    return request
  }

  private closeExpiredConnections(): void {
    const now = Date.now()
    for (const connection of this.connections.values()) {
      if (now - connection.lastUsedAt >= this.idleConnectionTimeoutMs) this.retireConnection(connection)
    }
  }

  private retireConnection(connection: PooledMonitorConnection, closeClient = true): void {
    if (connection.closed) return
    connection.closed = true
    if (this.connections.get(connection.key) === connection) this.connections.delete(connection.key)
    if (closeClient) connection.client.end()
  }

  private parseSnapshot(serverId: string, raw: string, latencyMs: number): ServerSnapshot {
    const sections = this.sections(raw)
    const cpuCounters = this.parseCpu(sections.get('CPU') ?? '')
    const previous = this.previousCpu.get(serverId)
    this.previousCpu.set(serverId, cpuCounters)
    let cpuUsagePercent: number | null = null
    if (previous) {
      const totalDelta = cpuCounters.total - previous.total
      const idleDelta = cpuCounters.idle - previous.idle
      if (totalDelta > 0) cpuUsagePercent = this.round(((totalDelta - idleDelta) / totalDelta) * 100)
    }

    const memory = this.parseMemory(sections.get('MEM') ?? '')
    const fileSystems = this.parseFileSystems(sections.get('DF') ?? '')
    const gpuProcesses = this.parseGpuProcesses(sections.get('GPUPROCESSES') ?? '')
    const gpus = this.parseGpus(sections.get('GPU') ?? '', gpuProcesses)
    const uptimeSeconds = Number.parseFloat((sections.get('UPTIME') ?? '').trim().split(/\s+/)[0])
    const loadParts = (sections.get('LOAD') ?? '').trim().split(/\s+/).slice(0, 3).map(Number)
    const warning =
      fileSystems.some((item) => item.usagePercent >= 80) ||
      gpus.some((item) => item.temperatureC >= 80)

    return {
      serverId,
      sampledAt: new Date().toISOString(),
      status: warning ? 'warning' : 'online',
      latencyMs,
      uptimeSeconds: Number.isFinite(uptimeSeconds) ? uptimeSeconds : null,
      loadAverage:
        loadParts.length === 3 && loadParts.every(Number.isFinite)
          ? (loadParts as [number, number, number])
          : null,
      cpuUsagePercent,
      memoryUsedBytes: memory.used,
      memoryTotalBytes: memory.total,
      fileSystems,
      gpus
    }
  }

  private sections(raw: string): Map<string, string> {
    const result = new Map<string, string>()
    const matches = [...raw.matchAll(/^__LAB_([A-Z]+)__$/gm)]
    matches.forEach((match, index) => {
      const start = (match.index ?? 0) + match[0].length
      const end = matches[index + 1]?.index ?? raw.length
      result.set(match[1], raw.slice(start, end).trim())
    })
    return result
  }

  private parseCpu(raw: string): CpuCounters {
    const values = raw.trim().split(/\s+/).slice(1).map(Number)
    const idle = (values[3] ?? 0) + (values[4] ?? 0)
    return { idle, total: values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) }
  }

  private parseMemory(raw: string): { total: number | null; used: number | null } {
    const values = new Map<string, number>()
    for (const line of raw.split('\n')) {
      const match = line.match(/^(\w+):\s+(\d+)/)
      if (match) values.set(match[1], Number(match[2]) * 1024)
    }
    const total = values.get('MemTotal')
    const available = values.get('MemAvailable')
    return {
      total: total ?? null,
      used: total !== undefined && available !== undefined ? total - available : null
    }
  }

  private parseFileSystems(raw: string): FileSystemMetric[] {
    return raw
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 6)
      .map((parts) => ({
        filesystem: parts[0],
        totalBytes: Number(parts[1]) * 1024,
        usedBytes: Number(parts[2]) * 1024,
        availableBytes: Number(parts[3]) * 1024,
        usagePercent: Number.parseFloat(parts[4]),
        mountPoint: parts.slice(5).join(' ')
      }))
      .filter((item) => Number.isFinite(item.totalBytes) && Number.isFinite(item.usagePercent))
  }

  private parseGpus(raw: string, processes: Map<string, GpuProcessMetric[]>): GpuMetric[] {
    if (!raw || raw.includes('__NO_NVIDIA_SMI__')) return []
    return raw
      .split('\n')
      .map((line) => line.split(',').map((value) => value.trim()))
      .filter((parts) => parts.length >= 11)
      .map((parts) => ({
        index: Number(parts[0]),
        name: parts[1],
        uuid: parts[2],
        utilizationPercent: this.numberOrZero(parts[3]),
        memoryUsedMiB: this.numberOrZero(parts[4]),
        memoryTotalMiB: this.numberOrZero(parts[5]),
        temperatureC: this.numberOrZero(parts[6]),
        powerW: this.numberOrNull(parts[7]),
        powerLimitW: this.numberOrNull(parts[8]),
        fanPercent: this.numberOrNull(parts[9]),
        performanceState: parts[10] && parts[10] !== 'N/A' ? parts[10] : null,
        processes: processes.get(parts[2]) ?? []
      }))
  }

  private parseGpuProcesses(raw: string): Map<string, GpuProcessMetric[]> {
    const result = new Map<string, GpuProcessMetric[]>()
    for (const line of raw.split('\n')) {
      const parts = line.split(',').map((value) => value.trim())
      if (parts.length < 5) continue
      const pid = Number.parseInt(parts[1], 10)
      if (!Number.isFinite(pid)) continue
      const parsedElapsed = Number.parseInt(parts[4], 10)
      const hasElapsedField = parts.length >= 6
      const process: GpuProcessMetric = {
        pid,
        username: parts[2] || '未知',
        memoryUsedMiB: this.numberOrZero(parts[3]),
        elapsedSeconds: hasElapsedField && Number.isFinite(parsedElapsed) ? parsedElapsed : null,
        processName: parts.slice(hasElapsedField ? 5 : 4).join(',') || '未知进程'
      }
      const current = result.get(parts[0]) ?? []
      current.push(process)
      result.set(parts[0], current)
    }
    return result
  }

  private demoSnapshot(profile: ServerProfile): ServerSnapshot {
    const tick = Date.now() / 10000
    const offset = [...profile.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 30
    const wave = (base: number, spread: number, phase: number): number =>
      this.round(base + Math.sin(tick + phase) * spread)
    const isStorage = profile.tags.includes('存储')
    const diskUsage = isStorage ? 86 : wave(58, 7, offset)
    const gpuUtil = wave(72, 20, offset / 7)
    const temperature = wave(68, 7, offset / 11)
    const gpuCount = profile.name.includes('GPU-01') ? 4 : 2

    return {
      serverId: profile.id,
      sampledAt: new Date().toISOString(),
      status: diskUsage >= 80 ? 'warning' : 'online',
      latencyMs: 12 + (offset % 17),
      uptimeSeconds: 1_246_800 + offset * 3600,
      loadAverage: [2.31, 2.12, 1.98],
      cpuUsagePercent: wave(isStorage ? 18 : 42, 12, offset),
      memoryUsedBytes: (isStorage ? 92 : 157) * 1024 ** 3,
      memoryTotalBytes: (isStorage ? 128 : 256) * 1024 ** 3,
      fileSystems: [
        {
          filesystem: '/dev/nvme0n1p2',
          mountPoint: '/',
          totalBytes: 1.8 * 1024 ** 4,
          usedBytes: (diskUsage / 100) * 1.8 * 1024 ** 4,
          availableBytes: ((100 - diskUsage) / 100) * 1.8 * 1024 ** 4,
          usagePercent: diskUsage
        }
      ],
      gpus: isStorage
        ? []
        : Array.from({ length: gpuCount }, (_, index) => {
            const utilization = index === gpuCount - 1 ? wave(3, 2, index) : this.round(Math.max(0, gpuUtil - index * 13))
            const processes: GpuProcessMetric[] = utilization < 8
              ? []
              : [{
                  pid: 18240 + index * 731,
                  username: ['chen', 'li', 'wang'][index % 3],
                  processName: index % 2 === 0 ? 'python train.py' : 'python inference.py',
                  memoryUsedMiB: Math.round((utilization / 100) * 18000),
                  elapsedSeconds: 5400 + index * 3270 + offset * 60
                }]
            return {
              index,
              name: 'NVIDIA RTX 4090',
              uuid: `GPU-DEMO-${profile.id.slice(0, 8)}-${index}`,
              utilizationPercent: utilization,
              memoryUsedMiB: processes.reduce((sum, item) => sum + item.memoryUsedMiB, 0),
              memoryTotalMiB: 24564,
              temperatureC: index === gpuCount - 1 ? 38 : this.round(temperature - index * 2),
              powerW: index === gpuCount - 1 ? 28 : this.round(wave(315, 34, offset / 4) - index * 23),
              powerLimitW: 450,
              fanPercent: index === gpuCount - 1 ? 30 : this.round(62 - index * 5),
              performanceState: index === gpuCount - 1 ? 'P8' : 'P2',
              processes
            }
          })
    }
  }

  private numberOrZero(value: string): number {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  private numberOrNull(value: string): number | null {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  private round(value: number): number {
    return Math.round(value * 10) / 10
  }
}
