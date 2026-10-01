const now = new Date()
const iso = (minutesAgo = 0): string => new Date(now.getTime() - minutesAgo * 60_000).toISOString()
const mib = 1024 ** 2
const gib = 1024 ** 3
const tib = 1024 ** 4

const servers = [
  {
    id: 'demo-gpu-01', name: 'gpu8', host: '192.0.2.11', port: 22,
    username: 'researcher', authType: 'privateKey', tags: ['GPU', '训练'], group: '深度学习集群',
    mode: 'real', monitorPolicy: 'background', hasSecret: true, createdAt: iso(2000), updatedAt: iso(1)
  },
  {
    id: 'demo-gpu-02', name: 'gpu7', host: '192.0.2.12', port: 22,
    username: 'researcher', authType: 'privateKey', tags: ['GPU', '推理'], group: '深度学习集群',
    mode: 'real', monitorPolicy: 'background', hasSecret: true, createdAt: iso(1800), updatedAt: iso(2)
  },
  {
    id: 'demo-storage-01', name: 'Storage-01 · 演示节点', host: '192.0.2.13', port: 22,
    username: 'lab', authType: 'password', tags: ['存储'], group: '基础设施',
    mode: 'real', monitorPolicy: 'background', hasSecret: true, createdAt: iso(1600), updatedAt: iso(3)
  }
]

const makeGpu = (serverIndex: number, index: number, utilization: number) => {
  const memoryTotalMiB = 24_564
  const memoryUsedMiB = Math.round(memoryTotalMiB * utilization / 100)
  const processes = utilization > 10 ? [{
    pid: 18240 + index * 731 + serverIndex * 100,
    username: ['researcher', 'guest-a', 'guest-b', 'lab-user'][index],
    processName: index % 2 ? 'python inference.py' : 'python train.py',
    memoryUsedMiB: memoryUsedMiB,
    elapsedSeconds: 5400 + index * 1800
  }] : []
  return {
    index, name: 'NVIDIA RTX 4090', uuid: `GPU-DEMO-${serverIndex}-${index}`,
    utilizationPercent: utilization, memoryUsedMiB: processes.length ? memoryUsedMiB : 512,
    memoryTotalMiB, temperatureC: 42 + index * 4, powerW: 110 + utilization * 3,
    powerLimitW: 450, fanPercent: 38 + index * 3, performanceState: utilization > 10 ? 'P2' : 'P8', processes
  }
}

const snapshots = {
  'demo-gpu-01': {
    serverId: 'demo-gpu-01', sampledAt: iso(), status: 'online', latencyMs: 18, uptimeSeconds: 1_036_800,
    loadAverage: [3.2, 2.8, 2.5], cpuUsagePercent: 34, memoryUsedBytes: 164 * gib, memoryTotalBytes: 256 * gib,
    fileSystems: [
      { filesystem: '/dev/nvme0n1p2', mountPoint: '/', totalBytes: 2 * tib, usedBytes: 1.32 * tib, availableBytes: .68 * tib, usagePercent: 66 },
      { filesystem: '/dev/md0', mountPoint: '/data', totalBytes: 16 * tib, usedBytes: 9.1 * tib, availableBytes: 6.9 * tib, usagePercent: 57 }
    ],
    gpus: [makeGpu(1, 0, 71), makeGpu(1, 1, 54), makeGpu(1, 2, 28), makeGpu(1, 3, 4)]
  },
  'demo-gpu-02': {
    serverId: 'demo-gpu-02', sampledAt: iso(), status: 'online', latencyMs: 24, uptimeSeconds: 792_000,
    loadAverage: [1.7, 1.5, 1.2], cpuUsagePercent: 18, memoryUsedBytes: 92 * gib, memoryTotalBytes: 192 * gib,
    fileSystems: [
      { filesystem: '/dev/nvme0n1p2', mountPoint: '/', totalBytes: 1.5 * tib, usedBytes: .78 * tib, availableBytes: .72 * tib, usagePercent: 52 },
      { filesystem: '/dev/md1', mountPoint: '/models', totalBytes: 8 * tib, usedBytes: 4.2 * tib, availableBytes: 3.8 * tib, usagePercent: 53 }
    ],
    gpus: [makeGpu(2, 0, 38), makeGpu(2, 1, 9)]
  },
  'demo-storage-01': {
    serverId: 'demo-storage-01', sampledAt: iso(), status: 'warning', latencyMs: 31, uptimeSeconds: 2_764_800,
    loadAverage: [4.4, 4.1, 3.8], cpuUsagePercent: 27, memoryUsedBytes: 112 * gib, memoryTotalBytes: 128 * gib,
    fileSystems: [
      { filesystem: '/dev/sda2', mountPoint: '/', totalBytes: 1 * tib, usedBytes: .84 * tib, availableBytes: .16 * tib, usagePercent: 84 },
      { filesystem: '/dev/raid0', mountPoint: '/archive', totalBytes: 48 * tib, usedBytes: 37 * tib, availableBytes: 11 * tib, usagePercent: 77 }
    ],
    gpus: []
  }
}

