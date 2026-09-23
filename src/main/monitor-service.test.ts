import { describe, expect, it } from 'vitest'
import type { ServerProfile } from '../shared/types'
import { MonitorService } from './monitor-service'
import type { SshService } from './ssh-service'

describe('MonitorService demo GPU snapshot', () => {
  it('includes multiple GPUs, hardware details and process ownership', async () => {
    const profile: ServerProfile = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'GPU-01 · 演示节点',
      host: '10.20.0.21',
      port: 22,
      username: 'researcher',
      authType: 'password',
      tags: ['GPU'],
      group: '测试',
      mode: 'demo',
      monitorPolicy: 'background',
      hasSecret: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }
    const service = new MonitorService({} as SshService)
    const snapshot = await service.snapshot(profile, {})

    expect(snapshot.gpus).toHaveLength(4)
    expect(snapshot.gpus[0].powerLimitW).toBe(450)
    expect(snapshot.gpus[0].processes[0]).toMatchObject({ username: 'chen' })
    expect(snapshot.gpus[0].processes[0].elapsedSeconds).toBeGreaterThan(0)
    expect(snapshot.gpus[3].processes).toHaveLength(0)
    expect(snapshot.gpus[3].performanceState).toBe('P8')
  })

  it('parses process elapsed time and keeps the process name aligned when elapsed time is unavailable', () => {
    const service = new MonitorService({} as SshService)
    const parse = (service as unknown as {
      parseGpuProcesses(raw: string): Map<string, Array<{ elapsedSeconds: number | null; processName: string }>>
    }).parseGpuProcesses.bind(service)
    const processes = parse([
      'GPU-1,42,chen,8192,7322,python train.py',
      'GPU-1,43,li,2048,,python inference.py'
    ].join('\n')).get('GPU-1')

    expect(processes?.[0]).toMatchObject({ elapsedSeconds: 7322, processName: 'python train.py' })
    expect(processes?.[1]).toMatchObject({ elapsedSeconds: null, processName: 'python inference.py' })
  })
})
