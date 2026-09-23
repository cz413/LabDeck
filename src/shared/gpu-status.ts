import type { GpuMetric } from './types'

type GpuLoadInput = Pick<
  GpuMetric,
  'utilizationPercent' | 'memoryUsedMiB' | 'memoryTotalMiB' | 'temperatureC' | 'processes'
>

export function gpuMemoryPercent(gpu: GpuLoadInput): number {
  return gpu.memoryTotalMiB > 0 ? gpu.memoryUsedMiB / gpu.memoryTotalMiB * 100 : 0
}

export function isGpuBusy(gpu: GpuLoadInput): boolean {
  const memoryPercent = gpuMemoryPercent(gpu)
  return gpu.processes.length > 0 || gpu.utilizationPercent >= 10 || memoryPercent >= 5
}

export function gpuLoadState(gpu: GpuLoadInput): 'idle' | 'busy' | 'warning' {
  if (gpu.temperatureC >= 80) return 'warning'
  return isGpuBusy(gpu) ? 'busy' : 'idle'
}

export interface GpuRecommendation {
  score: number
  freeMemoryMiB: number
  label: '优先推荐' | '可以使用' | '负载较高'
}

export function gpuRecommendation(gpu: GpuLoadInput): GpuRecommendation {
  const memoryFreeRatio = gpu.memoryTotalMiB > 0
    ? Math.max(0, Math.min(1, 1 - gpu.memoryUsedMiB / gpu.memoryTotalMiB))
    : 0
  const utilizationScore = Math.max(0, Math.min(1, 1 - gpu.utilizationPercent / 100))
  const processScore = gpu.processes.length === 0 ? 1 : Math.max(0, 1 - gpu.processes.length * 0.25)
  const temperatureScore = Math.max(0, Math.min(1, (85 - gpu.temperatureC) / 55))
  let score = Math.round(memoryFreeRatio * 45 + utilizationScore * 30 + processScore * 15 + temperatureScore * 10)
  if (gpu.temperatureC >= 80) score = Math.min(score, 30)
  return {
    score,
    freeMemoryMiB: Math.max(0, gpu.memoryTotalMiB - gpu.memoryUsedMiB),
    label: score >= 75 ? '优先推荐' : score >= 50 ? '可以使用' : '负载较高'
  }
}
