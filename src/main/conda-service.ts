import { posix } from 'node:path'
import type {
  CondaEnvironmentCheck,
  CondaEnvironmentConfig,
  CondaEnvironmentInfo,
  CondaEnvironmentList,
  CondaManager
} from '../shared/types'
import type { ServerProfile } from '../shared/types'
import type { ServerSecrets } from './store'
import { SshService } from './ssh-service'

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const requiredPath = (value: string, label: string): string => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.includes('\0')) throw new Error(`${label}必须是服务器上的绝对路径`)
  return posix.normalize(trimmed)
}

const parseJsonObject = (output: string): Record<string, unknown> => {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Conda 未返回有效的 JSON 结果')
  const parsed: unknown = JSON.parse(output.slice(start, end + 1))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Conda 返回的数据格式无效')
  return parsed as Record<string, unknown>
}

export class CondaService {
  constructor(private readonly ssh: SshService) {}

  async listEnvironments(
    profile: ServerProfile,
    secrets: ServerSecrets,
    manager: CondaManager,
    managerPath?: string
  ): Promise<CondaEnvironmentList> {
    const resolvedManagerPath = await this.resolveManagerPath(profile, secrets, manager, managerPath)
    const command = `${shellQuote(resolvedManagerPath)} env list --json`
    const output = await this.run(profile, secrets, command, 30_000)
    const envs = parseJsonObject(output).envs
    if (!Array.isArray(envs)) throw new Error('Conda 返回的环境列表无效')
    const environments = envs.flatMap((entry): CondaEnvironmentInfo[] => {
      if (typeof entry !== 'string' || !entry.startsWith('/')) return []
      const prefix = posix.normalize(entry)
      return [{ prefix, name: posix.basename(prefix) || prefix }]
    })
    return { environments, managerPath: resolvedManagerPath }
  }

  async checkEnvironment(
    profile: ServerProfile,
    secrets: ServerSecrets,
    config: CondaEnvironmentConfig
  ): Promise<CondaEnvironmentCheck> {
    const target = this.environmentTarget(config)
    const listing = await this.listEnvironments(profile, secrets, config.manager, config.managerPath)
    const match = listing.environments.find((environment) =>
      target.kind === 'name'
        ? environment.name === target.value
        : environment.prefix === target.value
    )
    if (!match) return {
      found: false,
      name: target.kind === 'name' ? target.value : posix.basename(target.value),
      prefix: target.kind === 'prefix' ? target.value : '',
      managerPath: listing.managerPath
    }

    const runner = target.kind === 'name'
      ? `${shellQuote(listing.managerPath)} run -n ${shellQuote(target.value)}`
      : `${shellQuote(listing.managerPath)} run -p ${shellQuote(target.value)}`
    const pythonProbe = `python -c ${shellQuote('import json,sys; print(json.dumps({"executable":sys.executable,"version":".".join(map(str,sys.version_info[:3]))}))')}`
    const info = parseJsonObject(await this.run(profile, secrets, `${runner} ${pythonProbe}`, 30_000))
    return {
      found: true,
      name: match.name,
      prefix: match.prefix,
      managerPath: listing.managerPath,
      pythonInterpreterPath: typeof info.executable === 'string' ? info.executable : undefined,
      pythonVersion: typeof info.version === 'string' ? info.version : undefined
    }
  }

  buildEnvironmentCommand(
    config: CondaEnvironmentConfig,
    updateExisting: boolean
  ): { command: string } {
    const target = this.environmentTarget(config)
    const environmentFile = requiredPath(config.environmentFilePath ?? '', 'environment.yml 路径')
    const manager = this.managerCommand(config.manager, config.managerPath)
    const action = updateExisting ? 'update' : 'create'
    const targetOption = target.kind === 'name' ? '-n' : '-p'
    const args = updateExisting
      ? `${manager} env update ${targetOption} ${shellQuote(target.value)} --file ${shellQuote(environmentFile)} --yes`
      : `${manager} env create ${targetOption} ${shellQuote(target.value)} --file ${shellQuote(environmentFile)} --yes`
    return { command: args }
  }

  buildEnvironmentRunCommand(config: CondaEnvironmentConfig, command: string): string {
    const target = this.environmentTarget(config)
    const manager = this.managerCommand(config.manager, config.managerPath)
    const targetOption = target.kind === 'name' ? '-n' : '-p'
    return `${manager} run --no-capture-output ${targetOption} ${shellQuote(target.value)} bash -lc ${shellQuote(command)}`
  }

