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
import type { AppStore } from './store'

const execFileAsync = promisify(execFile)

interface ResolvedSshHost {
  alias: string
  host: string
  port: number
  username: string
  identityFile?: string
  proxyJump?: string
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
        alreadyImported: existing.some(
          (server) =>
            server.name === item.alias ||
            (server.host === item.host && server.port === item.port && server.username === item.username)
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
      if (candidate.alreadyImported) {
        skipped.push(candidate.alias)
        continue
      }
      try {
        const jumpHost = candidate.proxyJump
          ? await this.resolveJumpHost(candidate.proxyJump)
          : undefined
        const input: ServerProfileInput = {
          name: candidate.alias,
          host: candidate.host,
          port: candidate.port,
          username: candidate.username,
          authType: candidate.identityFile ? 'privateKey' : 'password',
          privateKeyPath: candidate.identityFile,
          group: 'SSH Config',
          tags: candidate.proxyJump ? ['SSH Config', '跳板机'] : ['SSH Config'],
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
    return {
      alias,
      host,
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
      username,
      identityFile: identityFiles.map((item) => this.expandPath(item)).find(Boolean),
      proxyJump: proxyJumpValue && proxyJumpValue !== 'none' ? proxyJumpValue : undefined
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