const historyFor = (gpuIndex: number) => Array.from({ length: 36 }, (_, index) => {
  const utilizationPercent = Math.max(4, Math.min(93, 48 + Math.sin(index / 3.6) * 19 + Math.cos(index / 2.4) * 8 + gpuIndex * 4))
  const memoryTotalMiB = 24_564
  return {
    sampledAt: new Date(now.getTime() - (35 - index) * 10 * 60_000).toISOString(),
    serverId: 'demo-gpu-01', gpuUuid: `GPU-DEMO-1-${gpuIndex}`, gpuIndex,
    utilizationPercent, memoryUsedMiB: Math.round(memoryTotalMiB * utilizationPercent / 100),
    memoryTotalMiB, temperatureC: 42 + gpuIndex * 4, powerW: 110 + utilizationPercent * 3
  }
})

const noEvents = (): (() => void) => () => undefined
const taskBase = { project: '视觉语言模型', objective: '', tags: [], priority: 'normal',
  serverId: servers[0].id, accessRouteId: 'default', codePath: '/home/researcher/code/LISA',
  dataPath: '/data/datasets', launchCommand: 'python train.py --batch-size 4',
  artifactPath: '', resultSummary: '', notes: '', archived: false, createdAt: iso(120), updatedAt: iso(2) }