  private managerCommand(manager: CondaManager, managerPath?: string): string {
    const executable = managerPath?.trim() || manager
    if (executable.includes('\0') || executable.length > 4096) throw new Error('Conda 可执行文件路径无效')
    return shellQuote(executable)
  }

  private async resolveManagerPath(
    profile: ServerProfile,
    secrets: ServerSecrets,
    manager: CondaManager,
    managerPath?: string
  ): Promise<string> {
    const configuredPath = managerPath?.trim()
    if (configuredPath) {
      if (configuredPath.includes('\0') || configuredPath.length > 4096) throw new Error('Conda 可执行文件路径无效')
      return configuredPath
    }

    const marker = '__LABDECK_MANAGER_PATH__'
    const candidates = [
      `"$HOME/miniconda3/bin/${manager}"`,
      `"$HOME/anaconda3/bin/${manager}"`,
      `"$HOME/miniforge3/bin/${manager}"`,
      `"$HOME/mambaforge/bin/${manager}"`,
      `"$HOME/.local/bin/${manager}"`,
      `"/opt/conda/bin/${manager}"`,
      `"/opt/miniconda3/bin/${manager}"`,
      `"/usr/local/conda/bin/${manager}"`
    ]
    const interactiveProbe = [
      `if command -v ${manager} >/dev/null 2>&1; then`,
      `  candidate="$(whence -p ${manager} 2>/dev/null)"`,
      `  if [ -n "$candidate" ] && [ -x "$candidate" ]; then printf '${marker}%s\\n' "$candidate"; exit 0; fi`,
      ...(manager === 'conda' ? [`  if [ -n "$CONDA_EXE" ] && [ -x "$CONDA_EXE" ]; then printf '${marker}%s\\n' "$CONDA_EXE"; exit 0; fi`] : []),
      `  base="$(${manager} info --base 2>/dev/null)"`,
      `  if [ -n "$base" ] && [ -x "$base/bin/${manager}" ]; then printf '${marker}%s\\n' "$base/bin/${manager}"; exit 0; fi`,
      'fi'
    ].join('\n')
    const probe = [
      `if command -v ${manager} >/dev/null 2>&1; then`,
      `  candidate="$(command -v ${manager} 2>/dev/null)"`,
      `  case "$candidate" in /*) if [ -x "$candidate" ]; then printf '${marker}%s\\n' "$candidate"; exit 0; fi ;; esac`,
      'fi',
      `for candidate in ${candidates.join(' ')}; do if [ -x "$candidate" ]; then printf '${marker}%s\\n' "$candidate"; exit 0; fi; done`,
      `if command -v zsh >/dev/null 2>&1; then zsh -ic ${shellQuote(interactiveProbe)} 2>/dev/null; fi`,
      'true'
    ].join('\n')
    const output = await this.run(profile, secrets, probe, 30_000)
    const resolved = output.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(marker))
      .map((line) => line.slice(marker.length))
      .at(-1)
    if (!resolved || !resolved.startsWith('/') || resolved.includes('\0') || resolved.length > 4096) {
      throw new Error(`未能从 PATH、常见安装位置或 zsh 配置中定位 ${manager}。请检查服务器的 shell 初始化；也可在“管理器路径”中填写绝对路径。`)
    }
    return posix.normalize(resolved)
  }

  private environmentTarget(config: CondaEnvironmentConfig): { kind: 'name' | 'prefix'; value: string } {
    const name = config.environmentName?.trim()
    const prefix = config.environmentPrefix?.trim()
    if (Boolean(name) === Boolean(prefix)) throw new Error('请填写 Conda 环境名或前缀路径其中一项')
    if (name) return { kind: 'name', value: name }
    return { kind: 'prefix', value: requiredPath(prefix ?? '', 'Conda 环境前缀') }
  }

  private async run(profile: ServerProfile, secrets: ServerSecrets, command: string, timeoutMs: number): Promise<string> {
    if (profile.mode !== 'real') throw new Error('演示节点不支持 Conda 远程操作')
    const connected = await this.ssh.connect(profile, secrets)
    try {
      return await this.ssh.exec(connected.client, command, timeoutMs)
    } finally {
      connected.client.end()
    }
  }
}
