import { execFile, spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ServerProfile, VsCodeRemoteResult } from '../shared/types'
import { getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
import type { AppStore } from './store'

const execFileAsync = promisify(execFile)
const launchCooldownMs = 20_000
const launchingTargets = new Map<string, number>()

const powershellFocusScript = String.raw`
$aliasName = $args[0]
$target = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.ProcessName -eq 'Code' -or $_.ProcessName -eq 'Code - Insiders') -and
  $_.MainWindowHandle -ne 0 -and
  $_.MainWindowTitle -match [regex]::Escape("[SSH: $aliasName]")
} | Select-Object -First 1
if (-not $target) { exit 3 }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LabDeckWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
[LabDeckWindow]::ShowWindowAsync($target.MainWindowHandle, 9) | Out-Null
[LabDeckWindow]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
exit 0
`

export function vscodeSshAlias(serverId: string): string {
  return `labdeck-${serverId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
}

export function vscodeRouteSshAlias(serverId: string, accessRouteId?: string): string {
  const base = vscodeSshAlias(serverId)
  if (!accessRouteId || accessRouteId === 'direct') return base
  return `${base}-${accessRouteId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
}

export function vscodeCliPath(path: string): string {
  if (/[/\\]bin[/\\]code(?:-insiders)?\.cmd$/i.test(path)) return path
  if (/[/\\]bin[/\\]code(?:-insiders)?$/i.test(path)) return `${path}.cmd`
  if (/[/\\]Code - Insiders\.exe$/i.test(path)) return join(dirname(path), 'bin', 'code-insiders.cmd')
  if (/[/\\]Code\.exe$/i.test(path)) return join(dirname(path), 'bin', 'code.cmd')
  return path
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function buildWindowsCommand(executable: string, args: string[]): string {
  const command = [quoteWindowsCommandArg(executable), ...args.map(quoteWindowsCommandArg)].join(' ')
  // cmd.exe /c needs an outer pair of quotes when the executable itself is quoted.
  return `"${command}"`
}

function runWindowsCommand(executable: string, args: string[], options: Parameters<typeof execFileAsync>[2] = {}) {
  return execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', buildWindowsCommand(executable, args)], {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: true
  })
}

function sshValue(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/"/g, '\\"')
  return /\s|#/.test(normalized) ? `"${normalized}"` : normalized
}

function renderHost(alias: string, server: Pick<ServerProfile, 'host' | 'port' | 'username' | 'authType' | 'privateKeyPath'>, proxyJump?: string): string[] {
  const lines = [
    `Host ${alias}`,
    `  HostName ${sshValue(server.host)}`,
    `  User ${sshValue(server.username)}`,
    `  Port ${server.port}`
  ]
  if (server.authType === 'privateKey' && server.privateKeyPath) {
    lines.push(`  IdentityFile ${sshValue(server.privateKeyPath)}`, '  IdentitiesOnly yes')
  }
  if (proxyJump) lines.push(`  ProxyJump ${proxyJump}`)
  return lines
}

export function renderManagedSshConfig(servers: ServerProfile[]): string {
  const lines = [
    '# This file is managed by LabDeck. Manual changes may be replaced.',
    '# Passwords and passphrases are never written here.',
    ''
  ]
  for (const server of servers.filter((item) => item.mode === 'real')) {
    // Keep the legacy jumpHost layout stable for existing profiles. New or
    // edited profiles use explicit route aliases below and can expose both
    // paths without overwriting each other.
    if (!server.accessRoutes?.length && server.jumpHost) {
      const alias = vscodeSshAlias(server.id)
      const jumpAlias = `${alias}-jump`
      lines.push(...renderHost(jumpAlias, server.jumpHost), '')
      lines.push(...renderHost(alias, server, jumpAlias), '')
      continue
    }
    for (const route of getAccessRoutes(server)) {
      const alias = vscodeRouteSshAlias(server.id, route.id)
      if (route.kind === 'jump' && route.jumpHost) {
        const jumpAlias = `${alias}-jump`
        lines.push(...renderHost(jumpAlias, route.jumpHost), '')
        lines.push(...renderHost(alias, route, jumpAlias), '')
      } else {
        lines.push(...renderHost(alias, route), '')
      }
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export class VsCodeService {
  private readonly sshDirectory = join(homedir(), '.ssh')
  private readonly sshConfigPath = join(this.sshDirectory, 'config')
  private readonly managedConfigPath = join(this.sshDirectory, 'labdeck-vscode.conf')

  constructor(private readonly store: AppStore) {}

  async openRemote(server: ServerProfile, accessRouteId?: string): Promise<VsCodeRemoteResult> {
    if (process.platform !== 'win32') throw new Error('一键打开 VS Code 目前仅支持 Windows')
    if (server.mode !== 'real') throw new Error('演示节点没有可连接的远程主机')

    const routeId = accessRouteId ?? getDefaultAccessRouteId(server)
    const legacyJump = !server.accessRoutes?.length && Boolean(server.jumpHost) && routeId === 'jump'
    const alias = legacyJump ? vscodeSshAlias(server.id) : vscodeRouteSshAlias(server.id, routeId)
    if (await this.focusExistingWindow(alias)) {
      return { status: 'focused', message: `${server.name} 的 VS Code 远程窗口已切到前台` }
    }

    const lastLaunch = launchingTargets.get(alias) ?? 0
    if (Date.now() - lastLaunch < launchCooldownMs) {
      return { status: 'launching', message: `${server.name} 的 VS Code 远程窗口正在启动` }
    }

    const codeCli = await this.findCodeCli()
    await this.ensureRemoteSshExtension(codeCli)
    await this.updateSshConfig()

    launchingTargets.set(alias, Date.now())
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', buildWindowsCommand(codeCli, ['--new-window', '--remote', `ssh-remote+${alias}`])], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true
    })
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      child.once('spawn', resolveLaunch)
      child.once('error', rejectLaunch)
    }).catch((error) => {
      launchingTargets.delete(alias)
      throw new Error(`无法启动 Visual Studio Code：${error instanceof Error ? error.message : String(error)}`)
    })
    child.unref()
    return {
      status: 'launched',
      message: `正在用 VS Code 连接 ${server.name}`
    }
  }

  private async updateSshConfig(): Promise<void> {
    await mkdir(this.sshDirectory, { recursive: true })
    await writeFile(this.managedConfigPath, renderManagedSshConfig(this.store.listServers()), 'utf8')

    let current = ''
    try {
      current = await readFile(this.sshConfigPath, 'utf8')
    } catch {
      // The main SSH config is created below when it does not exist yet.
    }
    const includePath = this.managedConfigPath.replace(/\\/g, '/')
    const managedComment = '# LabDeck VS Code Remote-SSH targets'
    const body = current
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim()
        return trimmed !== managedComment && !( /^include\s+/i.test(trimmed) && trimmed.toLowerCase().includes(includePath.toLowerCase()) )
      })
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
    const includeBlock = `${managedComment}\nInclude "${includePath}"`
    const nextConfig = body ? `${includeBlock}\n\n${body}\n` : `${includeBlock}\n`
    if (nextConfig !== current.replace(/\r\n/g, '\n')) await writeFile(this.sshConfigPath, nextConfig, 'utf8')
  }

  private async focusExistingWindow(alias: string): Promise<boolean> {
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellFocusScript, alias], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024
      })
      return true
    } catch {
      return false
    }
  }

  private async findCodeCli(): Promise<string> {
    const candidates = [process.env.VSCODE_PATH ? vscodeCliPath(process.env.VSCODE_PATH) : undefined]
      .filter((item): item is string => Boolean(item))
    const installRoots = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)']
    ].filter((item): item is string => Boolean(item))
    for (const root of installRoots) {
      candidates.push(join(root, 'Microsoft VS Code', 'bin', 'code.cmd'))
      candidates.push(join(root, 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'))
    }

    for (const command of ['code', 'code-insiders']) {
      try {
        const { stdout } = await execFileAsync('where.exe', [command], { windowsHide: true, timeout: 3000 })
        for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
          const path = vscodeCliPath(line)
          if (/\.cmd$/i.test(path)) candidates.push(path)
        }
      } catch {
        // Continue with other commands and known installation locations.
      }
    }

    for (const candidate of [...new Set(candidates)]) {
      try {
        await access(candidate)
        return candidate
      } catch {
        // Continue looking for another installation.
      }
    }
    throw new Error('未找到 Visual Studio Code；请先安装 VS Code，或将 code 命令加入 PATH')
  }

  private async ensureRemoteSshExtension(codeCli: string): Promise<void> {
    try {
      const { stdout } = await runWindowsCommand(codeCli, ['--list-extensions'], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      })
      const extensions = String(stdout).split(/\r?\n/).map((item) => item.trim().toLowerCase())
      if (extensions.includes('ms-vscode-remote.remote-ssh')) return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`无法检查 VS Code 扩展：${message}`)
    }
    throw new Error('VS Code 尚未安装 Remote - SSH 扩展（ms-vscode-remote.remote-ssh）')
  }

}
