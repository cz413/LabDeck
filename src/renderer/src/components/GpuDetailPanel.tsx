import { useEffect, useMemo, useState } from 'react'
import { Activity, Bell, Cpu, Gauge, MemoryStick, Thermometer, UserRound, X, Zap } from 'lucide-react'
import type { GpuHistoryPoint, GpuHistoryRange, GpuMetric, GpuWatchTarget, ServerProfile, ServerSnapshot } from '@shared/types'
import { gpuLoadState } from '@shared/gpu-status'
import { GpuHistoryChart } from './GpuHistoryChart'

interface GpuDetailPanelProps {
  server: ServerProfile
  snapshot?: ServerSnapshot
  initialGpuIndex: number
  watches: GpuWatchTarget[]
  onToggleWatch(gpuUuid: string): void
  onClose(): void
}

const percentage = (used: number, total: number): number => total > 0 ? used / total * 100 : 0
const status = (gpu: GpuMetric): { label: string; className: string } => {
  const state = gpuLoadState(gpu)
  return state === 'warning'
    ? { label: '温度告警', className: 'warning' }
    : state === 'busy'
      ? { label: '使用中', className: 'busy' }
      : { label: '空闲', className: 'idle' }
}
const formatDuration = (seconds: number | null | undefined): string => {
  if (seconds === null || seconds === undefined) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${minutes}分`
  return `${Math.max(1, minutes)} 分钟`
}

export function GpuDetailPanel({ server, snapshot, initialGpuIndex, watches, onToggleWatch, onClose }: GpuDetailPanelProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(initialGpuIndex)
  const [historyRange, setHistoryRange] = useState<GpuHistoryRange>('6h')
  const [history, setHistory] = useState<GpuHistoryPoint[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const gpus = snapshot?.gpus ?? []
  const selected = useMemo(
    () => gpus.find((gpu) => gpu.index === selectedIndex) ?? gpus[0],
    [gpus, selectedIndex]
  )
  const serverWatched = watches.some((watch) => watch.serverId === server.id && !watch.gpuUuid)
  const selectedWatched = selected ? watches.some((watch) => watch.serverId === server.id && watch.gpuUuid === selected.uuid) : false

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (!selected) return
    let active = true
    setHistoryLoading(true)
    void window.labApi.monitor.gpuHistory(server.id, selected.uuid, historyRange)
      .then((points) => { if (active) setHistory(points) })
      .catch(() => { if (active) setHistory([]) })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [server.id, selected?.uuid, historyRange, snapshot?.sampledAt])

  return <div className="workspace-overlay gpu-overlay app-modal-overlay">
    <div className="gpu-workspace app-modal">
      <header className="workspace-header gpu-header">
        <div><div className="workspace-kicker">GPU 资源详情</div><h2>{server.name}</h2><p>{server.username}@{server.host} · {snapshot?.cached ? '上次采集于' : '采集于'} {snapshot ? new Date(snapshot.sampledAt).toLocaleTimeString('zh-CN') : '—'}</p></div>
        <button className="icon-button" onClick={onClose} aria-label="关闭 GPU 详情"><X size={19} /></button>
      </header>

      {!selected ? <div className="gpu-empty"><Cpu size={38} /><strong>没有检测到 NVIDIA GPU</strong><span>请确认服务器已安装驱动并可执行 nvidia-smi。</span></div> : <div className="gpu-detail-layout">
        <aside className="gpu-selector">
          <div className="gpu-selector-title"><span>设备列表</span><b>{gpus.length} 卡</b></div>
          {gpus.map((gpu) => { const state = status(gpu); return <button key={gpu.uuid} className={gpu.index === selected.index ? 'active' : ''} onClick={() => setSelectedIndex(gpu.index)}>
            <div><strong>GPU {gpu.index}</strong><span>{gpu.name.replace('NVIDIA ', '')}</span></div>
            <i className={state.className}>{state.label}</i>
            <small>{Math.round(gpu.utilizationPercent)}% · {Math.round(gpu.memoryUsedMiB / 1024)} / {Math.round(gpu.memoryTotalMiB / 1024)} GB</small>
          </button> })}
        </aside>

        <main className="gpu-detail-main">
          <div className="gpu-detail-heading">
            <div><span>GPU {selected.index}</span><h3>{selected.name}</h3><p>{selected.uuid}</p></div>
            <div className="gpu-detail-heading-actions">
              <button type="button" className={`gpu-watch-action ${selectedWatched || serverWatched ? 'active' : ''}`} disabled={serverWatched} onClick={() => onToggleWatch(selected.uuid)} title={serverWatched ? '已关注整台服务器' : selectedWatched ? '取消这块 GPU 的空闲提醒' : '这块 GPU 空闲时通知我'}><Bell size={15} />{serverWatched ? '已关注服务器' : selectedWatched ? '已关注' : '空闲时提醒'}</button>
              <div className={`gpu-state ${snapshot?.cached ? 'cached' : status(selected).className}`}><i />{snapshot?.cached ? '历史缓存' : status(selected).label}</div>
            </div>
          </div>

          <section className="gpu-stat-grid">
            <GpuStat icon={<Activity size={18} />} label="核心利用率" value={`${Math.round(selected.utilizationPercent)}%`} percent={selected.utilizationPercent} />
            <GpuStat icon={<MemoryStick size={18} />} label="显存" value={`${(selected.memoryUsedMiB / 1024).toFixed(1)} / ${(selected.memoryTotalMiB / 1024).toFixed(1)} GB`} percent={percentage(selected.memoryUsedMiB, selected.memoryTotalMiB)} />
            <GpuStat icon={<Thermometer size={18} />} label="温度" value={`${Math.round(selected.temperatureC)}°C`} percent={selected.temperatureC} warn={selected.temperatureC >= 80} />
            <GpuStat icon={<Zap size={18} />} label="功耗" value={selected.powerW === null ? '—' : `${Math.round(selected.powerW)} / ${selected.powerLimitW ? Math.round(selected.powerLimitW) : '—'} W`} percent={selected.powerW && selected.powerLimitW ? percentage(selected.powerW, selected.powerLimitW) : 0} />
          </section>

          <section className="gpu-hardware-strip">
            <div><Gauge size={16} /><span>风扇</span><strong>{selected.fanPercent === null ? 'N/A' : `${Math.round(selected.fanPercent)}%`}</strong></div>
            <div><Cpu size={16} /><span>性能状态</span><strong>{selected.performanceState ?? 'N/A'}</strong></div>
            <div><MemoryStick size={16} /><span>空闲显存</span><strong>{((selected.memoryTotalMiB - selected.memoryUsedMiB) / 1024).toFixed(1)} GB</strong></div>
          </section>

          <GpuHistoryChart points={history} range={historyRange} loading={historyLoading} onRangeChange={setHistoryRange} />

          <section className="gpu-process-panel">
            <div className="gpu-process-title"><div><h3>{snapshot?.cached ? '上次采集进程' : '当前 GPU 进程'}</h3><p>通过 nvidia-smi 与 ps 只读采集</p></div><span>{selected.processes.length} 个进程</span></div>
            {selected.processes.length ? <div className="gpu-process-table">
              <div className="gpu-process-head"><span>用户</span><span>PID</span><span>运行时长</span><span>进程</span><span>显存占用</span></div>
              {selected.processes.map((process) => <div className="gpu-process-row" key={`${process.pid}-${process.processName}`}>
                <span className="gpu-user"><UserRound size={15} />{process.username}</span><code>{process.pid}</code><time>{formatDuration(process.elapsedSeconds)}</time><span title={process.processName}>{process.processName}</span><strong>{process.memoryUsedMiB >= 1024 ? `${(process.memoryUsedMiB / 1024).toFixed(1)} GB` : `${Math.round(process.memoryUsedMiB)} MB`}</strong>
              </div>)}
            </div> : <div className="gpu-idle-state"><CheckIcon /><div><strong>{snapshot?.cached ? '上次采集时没有进程' : '这块显卡当前空闲'}</strong><span>{snapshot?.cached ? '请手动刷新以确认当前状态。' : '未发现计算进程，可用于提交新任务。'}</span></div></div>}
          </section>
        </main>
      </div>}
    </div>
  </div>
}

function GpuStat({ icon, label, value, percent, warn }: { icon: React.ReactNode; label: string; value: string; percent: number; warn?: boolean }): React.JSX.Element {
  const level = warn || percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : percent >= 40 ? 'active' : 'normal'
  return <div className={`gpu-stat load-${level}`}><div>{icon}<span>{label}</span></div><strong>{value}</strong><div className="gpu-stat-track"><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div></div>
}

function CheckIcon(): React.JSX.Element {
  return <div className="gpu-idle-icon">✓</div>
}
