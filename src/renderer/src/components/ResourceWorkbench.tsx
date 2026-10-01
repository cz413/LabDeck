import { useEffect, useState } from 'react'
import { Bell, Code2, FolderOpen, MoreHorizontal, Play, Plus, RefreshCw, SquareTerminal } from 'lucide-react'
import type { ExperimentTask, GpuHistoryPoint, GpuHistoryRange, GpuMetric, GpuWatchTarget, ServerProfile, ServerSnapshot } from '@shared/types'
import { getAccessRoute } from '@shared/access-routes'
import { gpuLoadState, isGpuBusy } from '@shared/gpu-status'
import { AccessRouteSelect } from './AccessRouteSelect'
import { GpuHistoryChart } from './GpuHistoryChart'

interface ResourceWorkbenchProps {
  server: ServerProfile
  snapshot?: ServerSnapshot
  tasks: ExperimentTask[]
  watches: GpuWatchTarget[]
  accessRouteId: string
  initialGpuIndex?: number
  refreshing: boolean
  testing: boolean
  vscodeConnecting: boolean
  onAccessRouteChange(id: string): void
  onRefresh(): void
  onTerminal(): void
  onFiles(path?: string): void
  onVsCode(): void
  onEdit(): void
  onTest(): void
  onRemove(): void
  onMerge(): void
  onTask(task?: ExperimentTask): void
  onNewTask(gpu?: GpuMetric): void
  onGpuDetail(index: number): void
  onToggleWatch(uuid: string): void
}

