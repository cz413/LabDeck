import type { GpuHistoryPoint, GpuHistoryRange } from '@shared/types'

interface GpuHistoryChartProps {
  points: GpuHistoryPoint[]
  range: GpuHistoryRange
  loading: boolean
  onRangeChange(range: GpuHistoryRange): void
}

interface SeriesDefinition {
  key: string
  label: string
  unit: string
  color: string
  value(point: GpuHistoryPoint): number | null
  domain(points: GpuHistoryPoint[]): [number, number]
}

const series: SeriesDefinition[] = [
  { key: 'util', label: '利用率', unit: '%', color: '#58b8ae', value: (point) => point.utilizationPercent, domain: () => [0, 100] },
  { key: 'memory', label: '显存', unit: '%', color: '#6f8fb5', value: (point) => point.memoryTotalMiB ? point.memoryUsedMiB / point.memoryTotalMiB * 100 : 0, domain: () => [0, 100] },
  { key: 'temperature', label: '温度', unit: '°C', color: '#d3a252', value: (point) => point.temperatureC, domain: () => [20, 100] },
  { key: 'power', label: '功耗', unit: 'W', color: '#9b8bb8', value: (point) => point.powerW, domain: (points) => [0, Math.max(100, ...points.map((point) => point.powerW ?? 0))] }
]

export function GpuHistoryChart({ points, range, loading, onRangeChange }: GpuHistoryChartProps): React.JSX.Element {
  const sampled = downsample(points, 180)
  const start = sampled[0]?.sampledAt
  const end = sampled.at(-1)?.sampledAt
  return <section className="gpu-history-panel">
    <div className="gpu-history-heading">
      <div><h3>运行历史</h3><p>{points.length ? `${points.length} 个本地采样点` : '等待采集数据'}</p></div>
      <div className="range-switch" aria-label="历史时间范围">
        {(['1h', '6h', '24h'] as GpuHistoryRange[]).map((item) => <button key={item} className={range === item ? 'active' : ''} onClick={() => onRangeChange(item)}>{item === '1h' ? '1 小时' : item === '6h' ? '6 小时' : '24 小时'}</button>)}
      </div>
    </div>
    {loading ? <div className="history-empty">正在读取本地历史…</div> : sampled.length < 2 ? <div className="history-empty">至少完成两次采集后显示曲线</div> : <>
      <div className="history-chart-grid">{series.map((item) => <Sparkline key={item.key} definition={item} points={sampled} />)}</div>
      <div className="history-time-axis"><span>{formatTime(start)}</span><span>{formatTime(end)}</span></div>
    </>}
  </section>
}

function Sparkline({ definition, points }: { definition: SeriesDefinition; points: GpuHistoryPoint[] }): React.JSX.Element {
  const values = points.map(definition.value)
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value))
  const [min, max] = definition.domain(points)
  const coordinates = values.map((value, index) => {
    if (value === null || !Number.isFinite(value)) return null
    const x = values.length === 1 ? 0 : index / (values.length - 1) * 100
    const y = 31 - (Math.min(max, Math.max(min, value)) - min) / Math.max(1, max - min) * 28
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).filter(Boolean).join(' ')
  const latest = valid.at(-1)
  const severityPercent = definition.key === 'temperature'
    ? ((latest ?? 20) - 20) / 80 * 100
    : definition.key === 'power'
      ? (latest ?? 0) / Math.max(1, max) * 100
      : latest ?? 0
  const lineColor = severityPercent >= 90 ? '#e15f67' : severityPercent >= 70 ? '#d6a348' : severityPercent >= 40 ? '#4d9ed1' : definition.color
  return <div className="history-series">
    <div><span>{definition.label}</span><strong style={{ color: lineColor }}>{latest === undefined ? '—' : `${Math.round(latest)}${definition.unit}`}</strong></div>
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={`${definition.label}历史曲线`}>
      <line x1="0" x2="100" y1="31" y2="31" />
      <line x1="0" x2="100" y1="17" y2="17" />
      <polyline points={coordinates} style={{ stroke: lineColor }} />
    </svg>
  </div>
}

function downsample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items
  const step = Math.ceil(items.length / limit)
  const result = items.filter((_, index) => index % step === 0)
  if (result.at(-1) !== items.at(-1)) result.push(items.at(-1)!)
  return result
}

function formatTime(value?: string): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
