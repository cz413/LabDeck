import { describe, expect, it } from 'vitest'
import type { GpuMetric } from './types'
import { gpuLoadState, gpuRecommendation, isGpuBusy } from './gpu-status'

const gpu = (overrides: Partial<GpuMetric> = {}): GpuMetric => ({
  index: 0,
  name: 'NVIDIA RTX 3090',
  uuid: 'GPU-TEST-0',
  utilizationPercent: 0,
  memoryUsedMiB: 300,
  memoryTotalMiB: 24576,
  temperatureC: 31,
  powerW: 11,
  powerLimitW: 350,
  fanPercent: 30,
  performanceState: 'P8',
  processes: [],
  ...overrides
})

describe('GPU busy status', () => {
  it('counts a GPU with a process as busy even when utilization is momentarily zero', () => {
    const metric = gpu({ processes: [{ pid: 42, username: 'user', processName: 'python', memoryUsedMiB: 300, elapsedSeconds: 120 }] })
    expect(isGpuBusy(metric)).toBe(true)
    expect(gpuLoadState(metric)).toBe('busy')
  })

  it('uses material memory allocation as a fallback when the process list is unavailable', () => {
    expect(isGpuBusy(gpu({ memoryUsedMiB: 4096 }))).toBe(true)
  })

  it('keeps driver-only memory usage idle and reports temperature warnings independently', () => {
    expect(isGpuBusy(gpu())).toBe(false)
    expect(gpuLoadState(gpu({ temperatureC: 84 }))).toBe('warning')
  })
})

describe('GPU recommendation', () => {
  it('prefers a cool GPU with free memory and no running processes', () => {
    const idle = gpu()
    const busy = gpu({ utilizationPercent: 82, memoryUsedMiB: 19000, temperatureC: 72, processes: [{ pid: 42, username: 'user', processName: 'python', memoryUsedMiB: 19000, elapsedSeconds: 120 }] })
    expect(gpuRecommendation(idle).score).toBeGreaterThan(gpuRecommendation(busy).score)
    expect(gpuRecommendation(idle).label).toBe('优先推荐')
  })

  it('does not recommend an overheated GPU even if it has free memory', () => {
    expect(gpuRecommendation(gpu({ temperatureC: 84 })).score).toBeLessThanOrEqual(30)
  })
})
