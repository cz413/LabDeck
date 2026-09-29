import { execFile } from 'node:child_process'
import { access, glob, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  JumpHostConfig,
  ServerProfileInput,
  SshConfigCandidate,
  SshConfigImportResult
} from '../shared/types'
import { getAccessRoutes } from '../shared/access-routes'
import type { AppStore } from './store'

const execFileAsync = promisify(execFile)

interface ResolvedSshHost {
  alias: string
  host: string
  port: number
  username: string
  identityFile?: string
  proxyJump?: string
  proxyCommand?: string
}

export class SshConfigService {
  readonly configPath = join(homedir(), '.ssh', 'config')

  constructor(private readonly store: AppStore) {}

  async scan(): Promise<{ configPath: string; candidates: SshConfigCandidate[] }> {
    await access(this.configPath)
    const aliases = await this.collectAliases(this.configPath)
    const resolved = await Promise.allSettled(aliases.map((alias) => this.resolveAlias(alias)))
    const existing = this.store.listServers()
    const candidates = resolved.flatMap((result): SshConfigCandidate[] => {
      if (result.status === 'rejected') return []
      const item = result.value
      return [{
        alias: item.alias,
        host: item.host,
        port: item.port,
        username: item.username,
        identityFile: item.identityFile,
        proxyJump: item.proxyJump,
        proxyCommand: item.proxyCommand,
        alreadyImported: existing.some((server) =>
          server.name === item.alias ||
          (server.host === item.host && server.port === item.port && server.username === item.username) ||
          getAccessRoutes(server).some((route) =>
            route.host === item.host && route.port === item.port && route.username === item.username
          )
        )
      }]
    })
    return { configPath: this.configPath, candidates }
  }

  async importAll(): Promise<SshConfigImportResult> {
    const { candidates } = await this.scan()
    const imported = []
    const skipped: string[] = []

    for (const candidate of candidates) {
      try {
        const servers = this.store.listServers()
        const sameNameOrEndpoint = servers.find((server) =>
          server.name === candidate.alias ||
          (server.host === candidate.host && server.port === candidate.port && server.username === candidate.username)
        )
        const routeOwner = sameNameOrEndpoint ?? servers.find((server) =>
          getAccessRoutes(server).some((route) =>
            route.kind === 'jump' &&
            route.host === candidate.host && route.port === candidate.port && route.username === candidate.username
          )
        )
        const matchingRoute = routeOwner && getAccessRoutes(routeOwner).find((route) =>
          route.host === candidate.host && route.port === candidate.port && route.username === candidate.username
        )
        const hasJumpConfiguration = Boolean(candidate.proxyJump || candidate.proxyCommand)
        if (routeOwner) {
          const sameEndpoint = routeOwner.host === candidate.host && routeOwner.port === candidate.port && routeOwner.username === candidate.username
          const existingJumpRoute = matchingRoute?.kind === 'jump'
          if (hasJumpConfiguration && (sameEndpoint || existingJumpRoute)) {
            const jumpHost = await this.resolveJumpHostForAlias(candidate.alias)
            if (!jumpHost) throw new Error('未能解析 ProxyJump 或 ProxyCommand 中的跳板机')
            imported.push(await this.store.mergeSshConfigJumpHost(routeOwner.id, jumpHost, existingJumpRoute ? matchingRoute?.id : undefined))
          } else {
            skipped.push(candidate.alias)
          }
          continue
        }

        const jumpHost = hasJumpConfiguration ? await this.resolveJumpHostForAlias(candidate.alias) : undefined
        if (hasJumpConfiguration && !jumpHost) throw new Error('未能解析 ProxyJump 或 ProxyCommand 中的跳板机')
        const input: ServerProfileInput = {
          name: candidate.alias,
          host: candidate.host,
          port: candidate.port,
          username: candidate.username,
          authType: candidate.identityFile ? 'privateKey' : 'password',
          privateKeyPath: candidate.identityFile,
          group: 'SSH Config',
          tags: hasJumpConfiguration ? ['SSH Config', '跳板机'] : ['SSH Config'],
          mode: 'real',
          monitorPolicy: 'manual',
          jumpHost
        }
        imported.push(await this.store.saveServer(input))
      } catch (error) {
        console.warn(`SSH Config 条目 ${candidate.alias} 导入失败：`, error)
        skipped.push(candidate.alias)
      }
    }
    return { imported, skipped, configPath: this.configPath }
  }

  async mergeAccessRoute(serverId: string, sourceServerId: string): Promise<ReturnType<AppStore['getServer']>> {
    const source = this.store.getServer(sourceServerId)
    const sourceRoute = getAccessRoutes(source).find((route) => route.kind === 'jump') ?? getAccessRoutes(source)[0]
    if (!sourceRoute) throw new Error('没有可合并的连接路径')

    let jumpHost: JumpHostConfig | undefined
    let resolutionError: unknown
    try {
      jumpHost = await this.resolveJumpHostForAlias(source.name)
    } catch (error) {
      resolutionError = error
    }
    jumpHost ??= sourceRoute.jumpHost ?? source.jumpHost

    if (!jumpHost) {
      const errorDetails = resolutionError instanceof Error ? `：${resolutionError.message}` : ''
      throw new Error(`无法解析“${source.name}”的跳板机信息${errorDetails}。请确认 SSH Config 中的 ProxyJump，或使用 ssh -W %h:%p <跳板机别名> 格式的 ProxyCommand；未执行合并。`)
    }

    return this.store.mergeAccessRoute(serverId, sourceServerId, jumpHost)
  }

