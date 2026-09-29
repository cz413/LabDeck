export type AuthType = 'password' | 'privateKey'
export type ServerMode = 'real' | 'demo'
export type ServerStatus = 'online' | 'offline' | 'warning' | 'unknown'
export type MonitorPolicy = 'manual' | 'onView' | 'background'
export type AppTheme = 'ocean' | 'instrument' | 'machineRoom'
export type CloseBehavior = 'ask' | 'tray' | 'exit'
export type AccessRouteKind = 'direct' | 'jump'

export interface JumpHostConfig {
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  hostFingerprint?: string
  hasSecret?: boolean
}

/**
 * A connection path to one physical server.  The target endpoint is kept on
 * the route so an internal address and a jump-host address can coexist under
 * one server record without duplicating monitoring/history data.
 */
export interface ServerAccessRoute {
  id: string
  name: string
  kind: AccessRouteKind
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  hostFingerprint?: string
  jumpHost?: JumpHostConfig
}

export interface ServerProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  hostFingerprint?: string
  tags: string[]
  group: string
  mode: ServerMode
  monitorPolicy: MonitorPolicy
  jumpHost?: JumpHostConfig
  accessRoutes?: ServerAccessRoute[]
  defaultAccessRouteId?: string
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

export interface ServerProfileInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKeyPath?: string
  passphrase?: string
  tags?: string[]
  group?: string
  mode?: ServerMode
  monitorPolicy?: MonitorPolicy
  jumpHost?: JumpHostConfig & { password?: string; passphrase?: string }
  accessRoutes?: ServerAccessRoute[]
  defaultAccessRouteId?: string
}

export interface FileSystemMetric {
  filesystem: string
  mountPoint: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usagePercent: number
}

export interface GpuMetric {
  index: number
  name: string
  uuid: string
  utilizationPercent: number
  memoryUsedMiB: number
  memoryTotalMiB: number
  temperatureC: number
  powerW: number | null
  powerLimitW: number | null
  fanPercent: number | null
  performanceState: string | null
  processes: GpuProcessMetric[]
}

export interface GpuProcessMetric {
  pid: number
  username: string
  processName: string
  memoryUsedMiB: number
  elapsedSeconds: number | null
}

export interface GpuWatchTarget {
  serverId: string
  gpuUuid?: string
}

export interface GpuAvailableEvent {
  serverId: string
  gpuUuid: string
  gpuIndex: number
}

export interface VsCodeRemoteResult {
  status: 'focused' | 'launched' | 'launching'
  message: string
}

export interface GpuHistoryPoint {
  sampledAt: string
  serverId: string
  gpuUuid: string
  gpuIndex: number
  utilizationPercent: number
  memoryUsedMiB: number
  memoryTotalMiB: number
  temperatureC: number
  powerW: number | null
}

export type GpuHistoryRange = '1h' | '6h' | '24h'

export interface ServerSnapshot {
  serverId: string
  sampledAt: string
  status: ServerStatus
  latencyMs: number | null
  uptimeSeconds: number | null
  loadAverage: [number, number, number] | null
  cpuUsagePercent: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
  fileSystems: FileSystemMetric[]
  gpus: GpuMetric[]
  cached?: boolean
  error?: string
}

export interface ConnectionTestResult {
  status: 'success' | 'failed' | 'host-key-required'
  latencyMs?: number
  fingerprint?: string
  hostKeyTarget?: 'server' | 'jumpHost'
  message: string
}

export interface TerminalConnectResult {
  status: 'connected' | 'failed' | 'host-key-required'
  sessionId?: string
  canAutofillPassword?: boolean
  fingerprint?: string
  hostKeyTarget?: 'server' | 'jumpHost'
  message?: string
}

export interface SshConfigCandidate {
  alias: string
  host: string
  port: number
  username: string
  identityFile?: string
  proxyJump?: string
  proxyCommand?: string
  alreadyImported: boolean
}

export interface SshConfigImportResult {
  imported: ServerProfile[]
  skipped: string[]
  configPath: string
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  code: number | null
  signal?: string
}

export interface SftpEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'link' | 'other'
  size: number
  modifiedAt: number
  permissions: number
}

