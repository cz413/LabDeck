import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ExperimentTaskPool } from './src/components/ExperimentTaskPool'
import { ConfirmDialog, type ConfirmationRequest } from './src/components/ConfirmDialog'
import type { ExperimentTask, ServerProfile } from '../shared/types'
import './src/styles.css'
import './src/workbench.css'

const server: ServerProfile = {
  id: 'preview-gpu', name: 'gpu8', host: '192.0.2.8', port: 22, username: 'researcher',
  authType: 'password', mode: 'real', monitorPolicy: 'manual', tags: [], group: '实验室',
  hasSecret: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
}
const base = {
  project: '视觉语言模型', objective: '', tags: [], priority: 'normal', serverId: server.id,
  codePath: '/home/researcher/code/LISA', dataPath: '/data/DataLACP/researcher/code/LISA/dataset',
  launchCommand: 'deepspeed --master_port=24999 train_ds.py --version="/home/researcher/code/LISA/checkpoints/llava" --dataset_dir="/data/DataLACP/researcher/code/LISA/dataset" --vision_pretrained="/home/researcher/code/LISA/checkpoints/sam/sam_vit_h_4b8939.pth" --dataset="sem_seg||refer_seg||vqa||reason_seg" --sample_rates="9,3,3,1" --precision=bf16 --batch_size=1 --grad_accumulation_steps=20 --exp_name="lisa-7b-1gpu"',
  condaEnvironment: { manager: 'conda', environmentPrefix: '/home/researcher/miniconda3/envs/lisa' },
  minimumFreeVramGiB: 30, maximumGpuUtilizationPercent: 30, artifactPath: '', resultSummary: '', notes: '',
  archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
}
const fixture = (id: string, title: string, status: string) => ({
  ...base, id, title, status,
  runs: [{ ...base, id: `${id}-run`, number: 1, status, queuedAt: new Date().toISOString(),
    message: status === 'preparing' ? '已选择符合条件的 GPU，正在检查目录和 Conda 环境' : '',
    resultSummary: '', notes: '' }]
}) as ExperimentTask
const initialTasks = [fixture('preparing', 'LISA复现', 'preparing'), fixture('cancelled', 'LISA复现 · 已取消', 'cancelled'), fixture('queued', '视觉指令微调', 'queued'), fixture('failed', '分割模型消融', 'failed')]

function Preview() {
  const [tasks, setTasks] = useState(initialTasks)
  const [confirmation, setConfirmation] = useState<(ConfirmationRequest & { resolve(value: boolean): void }) | null>(null)
  const [notice, setNotice] = useState('')
  Object.assign(window, { labApi: { experiments: {
    deleteTask: async (id: string) => { setTasks((current) => current.filter((task) => task.id !== id)) },
    cancelRun: async (id: string) => {
      const updated = { ...tasks.find((task) => task.id === id)!, status: 'cancelled', runs: [] } as ExperimentTask
      return updated
    }
  } } })
  return <main style={{ height: '100%', overflow: 'auto', padding: '24px', background: 'var(--bg)' }}>
    <h1 style={{ fontSize: 20, margin: '0 0 18px' }}>实验任务</h1>
    <ExperimentTaskPool tasks={tasks} servers={[server]} snapshots={{}} liveTasks={null} liveTaskCount={0} vscodeConnectingId={null}
      onChanged={(updated) => setTasks((current) => current.map((task) => task.id === updated.id ? updated : task))}
      notify={setNotice} confirm={(request) => new Promise((resolve) => setConfirmation({ ...request, resolve }))}
      onTrusted={async () => undefined} onOpenTerminal={() => true} onOpenFiles={() => undefined} onOpenVsCode={() => undefined} />
    {notice && <output style={{ display: 'block', padding: 12 }}>{notice}</output>}
    {confirmation && <ConfirmDialog {...confirmation} onConfirm={() => { confirmation.resolve(true); setConfirmation(null) }} onCancel={() => { confirmation.resolve(false); setConfirmation(null) }} />}
  </main>
}
document.documentElement.dataset.theme = 'ocean'
createRoot(document.getElementById('root')!).render(<Preview />)