  async collectAliases(configPath: string): Promise<string[]> {
    const visited = new Set<string>()
    const aliases = new Set<string>()

    const visit = async (filePath: string): Promise<void> => {
      const normalizedPath = normalize(filePath)
      if (visited.has(normalizedPath)) return
      visited.add(normalizedPath)
      let content: string
      try {
        content = await readFile(normalizedPath, 'utf8')
      } catch {
        return
      }
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/, '').trim()
        if (!line) continue
        const hostMatch = line.match(/^Host\s+(.+)$/i)
        if (hostMatch) {
          for (const alias of this.splitArguments(hostMatch[1])) {
            if (!alias.startsWith('!') && !/[?*]/.test(alias)) aliases.add(alias)
          }
          continue
        }
        const includeMatch = line.match(/^Include\s+(.+)$/i)
        if (includeMatch) {
          for (const pattern of this.splitArguments(includeMatch[1])) {
            const expanded = this.expandPath(pattern)
            const absolutePattern = isAbsolute(expanded)
              ? expanded
              : resolve(dirname(normalizedPath), expanded)
            for await (const includedPath of glob(absolutePattern)) await visit(includedPath)
          }
        }
      }
    }

    await visit(configPath)
    return [...aliases]
  }

  parseSshG(alias: string, output: string): ResolvedSshHost {
    const values = new Map<string, string[]>()
    for (const line of output.split(/\r?\n/)) {
      const separator = line.indexOf(' ')
      if (separator <= 0) continue
      const key = line.slice(0, separator).toLowerCase()
      const value = line.slice(separator + 1).trim()
      values.set(key, [...(values.get(key) ?? []), value])
    }
    const host = values.get('hostname')?.[0] ?? alias
    const port = Number(values.get('port')?.[0] ?? 22)
    const username = values.get('user')?.[0] ?? process.env.USERNAME ?? ''
    const identityFiles = values.get('identityfile') ?? []
    const proxyJumpValue = values.get('proxyjump')?.[0]
    const proxyCommandValue = values.get('proxycommand')?.[0]
    return {
      alias,
      host,
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
      username,
      identityFile: identityFiles.map((item) => this.expandPath(item)).find(Boolean),
      proxyJump: proxyJumpValue && proxyJumpValue !== 'none' ? proxyJumpValue : undefined,
      proxyCommand: proxyCommandValue && proxyCommandValue !== 'none' ? proxyCommandValue : undefined
    }
  }

  private async resolveAlias(alias: string): Promise<ResolvedSshHost> {
    const { stdout } = await execFileAsync('ssh', ['-G', alias], {
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    })
    const resolved = this.parseSshG(alias, stdout)
    const identityFiles = stdout
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().startsWith('identityfile '))
      .map((line) => this.expandPath(line.slice(line.indexOf(' ') + 1).trim()))
    resolved.identityFile = await this.firstExistingFile(identityFiles)
    return resolved
  }

  private async resolveJumpHostForAlias(alias: string): Promise<JumpHostConfig | undefined> {
    const resolved = await this.resolveAlias(alias)
    if (resolved.proxyJump) return this.resolveJumpHost(resolved.proxyJump)
    if (resolved.proxyCommand) {
      const jumpAlias = this.proxyCommandJumpAlias(resolved.proxyCommand)
      if (!jumpAlias) {
        throw new Error(`不支持此 ProxyCommand 格式：“${resolved.proxyCommand}”`)
      }
      return this.resolveJumpHost(jumpAlias)
    }
    return undefined
  }

  private async resolveJumpHost(proxyJump: string): Promise<JumpHostConfig> {
    const firstHop = proxyJump.split(',')[0].trim()
    if (!firstHop) throw new Error('ProxyJump 配置为空')
    const resolved = await this.resolveAlias(firstHop)
    return {
      host: resolved.host,
      port: resolved.port,
      username: resolved.username,
      authType: resolved.identityFile ? 'privateKey' : 'password',
      privateKeyPath: resolved.identityFile,
      hasSecret: false
    }
  }

  private proxyCommandJumpAlias(proxyCommand: string): string | undefined {
    const args = this.splitArguments(proxyCommand)
    const executable = args[0]?.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase()
    if (executable !== 'ssh') return undefined
    const streamLocalIndex = args.findIndex((arg) => arg.toLowerCase() === '-w')
    if (streamLocalIndex < 0 || args[streamLocalIndex + 1] !== '%h:%p') return undefined

    let index = streamLocalIndex + 2
    const optionsWithValues = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-w'])
    while (index < args.length) {
      const arg = args[index]
      if (arg === '--') return args[index + 1]
      if (!arg.startsWith('-')) return arg.includes('%') ? undefined : arg
      index += optionsWithValues.has(arg) ? 2 : 1
    }
    return undefined
  }

  private async firstExistingFile(paths: string[]): Promise<string | undefined> {
    for (const path of paths) {
      try {
        await access(path)
        return path
      } catch {
        // Continue to the next IdentityFile emitted by OpenSSH.
      }
    }
    return undefined
  }

  private expandPath(path: string): string {
    const unquoted = path.replace(/^['"]|['"]$/g, '')
    if (unquoted === '~') return homedir()
    if (unquoted.startsWith('~/') || unquoted.startsWith('~\\')) {
      return join(homedir(), unquoted.slice(2))
    }
    return unquoted.replace(/%d/g, homedir())
  }

  private splitArguments(value: string): string[] {
    return [...value.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map(
      (match) => match[1] ?? match[2] ?? match[3]
    )
  }
}
