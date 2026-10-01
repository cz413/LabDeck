import { describe, expect, it, vi } from 'vitest'
import type { ExperimentTask } from '../shared/types'
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
