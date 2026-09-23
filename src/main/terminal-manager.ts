import { StringDecoder } from 'node:string_decoder'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ClientChannel } from 'ssh2'
import { spawn as spawnPty, type IDisposable, type IPty } from 'node-pty'
import type { ServerProfile, TerminalConnectResult } from '../shared/types'
import type { ServerSecrets } from './store'
import { SshService } from './ssh-service'

interface TerminalSession {
  write(data: string): void
  writeStoredPassword?(): boolean
  resize(cols: number, rows: number): void
  close(): Promise<void>
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>()

  constructor(
    private readonly ssh: SshService,
    private readonly webContents: () => WebContents | null
  ) {}

  async connect(
    profile: ServerProfile,
    secrets: ServerSecrets,
    cols: number,
    rows: number
  ): Promise<TerminalConnectResult> {
    if (profile.mode === 'demo') {
      return { status: 'failed', message: '演示节点不建立真实终端，请添加真实服务器' }
    }
    if (!profile.hostFingerprint || (profile.jumpHost && !profile.jumpHost.hostFingerprint)) {
      try {
        const required = await this.ssh.scanRequiredHostKey(profile, secrets)
        return {
          status: 'host-key-required',
          fingerprint: required.fingerprint,
          hostKeyTarget: required.target,
          message:
            required.target === 'jumpHost'
              ? '首次连接，请核对并信任跳板机主机指纹'
              : '首次连接，请核对并信任目标服务器主机指纹'
        }
      } catch (error) {
        return { status: 'failed', message: this.message(error) }
      }
    }

    try {
      const connected = await this.ssh.connect(profile, secrets)
      const client = connected.client
      const stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => {
          if (error) reject(error)
          else resolve(channel)
        })
      })
      const sessionId = randomUUID()
      const decoder = new StringDecoder('utf8')
      let ended = false

      const finishSession = (code: number | null, signal?: string): void => {
        if (ended) return
        ended = true
        const remaining = decoder.end()
        if (remaining) this.webContents()?.send('terminal:data', { sessionId, data: remaining })
        this.webContents()?.send('terminal:exit', { sessionId, code, signal })
        client.end()
        this.sessions.delete(sessionId)
      }

      const session: TerminalSession = {
        write: (data) => stream.write(data),
        writeStoredPassword: secrets.password
          ? () => {
              stream.write(`${secrets.password!.replace(/[\r\n]/g, '')}\n`)
              return true
            }
          : undefined,
        resize: (nextCols, nextRows) => stream.setWindow(nextRows, nextCols, 0, 0),
        close: async () => {
          if (ended) return
          ended = true
          stream.close()
          client.end()
          this.sessions.delete(sessionId)
        }
      }
      this.sessions.set(sessionId, session)

      stream.on('data', (chunk: Buffer) => {
        this.webContents()?.send('terminal:data', { sessionId, data: decoder.write(chunk) })
      })
      stream.on('close', (code: number | null, signal: string) => {
        finishSession(code, signal)
      })
      stream.on('error', (error: unknown) => {
        this.webContents()?.send('terminal:data', {
          sessionId,
          data: `\r\n\x1b[31m终端通道中断：${this.message(error)}\x1b[0m\r\n`
        })
        finishSession(null)
      })
      client.on('error', (error) => {
        this.webContents()?.send('terminal:data', {
          sessionId,
          data: `\r\n\x1b[31m连接错误：${this.message(error)}\x1b[0m\r\n`
        })
      })
      return { status: 'connected', sessionId, canAutofillPassword: Boolean(secrets.password) }
    } catch (error) {
      return { status: 'failed', message: this.message(error) }
    }
  }

  connectLocal(cols: number, rows: number): TerminalConnectResult {
    try {
      const shell = this.localShell()
      const pty = spawnPty(shell.executable, shell.args, {
        name: 'xterm-256color',
        cols: Math.max(2, cols),
        rows: Math.max(1, rows),
        cwd: homedir(),
        env: { ...process.env, TERM: 'xterm-256color' },
        useConpty: process.platform === 'win32'
      })
      return this.registerLocalSession(pty)
    } catch (error) {
      return { status: 'failed', message: `本地终端启动失败：${this.message(error)}` }
    }
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write(data)
  }

  autofillPassword(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.writeStoredPassword?.() ?? false
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.resize(Math.max(2, cols), Math.max(1, rows))
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    void session.close()
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()]
    await Promise.allSettled(sessions.map((session) => session.close()))
  }

  private registerLocalSession(pty: IPty): TerminalConnectResult {
    const sessionId = randomUUID()
    let ended = false
    let closing = false
    let closePromise: Promise<void> | null = null
    let resolveClose: (() => void) | null = null
    let forceTimer: NodeJS.Timeout | null = null
    const dataDisposable = pty.onData((data) => {
      this.webContents()?.send('terminal:data', { sessionId, data })
    })
    let exitDisposable: IDisposable | null = null
    exitDisposable = pty.onExit(({ exitCode, signal }) => {
      if (ended) return
      ended = true
      if (forceTimer) clearTimeout(forceTimer)
      this.sessions.delete(sessionId)
      dataDisposable.dispose()
      exitDisposable?.dispose()
      if (!closing) {
        this.webContents()?.send('terminal:exit', {
          sessionId,
          code: exitCode,
          signal: signal === undefined ? undefined : String(signal)
        })
      }
      resolveClose?.()
    })
    const session: TerminalSession = {
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      close: async () => {
        if (ended) return
        if (closePromise) return closePromise
        closing = true
        this.sessions.delete(sessionId)
        dataDisposable.dispose()
        closePromise = new Promise<void>((resolve) => {
          resolveClose = resolve
        })

        try {
          if (process.platform === 'win32') {
            pty.write('\x03')
            setTimeout(() => {
              if (!ended) pty.write('exit\r')
            }, 40)
          } else {
            pty.kill()
          }
        } catch {
          ended = true
          exitDisposable?.dispose()
          resolveClose?.()
        }
        forceTimer = setTimeout(() => {
          if (ended) return
          try {
            pty.kill()
          } catch {
            ended = true
            exitDisposable?.dispose()
            resolveClose?.()
          }
          setTimeout(() => {
            if (ended) return
            ended = true
            exitDisposable?.dispose()
            resolveClose?.()
          }, 350)
        }, 1200)
        return closePromise
      }
    }
    this.sessions.set(sessionId, session)
    return { status: 'connected', sessionId }
  }

  private localShell(): { executable: string; args: string[] } {
    if (process.platform !== 'win32') {
      return { executable: process.env.SHELL || '/bin/bash', args: ['-l'] }
    }

    const pwsh = process.env.ProgramFiles
      ? join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')
      : ''
    if (pwsh && existsSync(pwsh)) return { executable: pwsh, args: ['-NoLogo'] }

    const windowsPowerShell = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    return {
      executable: existsSync(windowsPowerShell) ? windowsPowerShell : 'powershell.exe',
      args: ['-NoLogo']
    }
  }

  private message(error: unknown): string {
    if (!(error instanceof Error)) return '终端连接失败'
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ECONNRESET' || error.message.includes('ECONNRESET')) return '连接被远端重置，请检查网络或端口转发'
    if (code === 'EPIPE') return '连接已关闭，请重新连接'
    return error.message
  }
}