const stateNames = { planned: '待开始', queued: '等待 GPU', preparing: '准备运行', running: '运行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' }
const gb = (value: number | null | undefined) => value == null ? '—' : `${(value / 1024 ** 3).toFixed(0)} GB`
const pct = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value)}%`
const elapsed = (startedAt?: string) => {
  if (!startedAt) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':')
}

export function ResourceWorkbench(props: ResourceWorkbenchProps): React.JSX.Element {
  const { server, snapshot } = props
  const [tab, setTab] = useState<'gpu' | 'tasks' | 'connection' | 'history'>('gpu')
  const [selectedUuid, setSelectedUuid] = useState<string | null>(() => props.snapshot?.gpus.find(gpu => gpu.index === props.initialGpuIndex)?.uuid ?? null)
  const [onlyAvailable, setOnlyAvailable] = useState(false)
  const [historyRange, setHistoryRange] = useState<GpuHistoryRange>('6h')
  const [history, setHistory] = useState<GpuHistoryPoint[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const gpus = snapshot?.gpus ?? []
  const route = getAccessRoute(server, props.accessRouteId)
  const tasks = props.tasks.filter((task) => !task.archived && (task.serverId === server.id || task.runs.some((run) => ['queued', 'preparing', 'running'].includes(run.status) && run.serverId === server.id)))
    .sort((a, b) => Number(['queued', 'preparing', 'running'].includes(b.status)) - Number(['queued', 'preparing', 'running'].includes(a.status)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const status = snapshot?.cached ? '上次采集' : snapshot?.status === 'offline' ? '离线' : snapshot?.status === 'warning' ? '需关注' : snapshot?.status === 'online' ? '在线' : '未采集'
  const live = !!snapshot && !snapshot.cached && snapshot.status !== 'offline' && snapshot.status !== 'unknown'
  const visibleGpus = gpus.filter((gpu) => !onlyAvailable || (live && !isGpuBusy(gpu)))
  const selectedGpu = visibleGpus.find((gpu) => gpu.uuid === selectedUuid) ?? visibleGpus.find((gpu) => !isGpuBusy(gpu)) ?? visibleGpus[0]
  const canRun = server.mode === 'real' && live
  const primaryDisk = snapshot?.fileSystems.find(disk => disk.mountPoint === '/') ?? snapshot?.fileSystems[0]
  const memoryPercent = snapshot?.memoryTotalBytes ? (snapshot.memoryUsedBytes ?? 0) / snapshot.memoryTotalBytes * 100 : 0
  const busyCount = gpus.filter(isGpuBusy).length

  useEffect(() => {
    if (tab !== 'history' || !selectedGpu) return
    let active = true
    setHistoryLoading(true)
    setHistoryError('')
    setHistory([])
    void window.labApi.monitor.gpuHistory(server.id, selectedGpu.uuid, historyRange)
      .then((points) => { if (active) setHistory(points) })
      .catch((error: unknown) => { if (active) setHistoryError(error instanceof Error ? error.message : '读取历史失败') })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [tab, server.id, selectedGpu?.uuid, historyRange, snapshot?.sampledAt])

  const queue = <section className="wb-queue">
    <header className="wb-section-heading"><h3>实验队列 <small>{tasks.length}</small></h3><button className="secondary-button" onClick={() => props.onNewTask()}><Plus size={14} />新建任务</button></header>
    {tasks.length ? <div className="wb-table-scroll"><table className="wb-table wb-task-table"><thead><tr><th>任务名称</th><th>状态</th><th>GPU</th><th>运行时间</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{(tab === 'tasks' ? tasks : tasks.slice(0, 4)).map((task) => {
      const run = task.runs.find((item) => ['queued', 'preparing', 'running'].includes(item.status)) ?? task.runs.at(-1)
      return <tr key={task.id}><td><button className="wb-text-button" onClick={() => props.onTask(task)}>{task.title}</button></td><td><span className={`wb-state ${task.status}`}><i />{stateNames[task.status]}</span></td><td>{run?.gpuIndex != null ? `GPU ${run.gpuIndex}` : '自动分配'}</td><td className="wb-numeric">{run?.status === 'running' ? elapsed(run.startedAt) : '—'}</td><td><button className="icon-button small" aria-label={`查看任务 ${task.title}`} onClick={() => props.onTask(task)}><MoreHorizontal size={16} /></button></td></tr>
    })}</tbody></table></div> : <div className="wb-empty-inline">这台服务器还没有实验任务。新建任务后可加入队列。</div>}
    {tasks.length > 4 && tab !== 'tasks' && <button className="wb-text-button wb-see-all" onClick={() => setTab('tasks')}>查看全部 {tasks.length} 个任务</button>}
  </section>

  return <section className="resource-workbench">
    <header className="wb-server-heading">
      <div className="wb-server-identity"><div><h1>{server.name}</h1><span className={`wb-server-state ${snapshot?.cached ? 'cached' : snapshot?.status ?? 'unknown'}`}><i />{status}</span>{server.mode === 'demo' && <small>演示</small>}</div><p>{route.username}@{route.host}:{route.port}</p></div>
      <div className="wb-host-connection">
        <AccessRouteSelect server={server} value={props.accessRouteId} onChange={props.onAccessRouteChange} label="连接方式" showSingleRoute />
        {route.kind === 'jump' && route.jumpHost && <small title={`${route.jumpHost.username}@${route.jumpHost.host}:${route.jumpHost.port}`}>经 {route.jumpHost.host}:{route.jumpHost.port}</small>}
      </div>
      <div className="wb-host-metrics"><span>延迟 <strong>{snapshot?.latencyMs == null ? '—' : `${snapshot.latencyMs} ms`}</strong></span><span>运行 <strong>{snapshot?.uptimeSeconds == null ? '—' : `${Math.floor(snapshot.uptimeSeconds / 86400)} 天`}</strong></span></div>
      <div className="wb-host-actions"><button className="secondary-button" onClick={props.onTerminal}><SquareTerminal size={14} />连接终端</button><button className="secondary-button" onClick={() => props.onFiles()}><FolderOpen size={14} />打开文件</button><button className="secondary-button" onClick={props.onVsCode} disabled={props.vscodeConnecting}><Code2 size={14} />{props.vscodeConnecting ? '连接中…' : 'VS Code'}</button></div>
    </header>
    <section className="wb-host-summary" aria-label="服务器资源摘要"><div><span>CPU</span><strong>{pct(snapshot?.cpuUsagePercent)}</strong><i><b style={{ width: `${snapshot?.cpuUsagePercent ?? 0}%` }} /></i><small>负载 {snapshot?.loadAverage?.map(value => value.toFixed(2)).join(' / ') ?? '—'}</small></div><div><span>内存</span><strong>{gb(snapshot?.memoryUsedBytes)}<em>/ {gb(snapshot?.memoryTotalBytes)}</em></strong><i><b style={{ width: `${Math.min(100, memoryPercent)}%` }} /></i><small>{Math.round(memoryPercent)}% 已用</small></div><div><span>GPU 资源</span><strong>{live ? gpus.length - busyCount : '—'}<em>空闲 / {gpus.length} 张</em></strong><i><b style={{ width: `${gpus.length ? busyCount / gpus.length * 100 : 0}%` }} /></i><small>{live ? `${busyCount} 张使用中` : '等待实时状态确认'}</small></div><div><span>系统存储</span><strong>{pct(primaryDisk?.usagePercent)}</strong><i><b style={{ width: `${primaryDisk?.usagePercent ?? 0}%` }} /></i><small>{primaryDisk ? `${primaryDisk.mountPoint} · 可用 ${gb(primaryDisk.availableBytes)}` : '尚无存储数据'}</small></div></section>
    <nav className="wb-tabs" aria-label="服务器工作区" role="tablist">{([['gpu', 'GPU'], ['tasks', '任务'], ['connection', '连接与存储'], ['history', '历史']] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}<button className="wb-refresh" onClick={props.onRefresh} disabled={props.refreshing} aria-label="刷新当前服务器"><RefreshCw size={14} className={props.refreshing ? 'spin' : ''} /></button></nav>
    {snapshot?.cached && <div className="wb-notice">当前显示上次采集结果（{new Date(snapshot.sampledAt).toLocaleString('zh-CN')}），刷新后确认可用资源。</div>}
    {snapshot?.status === 'offline' && <div className="wb-notice error">连接失败：{snapshot.error ?? '检查网络和 SSH 连接路径后刷新。'}</div>}
    {tab === 'gpu' && <>
      <section className="wb-gpu-section">
        <header className="wb-section-heading"><h2>{gpus.length} 张 GPU</h2><label className="wb-checkbox"><input type="checkbox" checked={onlyAvailable} onChange={(event) => setOnlyAvailable(event.target.checked)} />只看可用</label><span className="wb-section-hint">{snapshot ? `采集于 ${new Date(snapshot.sampledAt).toLocaleTimeString('zh-CN')}` : '尚未采集'}</span></header>
        {gpus.length ? <div className="wb-table-scroll"><table className="wb-table wb-gpu-table"><thead><tr><th>GPU / 设备详情</th><th>显存</th><th>利用率</th><th>温度</th><th>进程</th></tr></thead><tbody>{visibleGpus.map((gpu) => <tr key={gpu.uuid} className={selectedGpu?.uuid === gpu.uuid ? 'selected' : ''} onClick={() => setSelectedUuid(gpu.uuid)}>
          <td><button className="wb-gpu-select" aria-label={`查看 GPU ${gpu.index} 详情`} onClick={() => props.onGpuDetail(gpu.index)}><span>{gpu.index}</span><strong>{gpu.name.replace(/^NVIDIA\s+/, '')}</strong></button></td>
          <td className="wb-numeric">{(gpu.memoryUsedMiB / 1024).toFixed(1)} / {(gpu.memoryTotalMiB / 1024).toFixed(0)} GB</td>
          <td><div className="wb-utilization"><i><b style={{ width: `${Math.max(0, Math.min(100, gpu.utilizationPercent))}%` }} /></i><span>{Math.round(gpu.utilizationPercent)}%</span></div></td>
          <td className={gpu.temperatureC >= 80 ? 'wb-warning' : ''}>{Math.round(gpu.temperatureC)} °C</td>
          <td className="wb-process-cell">{gpu.processes.length ? <span title={gpu.processes.map((process) => `${process.username}: ${process.processName}`).join('\n')}>{gpu.processes[0].username} · {gpu.processes[0].processName}{gpu.processes.length > 1 ? ` +${gpu.processes.length - 1}` : ''}</span> : <span className="wb-muted">{live ? '可用' : '无进程记录'}</span>}</td>
        </tr>)}</tbody></table>{onlyAvailable && !gpus.some((gpu) => live && !isGpuBusy(gpu)) && <div className="wb-empty-inline">当前没有已确认可用的 GPU。</div>}</div> : <div className="wb-empty-inline">{snapshot ? '没有检测到 NVIDIA GPU，可在“连接与存储”中查看其他资源。' : '还没有监控数据。点击刷新采集当前服务器。'}</div>}
      </section>
      <div className="wb-context-grid">{queue}<aside className="wb-gpu-inspector">
        {selectedGpu ? <><h3>GPU {selectedGpu.index}</h3><p className="wb-free-memory">空闲显存 <strong>{(Math.max(0, selectedGpu.memoryTotalMiB - selectedGpu.memoryUsedMiB) / 1024).toFixed(1)} GB</strong></p><p>{!live ? '等待实时采样确认' : gpuLoadState(selectedGpu) === 'warning' ? '温度较高，请检查散热' : isGpuBusy(selectedGpu) ? `${selectedGpu.processes.length} 个计算进程，当前使用中` : '当前无繁忙计算进程'}</p><button className="secondary-button" disabled={!canRun} title={!canRun ? '需要真实服务器和实时监控数据' : undefined} onClick={() => props.onNewTask(selectedGpu)}><Play size={13} />在此 GPU 运行任务</button><div className="wb-inspector-links"><button className="wb-text-button" onClick={() => props.onGpuDetail(selectedGpu.index)}>进程与设备详情</button><button className={`wb-text-button ${props.watches.some((watch) => watch.serverId === server.id && watch.gpuUuid === selectedGpu.uuid) ? 'active' : ''}`} onClick={() => props.onToggleWatch(selectedGpu.uuid)}><Bell size={12} />{props.watches.some((watch) => watch.serverId === server.id && watch.gpuUuid === selectedGpu.uuid) ? '取消空闲通知' : '空闲通知'}</button></div></> : <><h3>资源详情</h3><p>选择 GPU 后查看显存、计算进程和操作。</p></>}
      </aside></div>
      {!!snapshot?.fileSystems.length && <section className="wb-storage-summary"><header><h3>存储挂载</h3><button className="wb-text-button" onClick={() => setTab('connection')}>连接与存储详情</button></header><div>{snapshot.fileSystems.map(disk => <button key={`${disk.filesystem}:${disk.mountPoint}`} onClick={() => props.onFiles(disk.mountPoint)}><strong><FolderOpen size={14} />{disk.mountPoint}</strong><span>{gb(disk.usedBytes)} / {gb(disk.totalBytes)}<b className={disk.usagePercent >= 80 ? 'wb-warning' : ''}>{pct(disk.usagePercent)}</b></span><i><b style={{ width: `${disk.usagePercent}%` }} /></i><small>可用 {gb(disk.availableBytes)} · 打开目录</small></button>)}</div></section>}
    </>}
    {tab === 'tasks' && <div className="wb-tab-content">{queue}</div>}
    {tab === 'connection' && <div className="wb-connection-grid">
      <section><h3>SSH 连接</h3><AccessRouteSelect server={server} value={props.accessRouteId} onChange={props.onAccessRouteChange} /><dl><div><dt>目标地址</dt><dd>{route.host}:{route.port}</dd></div><div><dt>认证用户</dt><dd>{route.username}</dd></div><div><dt>认证方式</dt><dd>{route.authType === 'password' ? '密码' : '私钥'}</dd></div><div><dt>连接延迟</dt><dd>{snapshot?.latencyMs == null ? '—' : `${snapshot.latencyMs} ms`}</dd></div><div><dt>监控方式</dt><dd>{server.monitorPolicy === 'background' ? '持续监控' : server.monitorPolicy === 'onView' ? '查看时采集' : '手动采集'}</dd></div></dl><div className="wb-connection-actions"><button className="secondary-button" onClick={props.onTest} disabled={props.testing}>{props.testing ? '测试中…' : '测试连接'}</button><button className="secondary-button" onClick={props.onEdit}>编辑服务器</button><button className="wb-text-button" onClick={props.onMerge}>合并连接路径</button><button className="wb-text-button wb-danger" onClick={props.onRemove}>删除服务器</button></div></section>
      <section><h3>存储挂载</h3>{snapshot?.fileSystems.length ? <table className="wb-table"><thead><tr><th>挂载点</th><th>已用 / 总量</th><th>使用率</th></tr></thead><tbody>{snapshot.fileSystems.map((disk) => <tr key={`${disk.filesystem}:${disk.mountPoint}`}><td>{disk.mountPoint}</td><td>{gb(disk.usedBytes)} / {gb(disk.totalBytes)}</td><td className={disk.usagePercent >= 80 ? 'wb-warning' : ''}>{pct(disk.usagePercent)}</td></tr>)}</tbody></table> : <p className="wb-muted">尚无存储数据。</p>}</section>
    </div>}
    {tab === 'history' && <div className="wb-tab-content">{selectedGpu ? <><label className="wb-history-selector">设备<select value={selectedGpu.uuid} onChange={(event) => setSelectedUuid(event.target.value)}>{gpus.map((gpu) => <option key={gpu.uuid} value={gpu.uuid}>GPU {gpu.index} · {gpu.name}</option>)}</select></label>{historyError && <p className="wb-notice error">{historyError}</p>}<GpuHistoryChart points={history} range={historyRange} loading={historyLoading} onRangeChange={setHistoryRange} /></> : <div className="wb-empty-inline">采集 GPU 数据后可查看本地历史。</div>}</div>}
  </section>
}
