import type { CondaEnvironmentConfig, ExperimentRun, ExperimentRunStartInput, ExperimentRunStatus, ExperimentTask } from '../shared/types'
import { applyAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
import { isGpuBusy } from '../shared/gpu-status'
import { CondaService } from './conda-service'
import { AppStore } from './store'
import { MonitorService } from './monitor-service'
import { SshService } from './ssh-service'

const TICK_MS = 20_000
const RUN_ROOT = '$HOME/.local/state/labdeck/runs'

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

type RunStatePatch = Partial<Pick<ExperimentRun,
  'status' | 'queuedAt' | 'startedAt' | 'finishedAt' | 'message' | 'gpuUuid' | 'gpuIndex' | 'gpuNameSnapshot' | 'minimumFreeVramGiB' | 'remotePid' | 'remoteRunDir' | 'logPath' | 'condaEnvironment'
>>

const taskIsActive = (task: ExperimentTask): boolean => task.runs.some((run) =>
  run.status === 'queued' || run.status === 'preparing' || run.status === 'running'
)

const queuedPriority = (priority: ExperimentTask['priority']): number =>
  priority === 'high' ? 0 : priority === 'normal' ? 1 : 2

export class ExperimentScheduler {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private stopped = false

  constructor(
    private readonly store: AppStore,
    private readonly ssh: SshService,
    private readonly monitor: MonitorService,
    private readonly conda: CondaService,
    private readonly onChanged: () => void
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    for (const task of this.store.listExperimentTasks()) {
      for (const run of task.runs) {
        if (run.status === 'preparing') {
          await this.updateRun(task.id, run.id, {
            status: 'queued',
            message: '应用上次退出时仍在准备；已恢复到队列'
          }, 'preparing')
        }
      }
    }
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return
    this.busy = true
    try {
      await this.refreshRunningRuns()
      if (!this.stopped) await this.dispatchQueuedRun()
    } catch (error) {
      console.warn('实验任务调度轮询失败：', error)
    } finally {
      this.busy = false
    }
  }

  private async refreshRunningRuns(): Promise<void> {
    const running = this.store.listExperimentTasks().flatMap((task) => task.runs
      .filter((run) => run.status === 'running' && run.remoteRunDir)
      .map((run) => ({ task, run })))

    for (const { task, run } of running) {
      if (this.stopped) return
      const serverId = run.serverId
      if (!serverId || !run.remoteRunDir) continue
      try {
        const server = this.store.getServer(serverId)
        const routeId = run.accessRouteId ?? getDefaultAccessRouteId(server)
        const profile = applyAccessRoute(server, routeId)
        const secrets = this.store.getSecrets(serverId)
        const status = await this.execRemote(profile, secrets,
          `run_dir=${shellQuote(run.remoteRunDir)}; if [ -f "$run_dir/exit-code" ]; then printf 'finished '; cat "$run_dir/exit-code"; elif [ -s "$run_dir/pid" ] && kill -0 "$(cat "$run_dir/pid")" 2>/dev/null; then printf 'running\\n'; else printf 'lost\\n'; fi`,
          10_000
        )
        if (status.startsWith('finished ')) {
          const exitCode = Number.parseInt(status.slice('finished '.length).trim(), 10)
          if (Number.isFinite(exitCode)) {
            await this.updateRun(task.id, run.id, {
              status: exitCode === 0 ? 'completed' : 'failed',
              finishedAt: new Date().toISOString(),
              message: exitCode === 0 ? '启动命令已正常结束' : `启动命令退出码：${exitCode}`
            }, 'running')
          }
        } else if (status.trim() === 'lost') {
          await this.updateRun(task.id, run.id, {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            message: '远程进程已结束，但没有读到退出码；请查看运行日志'
          }, 'running')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '暂时无法读取远程进程状态'
        await this.updateRun(task.id, run.id, { message: `运行中 · 状态暂不可读：${message}` }, 'running')
      }
    }
  }

  private async dispatchQueuedRun(): Promise<void> {
    const queue = this.store.listExperimentTasks()
      .filter((task) => !task.archived && taskIsActive(task))
      .flatMap((task) => task.runs.filter((run) => run.status === 'queued').map((run) => ({ task, run })))
      .sort((left, right) => queuedPriority(left.task.priority) - queuedPriority(right.task.priority) ||
        Date.parse(left.run.queuedAt ?? left.run.startedAt ?? '') - Date.parse(right.run.queuedAt ?? right.run.startedAt ?? ''))

    for (const item of queue) {
      if (this.stopped) return
      const launched = await this.prepareAndLaunch(item.task, item.run)
      if (launched) return
    }
  }

  private async prepareAndLaunch(task: ExperimentTask, run: ExperimentRun): Promise<boolean> {
    const current = this.findRun(task.id, run.id)
    if (!current || current.status !== 'queued') return false
    const minimumFreeVramGiB = run.minimumFreeVramGiB !== undefined
      ? run.minimumFreeVramGiB ?? undefined
      : task.minimumFreeVramGiB

    const serverId = run.serverId ?? task.serverId
    if (!serverId) return this.waitInQueue(task.id, run.id, '请先为任务指定服务器')
    let server
    let routeId: string
    try {
      server = this.store.getServer(serverId)
      if (server.mode !== 'real') return this.waitInQueue(task.id, run.id, '自动运行需要真实服务器')
      routeId = run.accessRouteId ?? task.accessRouteId ?? getDefaultAccessRouteId(server)
      const routeExists = getAccessRoutes(server).some((route) => route.id === routeId)
      if (!routeExists) return this.waitInQueue(task.id, run.id, '所选 SSH 连接路径已不存在，请编辑任务后重新排队')
    } catch (error) {
      const message = error instanceof Error ? error.message : '目标服务器不可用'
      return this.waitInQueue(task.id, run.id, message)
    }

    const profile = applyAccessRoute(server, routeId)
    let secrets
    try {
      secrets = this.store.getSecrets(serverId)
    } catch (error) {
      const message = error instanceof Error ? error.message : '服务器凭据不可用'
      return this.waitInQueue(task.id, run.id, message)
    }

    let firstSnapshot
    try {
      firstSnapshot = await this.monitor.snapshot(profile, secrets)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取服务器 GPU 状态'
      return this.waitInQueue(task.id, run.id, `等待服务器可连接：${message}`)
    }
    if (this.stopped) return false
    if (firstSnapshot.status === 'offline') return this.waitInQueue(task.id, run.id, `等待服务器连接：${firstSnapshot.error ?? '当前离线'}`)
    if (!this.selectIdleGpu(firstSnapshot.gpus, minimumFreeVramGiB)) {
      const requirement = minimumFreeVramGiB ? `（需至少 ${minimumFreeVramGiB} GiB 空闲显存）` : ''
      return this.waitInQueue(task.id, run.id, `该服务器当前没有符合显存条件的空闲 GPU${requirement}，任务仍在队列中`)
    }
    await this.updateRun(task.id, run.id, { status: 'preparing', message: '发现空闲 GPU，正在检查目录和 Conda 环境' }, 'queued')
    if (this.findRun(task.id, run.id)?.status !== 'preparing') return false

    const codePath = run.codePath?.trim() ?? ''
    const dataPath = run.dataPath?.trim() ?? ''
    const launchCommand = run.launchCommand?.trim() ?? ''
    if (!codePath || !codePath.startsWith('/')) return this.waitInQueue(task.id, run.id, '请填写服务器上的代码目录绝对路径')
    if (!launchCommand) return this.waitInQueue(task.id, run.id, '请填写启动命令')
    try {
      await this.execRemote(profile, secrets,
        `if [ -d ${shellQuote(codePath)} ]; then :; else printf '代码目录不存在：%s\\n' ${shellQuote(codePath)} >&2; exit 1; fi${dataPath ? ` && if [ -d ${shellQuote(dataPath)} ]; then :; else printf '数据目录不存在：%s\\n' ${shellQuote(dataPath)} >&2; exit 1; fi` : ''}`,
        15_000
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '远程目录检查失败'
      return this.waitInQueue(task.id, run.id, `运行目录未就绪：${message}`)
    }

    let condaConfig = run.condaEnvironment ? { ...run.condaEnvironment } : undefined
    if (condaConfig) {
      try {
        const result = await this.conda.checkEnvironment(profile, secrets, condaConfig)
        if (!result.found) {
          const target = condaConfig.environmentName || condaConfig.environmentPrefix || '所选环境'
          return this.waitInQueue(task.id, run.id, `Conda 环境 ${target} 尚未找到`)
        }
        if (result.managerPath && result.managerPath !== condaConfig.managerPath) {
          condaConfig = { ...condaConfig, managerPath: result.managerPath }
          await this.updateRun(task.id, run.id, { condaEnvironment: condaConfig }, 'preparing')
          if (this.findRun(task.id, run.id)?.status !== 'preparing') return false
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Conda 环境检查失败'
        return this.waitInQueue(task.id, run.id, `等待 Conda 环境可用：${message}`)
      }
    }

    if (this.stopped || this.findRun(task.id, run.id)?.status !== 'preparing') return false
    const latestSnapshot = await this.monitor.snapshot(profile, secrets)
    if (this.stopped) return false
    if (latestSnapshot.status === 'offline') return this.waitInQueue(task.id, run.id, `启动前服务器失联：${latestSnapshot.error ?? '当前离线'}`)
    const selectedGpu = this.selectIdleGpu(latestSnapshot.gpus, minimumFreeVramGiB)
    if (!selectedGpu) {
      const requirement = minimumFreeVramGiB ? `（需至少 ${minimumFreeVramGiB} GiB 空闲显存）` : ''
      return this.waitInQueue(task.id, run.id, `启动前没有符合显存条件的空闲 GPU${requirement}，继续等待`)
    }

    try {
      const launched = await this.launchRemoteRun({
        ...run,
        serverId,
        accessRouteId: routeId,
        codePath,
        dataPath,
        launchCommand,
        condaEnvironment: condaConfig
      }, profile, secrets, selectedGpu.index)
      if (this.stopped) return false
      const startedAt = new Date().toISOString()
      const freeVramGiB = (selectedGpu.memoryTotalMiB - selectedGpu.memoryUsedMiB) / 1024
      await this.updateRun(task.id, run.id, {
        status: 'running',
        startedAt,
        message: `已在 GPU ${selectedGpu.index} 启动（采样空闲显存 ${freeVramGiB.toFixed(freeVramGiB >= 10 ? 0 : 1)} GiB）；日志：${launched.logPath}`,
        gpuUuid: selectedGpu.uuid,
        gpuIndex: selectedGpu.index,
        gpuNameSnapshot: selectedGpu.name,
        remotePid: launched.pid,
        remoteRunDir: launched.runDir,
        logPath: launched.logPath
      }, 'preparing')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '远程启动失败'
      return this.waitInQueue(task.id, run.id, `启动准备失败，稍后重试：${message}`)
    }
  }

  private selectIdleGpu(gpus: Awaited<ReturnType<MonitorService['snapshot']>>['gpus'][number][], minimumFreeVramGiB?: number) {
    return gpus
      .filter((gpu) => {
        const freeMemoryMiB = gpu.memoryTotalMiB - gpu.memoryUsedMiB
        return gpu.uuid && gpu.memoryTotalMiB > 0 && gpu.temperatureC < 80 && !isGpuBusy(gpu) &&
          (minimumFreeVramGiB === undefined || freeMemoryMiB >= minimumFreeVramGiB * 1024)
      })
      .sort((left, right) => (right.memoryTotalMiB - right.memoryUsedMiB) - (left.memoryTotalMiB - left.memoryUsedMiB))[0]
  }

  private async launchRemoteRun(
    run: ExperimentRun & Required<Pick<ExperimentRunStartInput, 'serverId' | 'accessRouteId' | 'codePath' | 'dataPath' | 'launchCommand'>>,
    profile: ReturnType<typeof applyAccessRoute>,
    secrets: ReturnType<AppStore['getSecrets']>,
    gpuIndex: number
  ): Promise<{ runDir: string; pid: number; logPath: string }> {
    const runDirExpr = `"${RUN_ROOT}/${run.id}"`
    const logPathExpr = `"$run_dir/stdout.log"`
    const runCommand = run.condaEnvironment
      ? this.conda.buildEnvironmentRunCommand(run.condaEnvironment, run.launchCommand)
      : `bash -lc ${shellQuote(run.launchCommand)}`
    const script = [
      '#!/usr/bin/env bash',
      'set +e',
      `run_dir=${runDirExpr}`,
      'run_exit=0',
      `if ! cd -- ${shellQuote(run.codePath)}; then run_exit=120; else`,
      `  export CUDA_VISIBLE_DEVICES=${shellQuote(String(gpuIndex))}`,
      `  export LABDECK_RUN_ID=${shellQuote(run.id)}`,
      `  export LABDECK_RUN_DIR=${runDirExpr}`,
      `  export LABDECK_LOG_FILE=${logPathExpr}`,
      `  export LABDECK_DATA_PATH=${shellQuote(run.dataPath)}`,
      `  export LABDECK_ARTIFACT_PATH=${shellQuote(run.artifactPath ?? '')}`,
      `  ${runCommand}`,
      '  run_exit=$?',
      'fi',
      'run_tmp="$run_dir/exit-code.tmp"',
      'printf \'%s\\n\' "$run_exit" > "$run_tmp" && mv "$run_tmp" "$run_dir/exit-code"',
      'exit 0'
    ].join('\n')
    const encoded = Buffer.from(script, 'utf8').toString('base64')
    const command = [
      `run_dir=${runDirExpr}`,
      'mkdir -p "$run_dir"',
      `printf '%s' '${encoded}' | base64 -d > "$run_dir/run.sh"`,
      'chmod 700 "$run_dir/run.sh"',
      `(nohup bash "$run_dir/run.sh" > "$run_dir/stdout.log" 2>&1 < /dev/null & pid=$!; printf '%s\\n' "$pid" > "$run_dir/pid"; printf '%s\\n%s\\n' "$run_dir" "$pid")`
    ].join(' && ')
    const output = await this.execRemote(profile, secrets, command, 20_000)
    const lines = output.trim().split(/\r?\n/)
    const pid = Number.parseInt(lines.at(-1) ?? '', 10)
    const runDir = lines.at(-2)?.trim() ?? ''
    if (!Number.isInteger(pid) || pid <= 0 || !runDir.startsWith('/')) throw new Error('服务器未返回有效的远程进程信息')
    return { runDir, pid, logPath: `${runDir}/stdout.log` }
  }

  private async execRemote(
    profile: ReturnType<typeof applyAccessRoute>,
    secrets: ReturnType<AppStore['getSecrets']>,
    command: string,
    timeoutMs: number
  ): Promise<string> {
    const connected = await this.ssh.connect(profile, secrets)
    try {
      return await this.ssh.exec(connected.client, command, timeoutMs)
    } finally {
      connected.client.end()
    }
  }

  private async waitInQueue(taskId: string, runId: string, message: string): Promise<boolean> {
    const run = this.findRun(taskId, runId)
    if (!run) return false
    if (run.status === 'preparing') await this.updateRun(taskId, runId, { status: 'queued', message }, 'preparing')
    else if (run.status === 'queued') await this.updateRun(taskId, runId, { message }, 'queued')
    return false
  }

  private findRun(taskId: string, runId: string): ExperimentRun | undefined {
    return this.store.listExperimentTasks().find((task) => task.id === taskId)?.runs.find((run) => run.id === runId)
  }

  private async updateRun(taskId: string, runId: string, patch: RunStatePatch, expectedStatus?: ExperimentRunStatus): Promise<void> {
    const run = this.findRun(taskId, runId)
    if (!run || (expectedStatus && run.status !== expectedStatus)) return
    if (Object.entries(patch).every(([key, value]) => run[key as keyof ExperimentRun] === value)) return
    await this.store.updateExperimentRunState(taskId, runId, patch, expectedStatus)
    this.onChanged()
  }
}
