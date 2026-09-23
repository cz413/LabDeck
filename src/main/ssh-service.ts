import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import { Client, type ConnectConfig } from 'ssh2'
import type {
  ConnectionTestResult,
  JumpHostConfig,
  ServerProfile
} from '../shared/types'
import type { ServerSecrets } from './store'

export interface ConnectedClient {
  client: Client
  latencyMs: number
}

export interface RequiredHostKey {
  fingerprint: string
  target: 'server' | 'jumpHost'
}

export class SshService {
  async scanRequiredHostKey(
    profile: ServerProfile,
    secrets: ServerSecrets
  ): Promise<RequiredHostKey> {
    if (profile.jumpHost && !profile.jumpHost.hostFingerprint) {
      return {
        fingerprint: await this.scanEndpoint(profile.jumpHost.host, profile.jumpHost.port),
        target: 'jumpHost'
      }
    }
    if (!profile.hostFingerprint) {
      if (!profile.jumpHost) {
        return {
          fingerprint: await this.scanEndpoint(profile.host, profile.port),
          target: 'server'
        }
      }
      const jumpConfig = await this.createJumpConfig(profile.jumpHost, secrets)
      const jump = await this.connectEndpoint(jumpConfig, profile.jumpHost.hostFingerprint!)
      try {
        const socket = await this.forwardOut(jump.client, profile.host, profile.port)
        return {
          fingerprint: await this.scanEndpoint(profile.host, profile.port, socket),
          target: 'server'
        }
      } finally {
        jump.client.end()
      }
    }
    throw new Error('服务器和跳板机主机指纹均已保存')
  }

  async testConnection(
    profile: ServerProfile,
    secrets: ServerSecrets
  ): Promise<ConnectionTestResult> {
    if (profile.mode === 'demo') {
      return { status: 'success', latencyMs: 18, message: '演示节点连接正常' }
    }
    if (!profile.hostFingerprint || (profile.jumpHost && !profile.jumpHost.hostFingerprint)) {
      try {
        const required = await this.scanRequiredHostKey(profile, secrets)
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
        return { status: 'failed', message: this.errorMessage(error) }
      }
    }

    try {
      const connected = await this.connect(profile, secrets)
      await this.exec(connected.client, 'printf lab-server-manager-ready', 5000)
      connected.client.end()
      return {
        status: 'success',
        latencyMs: Math.round(connected.latencyMs),
        message: profile.jumpHost
          ? '跳板机、目标服务器和只读命令执行正常'
          : 'SSH 连接和只读命令执行正常'
      }
    } catch (error) {
      return { status: 'failed', message: this.errorMessage(error) }
    }
  }

  async connect(profile: ServerProfile, secrets: ServerSecrets): Promise<ConnectedClient> {
    const targetConfig = await this.createTargetConfig(profile, secrets)
    if (!profile.jumpHost) return this.connectEndpoint(targetConfig, profile.hostFingerprint!)
    if (!profile.jumpHost.hostFingerprint) throw new Error('尚未信任跳板机主机指纹')
    if (!profile.hostFingerprint) throw new Error('尚未信任目标服务器主机指纹')

    const startedAt = performance.now()
    const jumpConfig = await this.createJumpConfig(profile.jumpHost, secrets)
    const jump = await this.connectEndpoint(jumpConfig, profile.jumpHost.hostFingerprint)
    try {
      const socket = await this.forwardOut(jump.client, profile.host, profile.port)
      const target = await this.connectEndpoint(
        { ...targetConfig, sock: socket },
        profile.hostFingerprint
      )
      target.client.once('close', () => jump.client.end())
      target.client.once('error', () => jump.client.end())
      return { client: target.client, latencyMs: performance.now() - startedAt }
    } catch (error) {
      jump.client.end()
      throw error
    }
  }