let tasks = ['running', 'queued', 'cancelled', 'failed'].map((status, index) => ({ ...taskBase,
  id: status, title: ['LISA 复现', '视觉指令微调', 'LISA 复现 · 已取消', '分割模型消融'][index], status,
  runs: [{ ...taskBase, id: `${status}-run`, number: 1, status, queuedAt: iso(90),
    startedAt: status === 'running' ? iso(80) : undefined, gpuIndex: status === 'running' ? 0 : undefined }]
}))
const preview = { terminalConnects: 0, terminalCloses: 0, startedRuns: [] as unknown[], sftpReads: [] as unknown[], offlineServers: [] as string[], cachedServers: [] as string[] }
Object.assign(window, { __labPreview: preview })
const taskListeners = new Set<() => void>()
const dataListeners = new Set<(event: { sessionId: string; data: string }) => void>()
const connect = async () => {
  const sessionId = `preview-${++preview.terminalConnects}`
  setTimeout(() => dataListeners.forEach((listener) => listener({ sessionId, data: '\r\nresearcher@gpu8:~$ ' })), 120)
  return { status: 'connected', sessionId }
}
const api = {
  windowControls: {
    minimize: () => undefined,
    toggleMaximize: async () => true,
    close: () => undefined,
    resolveCloseAction: async () => ({ action: 'tray' }),
    onCloseRequested: noEvents
  },
  clipboard: { readText: async () => '', writeText: async () => undefined },
  servers: {
    list: async () => structuredClone(servers), save: async () => servers[0],
    mergeAccessRoute: async () => undefined, remove: async () => undefined,
    test: async () => ({ status: 'success', latencyMs: 18, message: '连接成功' }),
    trustHost: async () => undefined, choosePrivateKey: async () => undefined
  },
  sshConfig: { importAll: async () => ({ imported: [], skipped: [], configPath: '' }) },
  monitor: {
    snapshot: async (id: string) => ({ ...structuredClone(snapshots[id as keyof typeof snapshots]),
      ...(preview.offlineServers.includes(id) ? { status: 'offline', error: '模拟连接失败' } : {}),
      ...(preview.cachedServers.includes(id) ? { cached: true } : {}) }),
    cachedSnapshots: async () => structuredClone(snapshots),
    gpuHistory: async (_serverId: string, gpuUuid: string) => historyFor(Number(gpuUuid.split('-').at(-1) ?? 0))
  },
  terminal: {
    connect, connectLocal: connect,
    write: () => undefined, autofillPassword: async () => false, resize: () => undefined,
    close: () => { preview.terminalCloses++ },
    onData: (listener: (event: { sessionId: string; data: string }) => void) => { dataListeners.add(listener); return () => { dataListeners.delete(listener) } }, onExit: noEvents
  },
  sftp: {
    openWindow: async () => undefined, onNavigate: noEvents,
    list: async (serverId: string, path: string) => {
      preview.sftpReads.push({ serverId, path })
      return [{ name: 'code', path: `${path}/code`, type: 'directory', size: 4096, modifiedAt: Date.parse(iso(30)), permissions: 493 },
        { name: 'train.py', path: `${path}/train.py`, type: 'file', size: 8912, modifiedAt: Date.parse(iso(60)), permissions: 420 }]
    }, chooseUploadFile: async () => undefined,
    upload: async () => undefined, download: async () => undefined, onProgress: noEvents
  },
  vscode: { openRemote: async () => ({ status: 'focused', message: '' }) },
  experiments: {
    list: async () => structuredClone(tasks),
    onChanged: (listener: () => void) => { taskListeners.add(listener); return () => { taskListeners.delete(listener) } },
    save: async (input: typeof taskBase & { id?: string; title: string; status: string }) => {
      const saved = { ...taskBase, ...input, id: input.id ?? 'new-task', runs: [] }
      tasks = [...tasks.filter((task) => task.id !== saved.id), saved]
      taskListeners.forEach((listener) => listener())
      return saved
    },
    startRun: async (id: string, input: unknown) => {
      preview.startedRuns.push(input)
      const task = tasks.find((item) => item.id === id)!
      task.status = 'queued'
      taskListeners.forEach((listener) => listener())
      return structuredClone(task)
    },
    deleteTask: async (id: string) => { tasks = tasks.filter((task) => task.id !== id); taskListeners.forEach((listener) => listener()) },
    setArchived: async (id: string, archived: boolean) => { const task = tasks.find((item) => item.id === id)!; task.archived = archived; return structuredClone(task) }
  },
  settings: {
    get: async () => ({ theme: new URLSearchParams(location.search).get('theme') ?? 'ocean', monitoringEnabled: true, pollingIntervalSeconds: 30, maxConcurrentPolls: 3, minimizeToTray: true, closeBehavior: 'ask', notifyOnWarning: true, serverOrder: [], gpuWatches: [] }),
    save: async (settings: unknown) => settings
  },
  notifications: { onGpuAvailable: noEvents }
}

Object.defineProperty(window, 'labApi', { value: api, configurable: false })
await import('/src/main.tsx')

const waitFor = async (selector: string): Promise<Element> => {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const element = document.querySelector(selector)
    if (element) return element
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`Screenshot state did not render: ${selector}`)
}

const clickNav = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.nav-button, .workbench-browser-links button')].find((item) => item.textContent?.includes(label))
  if (!button) throw new Error(`Navigation item not found: ${label}`)
  button.click()
  await new Promise((resolve) => setTimeout(resolve, 180))
}

await waitFor('.resource-workbench')
const view = new URLSearchParams(window.location.search).get('view') ?? 'dashboard'
if (view === 'servers') {
  await clickNav('全部服务器')
  await waitFor('.wb-all-server-table')
} else if (view === 'server-detail') {
  await waitFor('.resource-workbench')
} else if (view === 'gpu-overview' || view === 'gpu-detail') {
  await clickNav('GPU 总览')
  await waitFor('.wb-pool-table')
  if (view === 'gpu-detail') {
    document.querySelector<HTMLElement>('.wb-device-link')?.click()
    await waitFor('.wb-device-page')
  }
} else if (view === 'ssh' || view === 'ssh-picker') {
  await clickNav('终端')
  await waitFor('.server-terminal-workspace.visible')
  if (view === 'ssh-picker') {
    document.querySelector<HTMLButtonElement>('[aria-label="选择要连接的服务器"]')?.click()
    await waitFor('.ssh-server-picker')
  }
}
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
Object.defineProperty(window, '__captureReady', { value: true })