export type SftpTransferDirection = 'upload' | 'download'
export type SftpTransferStatus = 'running' | 'completed' | 'failed'

export interface SftpTransferProgress {
  transferId: string
  direction: SftpTransferDirection
  fileName: string
  transferredBytes: number
  totalBytes: number
  status: SftpTransferStatus
  error?: string
}

export interface AppSettings {
  theme: AppTheme
  monitoringEnabled: boolean
  pollingIntervalSeconds: number
  maxConcurrentPolls: number
  minimizeToTray: boolean
  closeBehavior: CloseBehavior
  notifyOnWarning: boolean
  serverOrder: string[]
  gpuWatches: GpuWatchTarget[]
}

export type ExperimentTaskStatus = 'planned' | 'queued' | 'preparing' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type ExperimentPriority = 'low' | 'normal' | 'high'
export type ExperimentRunStatus = 'queued' | 'preparing' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type CondaManager = 'conda' | 'mamba' | 'micromamba'

export interface CondaEnvironmentConfig {
  manager: CondaManager
  managerPath?: string
  environmentName?: string
  environmentPrefix?: string
  environmentFilePath?: string
  pythonInterpreterPath?: string
  pythonVersion?: string
  lastCheckStatus?: 'found' | 'missing' | 'unknown'
  lastCheckedAt?: string
}

export interface ExperimentRun {
  id: string
  number: number
  status: ExperimentRunStatus
  queuedAt?: string
  startedAt?: string
  finishedAt?: string
  serverId?: string
  serverNameSnapshot?: string
  accessRouteId?: string
  gpuUuid?: string
  gpuIndex?: number
  gpuNameSnapshot?: string
  codePath?: string
  dataPath?: string
  launchCommand?: string
  condaEnvironment?: CondaEnvironmentConfig
  artifactPath?: string
  minimumFreeVramGiB?: number | null
  maximumGpuUtilizationPercent?: number | null
  message?: string
  remotePid?: number
  remoteRunDir?: string
  logPath?: string
  resultSummary: string
  notes: string
}

export interface ExperimentRunStartInput {
  serverId: string | null
  accessRouteId: string | null
  gpuUuid: string | null
  gpuIndex: number | null
  gpuNameSnapshot: string | null
  codePath: string
  dataPath: string
  launchCommand: string
  condaEnvironment: CondaEnvironmentConfig | null
  artifactPath: string
  minimumFreeVramGiB: number | null
  maximumGpuUtilizationPercent: number | null
  notes: string
}

export interface ExperimentTask {
  id: string
  title: string
  project: string
  objective: string
  tags: string[]
  priority: ExperimentPriority
  status: ExperimentTaskStatus
  serverId?: string
  serverNameSnapshot?: string
  accessRouteId?: string
  gpuUuid?: string
  gpuIndex?: number
  gpuNameSnapshot?: string
  codePath: string
  dataPath: string
  launchCommand: string
  condaEnvironment?: CondaEnvironmentConfig
  minimumFreeVramGiB?: number
  maximumGpuUtilizationPercent?: number
  artifactPath: string
  resultSummary: string
  notes: string
  archived: boolean
  createdAt: string
  updatedAt: string
  runs: ExperimentRun[]
}

export type ExperimentTaskDraft = Omit<ExperimentTask, 'id' | 'createdAt' | 'updatedAt' | 'archived' | 'runs'> & { id?: string }

export interface CondaEnvironmentInfo {
  name: string
  prefix: string
}

export interface CondaEnvironmentList {
  environments: CondaEnvironmentInfo[]
  managerPath: string
}

export interface CondaEnvironmentCheck {
  found: boolean
  name: string
  prefix: string
  managerPath?: string
  pythonInterpreterPath?: string
  pythonVersion?: string
}

export type RemoteCondaResult<T> =
  | { status: 'success'; value: T }
  | {
      status: 'host-key-required'
      fingerprint: string
      hostKeyTarget: 'server' | 'jumpHost'
      message: string
    }

export interface ExperimentRunFinishInput {
  status: Exclude<ExperimentRunStatus, 'queued' | 'preparing' | 'running'>
  resultSummary: string
  notes: string
  artifactPath: string
}

