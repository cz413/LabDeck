import { Bell, ChevronRight, RefreshCw } from 'lucide-react'
import type { GpuWatchTarget, ServerProfile, ServerSnapshot } from '@shared/types'
import { gpuLoadState, gpuRecommendation, isGpuBusy } from '@shared/gpu-status'

interface Props {
  servers: ServerProfile[]
  snapshots: Record<string, ServerSnapshot>
  watches: GpuWatchTarget[]
  refreshing: boolean
  onRefresh(): void
  onToggleWatch(target: GpuWatchTarget): void
  onSelect(server: ServerProfile, gpuIndex: number): void
  filters: { server: string; model: string; state: string }
  onFiltersChange(filters: Props['filters']): void
}

export function GpuResourcePool(props: Props): React.JSX.Element {
  const { server: serverFilter, model: modelFilter, state: stateFilter } = props.filters
  const setServerFilter = (server: string) => props.onFiltersChange({ ...props.filters, server })
  const setModelFilter = (model: string) => props.onFiltersChange({ ...props.filters, model })
  const setStateFilter = (state: string) => props.onFiltersChange({ ...props.filters, state })
  const devices = props.servers.flatMap(server => {
    const snapshot = props.snapshots[server.id]
    const live = !!snapshot && !snapshot.cached && (snapshot.status === 'online' || snapshot.status === 'warning')
    return (snapshot?.gpus ?? []).map(gpu => ({ server, snapshot, gpu, live,
      state: !live ? 'cached' as const : gpuLoadState(gpu) }))
  })
  const liveDevices = devices.filter(item => item.live)
  const idle = liveDevices.filter(item => !isGpuBusy(item.gpu))
  const recommendations = idle.map(item => ({ ...item, recommendation: gpuRecommendation(item.gpu) }))
    .sort((a, b) => b.recommendation.score - a.recommendation.score).slice(0, 3)
  const visible = devices.filter(item => (serverFilter === 'all' || item.server.id === serverFilter)
    && (modelFilter === 'all' || item.gpu.name === modelFilter)
    && (stateFilter === 'all' || item.state === stateFilter))
  const totalMemory = liveDevices.reduce((sum, item) => sum + item.gpu.memoryTotalMiB, 0)
  const freeMemory = liveDevices.reduce((sum, item) => sum + Math.max(0, item.gpu.memoryTotalMiB - item.gpu.memoryUsedMiB), 0)
  const names = { idle: '空闲', busy: '使用中', warning: '温度告警', cached: '待确认' }
  return <section className="wb-resource-pool">
    <header className="workbench-page-heading"><div><h1>GPU 总览</h1><p>跨服务器查看设备、可用显存与计算进程</p></div><button className="secondary-button" onClick={props.onRefresh} disabled={props.refreshing}><RefreshCw size={14} className={props.refreshing ? 'spin' : ''} />刷新资源</button></header>
    <div className="wb-resource-summary"><div><span>已登记设备</span><strong>{devices.length}<small>张 / {props.servers.length} 台服务器</small></strong></div><div><span>实时空闲</span><strong>{idle.length}<small>张可调度</small></strong></div><div><span>使用中</span><strong>{liveDevices.filter(item => isGpuBusy(item.gpu)).length}<small>张设备</small></strong></div><div><span>实时空闲显存</span><strong>{(freeMemory / 1024).toFixed(1)}<small>/ {(totalMemory / 1024).toFixed(0)} GiB</small></strong></div></div>
    <div className="wb-pool-toolbar"><label>服务器<select aria-label="GPU 总览服务器筛选" value={serverFilter} onChange={event => setServerFilter(event.target.value)}><option value="all">全部服务器</option>{props.servers.map(server => <option value={server.id} key={server.id}>{server.name}</option>)}</select></label><label>型号<select aria-label="GPU 总览型号筛选" value={modelFilter} onChange={event => setModelFilter(event.target.value)}><option value="all">全部型号</option>{[...new Set(devices.map(item => item.gpu.name))].map(name => <option value={name} key={name}>{name.replace(/^NVIDIA\s+/, '')}</option>)}</select></label><label>状态<select aria-label="GPU 总览状态筛选" value={stateFilter} onChange={event => setStateFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(names).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><button className="wb-text-button" onClick={() => props.onFiltersChange({ server: 'all', model: 'all', state: 'all' })}>重置筛选</button><span>{visible.length} / {devices.length} 张设备</span></div>
    <div className="wb-table-scroll"><table className="wb-table wb-pool-table"><thead><tr><th>服务器 / GPU</th><th>状态</th><th>利用率</th><th>显存占用</th><th>温度 / 功耗</th><th>运行用户</th><th>操作</th></tr></thead><tbody>{visible.map(({ server, gpu, state, live }) => {
      const watched = props.watches.some(watch => watch.serverId === server.id && (!watch.gpuUuid || watch.gpuUuid === gpu.uuid))
      const memory = gpu.memoryTotalMiB ? gpu.memoryUsedMiB / gpu.memoryTotalMiB * 100 : 0
      return <tr key={`${server.id}:${gpu.uuid}`}><td><button className="wb-device-link" onClick={() => props.onSelect(server, gpu.index)}><strong>{server.name} / GPU {gpu.index}</strong><small>{gpu.name.replace(/^NVIDIA\s+/, '')}</small></button></td><td><span className={`wb-state ${state}`}><i />{names[state]}</span></td><td><div className="wb-utilization"><i><b style={{ width: `${Math.min(100, Math.max(0, gpu.utilizationPercent))}%` }} /></i><span>{Math.round(gpu.utilizationPercent)}%</span></div></td><td><div className="wb-memory-cell"><span>{(gpu.memoryUsedMiB / 1024).toFixed(1)} / {(gpu.memoryTotalMiB / 1024).toFixed(0)} GiB</span><i><b style={{ width: `${Math.min(100, Math.max(0, memory))}%` }} /></i></div></td><td><span className={gpu.temperatureC >= 80 ? 'wb-warning' : ''}>{Math.round(gpu.temperatureC)} °C</span><small className="wb-cell-secondary">{gpu.powerW == null ? '—' : `${Math.round(gpu.powerW)} W`}</small></td><td><span>{[...new Set(gpu.processes.map(process => process.username))].join('、') || '—'}</span><small className="wb-cell-secondary">{gpu.processes.length} 个进程{!live ? ' · 上次采集' : ''}</small></td><td><div className="wb-device-actions"><button className={`icon-button small ${watched ? 'active' : ''}`} aria-label={`${watched ? '取消' : '开启'} ${server.name} GPU ${gpu.index} 空闲提醒`} onClick={() => props.onToggleWatch({ serverId: server.id, gpuUuid: gpu.uuid })}><Bell size={14} /></button><button className="wb-text-button" onClick={() => props.onSelect(server, gpu.index)} aria-label={`查看 ${server.name} GPU ${gpu.index} 详情`}>详情<ChevronRight size={13} /></button></div></td></tr>
    })}</tbody></table>{!visible.length && <div className="wb-empty-inline">{devices.length ? '没有符合筛选条件的设备。调整筛选或重置后重试。' : '尚无 GPU 数据。刷新资源或检查服务器驱动。'}</div>}</div>
    <section className="wb-recommendations"><header><h2>可用设备参考</h2><span>按空闲显存、利用率和温度排序；启动前会再次确认</span></header><div>{recommendations.length ? recommendations.map(({ server, gpu, recommendation }) => <button key={`${server.id}:${gpu.uuid}`} onClick={() => props.onSelect(server, gpu.index)}><strong>{server.name} / GPU {gpu.index}<ChevronRight size={13} /></strong><span>{gpu.name.replace(/^NVIDIA\s+/, '')}</span><p><b>{(recommendation.freeMemoryMiB / 1024).toFixed(1)} GiB</b> 空闲显存</p><small>{Math.round(gpu.utilizationPercent)}% 利用率 · {Math.round(gpu.temperatureC)} °C</small></button>) : <p className="wb-muted">当前没有已确认空闲的设备。缓存和离线数据不会作为调度建议。</p>}</div></section>
  </section>
}
