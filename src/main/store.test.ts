import { describe, expect, it, vi } from 'vitest'
import type { ExperimentTask, ServerProfile, TunnelConfigInput } from '../shared/types'
vi.mock('electron', () => ({ app: { getPath: () => '.' }, safeStorage: {} }))
import { AppStore } from './store'

function taskStore(status: string, runStatuses: string[], archived = false) {
  const task = { id: 'task', status, archived, runs: runStatuses.map((runStatus) => ({ status: runStatus })) } as ExperimentTask
  const data = { experimentTasks: [task] }
  const store = new AppStore()
  const persist = vi.fn(async () => undefined)
  Object.assign(store, { data, persist })
  return { store, data, persist }
}

describe('task deletion', () => {
  it.each(['planned', 'queued', 'cancelled', 'completed', 'failed', 'paused'])('deletes a %s task and its local history', async (status) => {
    const { store, data, persist } = taskStore(status, ['cancelled', 'completed', status])
    await store.deleteExperimentTask('task')
    expect(data.experimentTasks).toEqual([])
    expect(persist).toHaveBeenCalledOnce()
  })

  it('allows deleting archived tasks with history', async () => {
    const { store, data } = taskStore('completed', ['completed'], true)
    await store.deleteExperimentTask('task')
    expect(data.experimentTasks).toEqual([])
  })

  it.each(['preparing', 'running'])('protects a %s task', async (status) => {
    const { store, data, persist } = taskStore(status, [])
    await expect(store.deleteExperimentTask('task')).rejects.toThrow('先取消运行')
    expect(data.experimentTasks).toHaveLength(1)
    expect(persist).not.toHaveBeenCalled()
  })

  it('checks current run status even if the task status is stale', async () => {
    const { store, data } = taskStore('queued', ['preparing'])
    await expect(store.deleteExperimentTask('task')).rejects.toThrow('先取消运行')
    expect(data.experimentTasks).toHaveLength(1)
  })
})

describe('saved SSH tunnels', () => {
  const serverId = '11111111-1111-4111-8111-111111111111'
  const server: ServerProfile = { id: serverId, name: 'gpu', host: 'gpu.test', port: 22, username: 'user', authType: 'password', hasSecret: true, mode: 'real', monitorPolicy: 'manual', group: '', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const input: TunnelConfigInput = { name: 'Jupyter', serverId, accessRouteId: 'direct', type: 'local', bindAddress: '127.0.0.1', bindPort: 8888, targetHost: '127.0.0.1', targetPort: 8888, browserProtocol: 'http', autoStart: false, autoReconnect: true }
  const fixture = () => {
    const store = new AppStore()
    const data = { servers: [structuredClone(server)], tunnels: [], secrets: {}, lastSnapshots: {}, gpuHistory: {}, settings: { gpuWatches: [], serverOrder: [] } }
    const persist = vi.fn(async () => undefined)
    Object.assign(store, { data, persist })
    return { store, data, persist }
  }
  it('saves and updates a config without adding duplicate records or credentials', async () => {
    const { store, persist } = fixture()
    const saved = await store.saveTunnel({ ...input, password: 'not-persisted' } as TunnelConfigInput)
    await store.saveTunnel({ ...input, id: saved.id, bindPort: 18888 })
    expect(store.listTunnels()).toHaveLength(1)
    expect(store.getTunnel(saved.id)).toMatchObject({ bindPort: 18888, createdAt: saved.createdAt })
    expect(store.getTunnel(saved.id)).not.toHaveProperty('password')
    expect(persist).toHaveBeenCalledTimes(2)
  })
  it('rejects deleted routes and demonstration servers without persisting', async () => {
    const { store, data, persist } = fixture()
    await expect(store.saveTunnel({ ...input, accessRouteId: 'gone' })).rejects.toThrow('连接路径不存在')
    data.servers[0].mode = 'demo'
    await expect(store.saveTunnel(input)).rejects.toThrow('真实服务器')
    expect(persist).not.toHaveBeenCalled()
  })
  it('removes the related tunnel configs when a server is deleted', async () => {
    const { store } = fixture()
    await store.saveTunnel(input)
    await store.removeServer(serverId)
    expect(store.listTunnels()).toEqual([])
  })
  it('migrates tunnel references when duplicate server routes are merged', async () => {
    const { store, data } = fixture()
    const sourceId = '33333333-3333-4333-8333-333333333333'
    data.servers.push({ ...server, id: sourceId, name: 'gpu-jump', jumpHost: { host: 'jump.test', port: 22, username: 'relay', authType: 'password' } })
    const saved = await store.saveTunnel({ ...input, serverId: sourceId, accessRouteId: 'jump' })
    const merged = await store.mergeAccessRoute(serverId, sourceId)
    const tunnel = store.getTunnel(saved.id)
    expect(tunnel.serverId).toBe(serverId)
    expect(merged.accessRoutes?.some(route => route.id === tunnel.accessRouteId && route.kind === 'jump')).toBe(true)
  })
})