export interface AppApi {
  windowControls: {
    minimize(): void
    toggleMaximize(): Promise<boolean>
    close(): void
    resolveCloseAction(action: 'tray' | 'exit' | 'cancel', remember: boolean): Promise<AppSettings>
    onCloseRequested(listener: () => void): () => void
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  servers: {
    list(): Promise<ServerProfile[]>
    save(input: ServerProfileInput): Promise<ServerProfile>
    mergeAccessRoute(serverId: string, sourceServerId: string): Promise<ServerProfile>
    remove(id: string): Promise<void>
    test(id: string, accessRouteId?: string): Promise<ConnectionTestResult>
    trustHost(id: string, fingerprint: string, target?: 'server' | 'jumpHost', accessRouteId?: string): Promise<ServerProfile>
    choosePrivateKey(): Promise<string | null>
  }
  sshConfig: {
    importAll(): Promise<SshConfigImportResult>
  }
  monitor: {
    snapshot(id: string, accessRouteId?: string): Promise<ServerSnapshot>
    cachedSnapshots(): Promise<Record<string, ServerSnapshot>>
    gpuHistory(serverId: string, gpuUuid: string, range: GpuHistoryRange): Promise<GpuHistoryPoint[]>
  }
  terminal: {
    connect(serverId: string, cols: number, rows: number, accessRouteId?: string): Promise<TerminalConnectResult>
    connectLocal(cols: number, rows: number): Promise<TerminalConnectResult>
    write(sessionId: string, data: string): void
    autofillPassword(sessionId: string): Promise<boolean>
    resize(sessionId: string, cols: number, rows: number): void
    close(sessionId: string): void
    onData(listener: (event: TerminalDataEvent) => void): () => void
    onExit(listener: (event: TerminalExitEvent) => void): () => void
  }
  sftp: {
    openWindow(serverId: string, accessRouteId?: string, initialPath?: string): Promise<void>
    onNavigate(listener: (path: string) => void): () => void
    list(serverId: string, path: string, accessRouteId?: string): Promise<SftpEntry[]>
    chooseUploadFile(): Promise<string | null>
    upload(serverId: string, localPath: string, remotePath: string, transferId: string, accessRouteId?: string): Promise<void>
    download(serverId: string, remotePath: string, transferId: string, accessRouteId?: string): Promise<string | null>
    onProgress(listener: (event: SftpTransferProgress) => void): () => void
  }
  vscode: {
    openRemote(serverId: string, accessRouteId?: string, remotePath?: string): Promise<VsCodeRemoteResult>
  }
  experiments: {
    list(): Promise<ExperimentTask[]>
    save(input: ExperimentTaskDraft): Promise<ExperimentTask>
    setStatus(taskId: string, status: ExperimentTaskStatus): Promise<ExperimentTask>
    startRun(taskId: string, input: ExperimentRunStartInput): Promise<ExperimentTask>
    cancelQueuedRun(taskId: string, runId: string): Promise<ExperimentTask>
    cancelRun(taskId: string, runId: string): Promise<ExperimentTask>
    deleteQueuedRun(taskId: string, runId: string): Promise<ExperimentTask>
    deleteTask(taskId: string): Promise<void>
    finishRun(taskId: string, runId: string, input: ExperimentRunFinishInput): Promise<ExperimentTask>
    onChanged(listener: () => void): () => void
    setArchived(taskId: string, archived: boolean): Promise<ExperimentTask>
    listCondaEnvironments(serverId: string, accessRouteId: string, manager: CondaManager, managerPath?: string): Promise<RemoteCondaResult<CondaEnvironmentList>>
    checkCondaEnvironment(serverId: string, accessRouteId: string, config: CondaEnvironmentConfig): Promise<RemoteCondaResult<CondaEnvironmentCheck>>
    getCondaEnvironmentCommand(config: CondaEnvironmentConfig, updateExisting: boolean): Promise<{ command: string }>
  }
  settings: {
    get(): Promise<AppSettings>
    save(settings: AppSettings): Promise<AppSettings>
  }
  notifications: {
    onGpuAvailable(listener: (event: GpuAvailableEvent) => void): () => void
  }
}