  exec(client: Client, command: string, timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      let completed = false
      const timer = setTimeout(() => {
        if (completed) return
        completed = true
        reject(new Error('远程命令执行超时'))
      }, timeoutMs)
      client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timer)
          completed = true
          reject(error)
          return
        }
        const chunks: Buffer[] = []
        const errorChunks: Buffer[] = []
        const fail = (streamError: Error): void => {
          if (completed) return
          completed = true
          clearTimeout(timer)
          reject(streamError)
        }
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('error', fail)
        stream.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk))
        stream.stderr.on('error', fail)
        stream.on('close', (code: number | null) => {
          if (completed) return
          completed = true
          clearTimeout(timer)
          if (code && code !== 0) {
            reject(new Error(Buffer.concat(errorChunks).toString('utf8') || `命令退出码 ${code}`))
          } else {
            resolve(Buffer.concat(chunks).toString('utf8'))
          }
        })
      })
    })
  }

  private scanEndpoint(host: string, port: number, sock?: Duplex): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let fingerprint = ''
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        client.end()
        if (fingerprint) resolve(fingerprint)
        else reject(error ?? new Error('无法读取 SSH 主机指纹'))
      }

      client
        .on('ready', () => finish())
        .on('error', (error) => finish(error))
        .on('close', () => finish(new Error('连接在获取主机指纹前关闭')))
        .connect({
          host,
          port,
          sock,
          username: '__lab_manager_hostkey_scan__',
          readyTimeout: 8000,
          hostHash: 'sha256',
          hostVerifier: (keyHash: string) => {
            fingerprint = `SHA256:${keyHash}`
            return true
          }
        })
    })
  }

  private connectEndpoint(config: ConnectConfig, expectedFingerprint: string): Promise<ConnectedClient> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      const startedAt = performance.now()
      let actualFingerprint = ''
      let settled = false
      client
        .on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
          const password = typeof config.password === 'string' ? config.password : ''
          finish(prompts.map(() => password))
        })
        .once('ready', () => {
          settled = true
          resolve({ client, latencyMs: performance.now() - startedAt })
        })
        .on('error', (error) => {
          if (settled) {
            console.warn('SSH 连接在建立后中断：', this.errorMessage(error))
            return
          }
          settled = true
          if (actualFingerprint && `SHA256:${actualFingerprint}` !== expectedFingerprint) {
            reject(
              new Error(
                `SSH 主机指纹发生变化。期望 ${expectedFingerprint}，实际 SHA256:${actualFingerprint}`
              )
            )
          } else reject(error)
        })
        .connect({
          ...config,
          hostHash: 'sha256',
          hostVerifier: (keyHash: string) => {
            actualFingerprint = keyHash
            return `SHA256:${keyHash}` === expectedFingerprint
          }
        })
    })
  }

  private forwardOut(client: Client, host: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
        if (error) reject(error)
        else {
          stream.on('error', (streamError: unknown) => console.warn('SSH 转发通道中断：', this.errorMessage(streamError)))
          resolve(stream)
        }
      })
    })
  }

  private async createTargetConfig(
    profile: ServerProfile,
    secrets: ServerSecrets
  ): Promise<ConnectConfig> {
    return this.createAuthConfig(
      profile.host,
      profile.port,
      profile.username,
      profile.authType,
      profile.privateKeyPath,
      secrets.password,
      secrets.passphrase,
      '目标服务器'
    )
  }

  private async createJumpConfig(
    jump: JumpHostConfig,
    secrets: ServerSecrets
  ): Promise<ConnectConfig> {
    return this.createAuthConfig(
      jump.host,
      jump.port,
      jump.username,
      jump.authType,
      jump.privateKeyPath,
      secrets.jumpPassword,
      secrets.jumpPassphrase,
      '跳板机'
    )
  }

  private async createAuthConfig(
    host: string,
    port: number,
    username: string,
    authType: 'password' | 'privateKey',
    privateKeyPath: string | undefined,
    password: string | undefined,
    passphrase: string | undefined,
    label: string
  ): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host,
      port,
      username,
      readyTimeout: 10000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3
    }
    if (authType === 'password') {
      if (!password) throw new Error(`${label}未保存 SSH 密码，请编辑认证信息`)
      config.password = password
      config.tryKeyboard = true
    } else {
      if (!privateKeyPath) throw new Error(`${label}未找到可用 SSH 私钥，请编辑认证信息`)
      config.privateKey = await readFile(privateKeyPath)
      if (passphrase) config.passphrase = passphrase
    }
    return config
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNRESET' || error.message.includes('ECONNRESET')) {
        return 'SSH 连接被远端重置，请检查网络、端口转发或服务器连接限制'
      }
      if (code === 'EPIPE') return 'SSH 连接已关闭，请重新连接'
      if (error.message.includes('All configured authentication methods failed')) {
        return 'SSH 认证失败，请检查用户名、密码或私钥'
      }
      if (error.message.includes('Timed out')) return 'SSH 连接超时，请检查地址、端口和网络'
      return error.message
    }
    return '未知 SSH 错误'
  }
}
