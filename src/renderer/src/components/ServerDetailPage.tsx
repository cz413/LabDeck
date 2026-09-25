import {
  Activity,
  Code2,
  Cpu,
  Edit3,
  FolderOpen,
  HardDrive,
  MemoryStick,
  RefreshCw,
  SquareTerminal,
  Thermometer,
  UsersRound,
  Wifi,
  WifiOff
} from 'lucide-react'
import { gpuLoadState, gpuMemoryPercent, isGpuBusy } from '@shared/gpu-status'
import type { ServerProfile, ServerSnapshot } from '@shared/types'
import { AccessRouteSelect } from './AccessRouteSelect'

interface ServerDetailPageProps {
  server: ServerProfile
  snapshot?: ServerSnapshot
  refreshing: boolean
  onTerminal(): void
  onRefresh(): void
  accessRouteId: string
  onAccessRouteChange(routeId: string): void
  onSftp(): void
  onVsCode(): void
  vscodeConnecting: boolean
  onEdit(): void
  onGpu(gpuIndex: number): void
}

const percent = (value: number | null | undefined): string => value === null || value === undefined ? '—' : `${Math.round(value)}%`
const bytes = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '—'
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}
const uptime = (seconds: number | null | undefined): string => {
  if (seconds === null || seconds === undefined) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`
}

export function ServerDetailPage(props: ServerDetailPageProps): React.JSX.Element {
  const { server, snapshot } = props
  const memoryPercent = snapshot?.memoryTotalBytes && snapshot.memoryUsedBytes !== null
    ? snapshot.memoryUsedBytes / snapshot.memoryTotalBytes * 100
    : null
  const systemDisk = snapshot?.fileSystems.find((item) => item.mountPoint === '/') ?? snapshot?.fileSystems[0]
  const gpus = snapshot?.gpus ?? []
  const busyGpuCount = gpus.filter(isGpuBusy).length

  return (
    <section className="server-detail-page">
      <header className="server-detail-commandbar">
        <div className="server-detail-route">
          <AccessRouteSelect server={server} value={props.accessRouteId} onChange={props.onAccessRouteChange} />
        </div>
        <div className="server-detail-actions">
          <button type="button" onClick={props.onRefresh}><RefreshCw size={15} className={props.refreshing ? 'spin' : ''} />刷新</button>
          <button type="button" className="server-detail-terminal" onClick={props.onTerminal}><SquareTerminal size={15} />SSH 终端</button>
          <button type="button" onClick={props.onSftp}><FolderOpen size={15} />文件</button>
          <button type="button" className="server-detail-vscode" onClick={props.onVsCode} disabled={props.vscodeConnecting}><Code2 size={15} />{props.vscodeConnecting ? '连接中…' : 'VS Code'}</button>
          <button type="button" onClick={props.onEdit}><Edit3 size={15} />编辑</button>
        </div>
      </header>

      <div className="server-detail-panel overview active">
        {snapshot?.status === 'offline' && !snapshot.cached ? (
          <div className="server-detail-offline"><WifiOff size={28} /><div><strong>无法连接这台服务器</strong><span>{snapshot.error ?? '检查网络、端口转发或 SSH 配置后重试。'}</span></div></div>
        ) : (
          <>
            <div className="server-detail-metrics">
              <DetailMetric icon={<Cpu size={17} />} label="CPU" value={percent(snapshot?.cpuUsagePercent)} detail={snapshot?.loadAverage ? `负载 ${snapshot.loadAverage.join(' / ')}` : '等待第二次采样'} percentValue={snapshot?.cpuUsagePercent ?? 0} />
              <DetailMetric icon={<MemoryStick size={17} />} label="内存" value={percent(memoryPercent)} detail={`${bytes(snapshot?.memoryUsedBytes)} / ${bytes(snapshot?.memoryTotalBytes)}`} percentValue={memoryPercent ?? 0} />
              <DetailMetric icon={<HardDrive size={17} />} label="系统盘" value={percent(systemDisk?.usagePercent)} detail={systemDisk ? `${bytes(systemDisk.usedBytes)} / ${bytes(systemDisk.totalBytes)}` : '没有磁盘数据'} percentValue={systemDisk?.usagePercent ?? 0} warning={(systemDisk?.usagePercent ?? 0) >= 80} />
              <DetailMetric icon={<Activity size={17} />} label="GPU" value={gpus.length ? `${busyGpuCount}/${gpus.length}` : '—'} detail={gpus.length ? `${gpus.reduce((sum, gpu) => sum + gpu.processes.length, 0)} 个计算进程` : '没有检测到 GPU'} percentValue={gpus.length ? busyGpuCount / gpus.length * 100 : 0} />
            </div>

            <div className="server-detail-grid">
              <section className="server-detail-section gpu-section">
                <div className="server-detail-section-title"><div><h3>GPU 设备</h3><p>利用率、显存和当前使用者</p></div><span>{gpus.length} 卡</span></div>
                {gpus.length ? <div className="server-detail-gpus">{gpus.map((gpu) => {
                  const state = gpuLoadState(gpu)
                  const users = [...new Set(gpu.processes.map((process) => process.username))]
                  return <button type="button" key={gpu.uuid} onClick={() => props.onGpu(gpu.index)}>
                    <div className="server-detail-gpu-name"><span>GPU {gpu.index}</span><strong>{gpu.name.replace('NVIDIA ', '')}</strong></div>
                    <div className="server-detail-gpu-load"><span>{Math.round(gpu.utilizationPercent)}%</span><i><b style={{ width: `${Math.min(100, gpu.utilizationPercent)}%` }} /></i></div>
                    <div><span>{(gpu.memoryUsedMiB / 1024).toFixed(1)} / {(gpu.memoryTotalMiB / 1024).toFixed(0)} GB</span><small>{Math.round(gpuMemoryPercent(gpu))}% 显存</small></div>
                    <div><span><Thermometer size={13} />{Math.round(gpu.temperatureC)}°C</span><small>{users.length ? users.join('、') : '无运行用户'}</small></div>
                    <em className={state}>{state === 'warning' ? '高温' : state === 'busy' ? '使用中' : '空闲'}</em>
                  </button>
                })}</div> : <div className="server-detail-empty">没有检测到 NVIDIA GPU。</div>}
              </section>

              <aside className="server-detail-side">
                <section className="server-detail-section">
                  <div className="server-detail-section-title"><div><h3>运行信息</h3><p>最近一次只读采集</p></div></div>
                  <dl className="server-facts">
                    <div><dt><Wifi size={14} />连接延迟</dt><dd>{snapshot?.latencyMs ? `${snapshot.latencyMs} ms` : '—'}</dd></div>
                    <div><dt><Activity size={14} />运行时间</dt><dd>{uptime(snapshot?.uptimeSeconds)}</dd></div>
                    <div><dt><UsersRound size={14} />认证用户</dt><dd>{server.username}</dd></div>
                    <div><dt><RefreshCw size={14} />采集时间</dt><dd>{snapshot ? new Date(snapshot.sampledAt).toLocaleTimeString('zh-CN') : '—'}</dd></div>
                  </dl>
                </section>
                <section className="server-detail-section storage-section">
                  <div className="server-detail-section-title"><div><h3>存储</h3><p>挂载点使用情况</p></div></div>
                  {snapshot?.fileSystems.length ? snapshot.fileSystems.slice(0, 6).map((fileSystem) => <div className="storage-row" key={`${fileSystem.filesystem}-${fileSystem.mountPoint}`}><div><strong>{fileSystem.mountPoint}</strong><span>{bytes(fileSystem.usedBytes)} / {bytes(fileSystem.totalBytes)}</span></div><b className={fileSystem.usagePercent >= 80 ? 'warning' : ''}>{Math.round(fileSystem.usagePercent)}%</b></div>) : <div className="server-detail-empty compact">没有存储数据。</div>}
                </section>
              </aside>
            </div>
          </>
        )}
      </div>

    </section>
  )
}

function DetailMetric({ icon, label, value, detail, percentValue, warning }: { icon: React.ReactNode; label: string; value: string; detail: string; percentValue: number; warning?: boolean }): React.JSX.Element {
  const level = warning || percentValue >= 90 ? 'critical' : percentValue >= 70 ? 'warning' : percentValue >= 40 ? 'active' : 'normal'
  return <div className={`server-detail-metric load-${level}`}><div><span>{icon}{label}</span><strong>{value}</strong></div><p>{detail}</p><i><b style={{ width: `${Math.max(0, Math.min(100, percentValue))}%` }} /></i></div>
}
