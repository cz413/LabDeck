import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client } from 'ssh2'
import { applyAccessRoute, getAccessRoutes } from '../shared/access-routes'
import type { TunnelConfig, TunnelStartResult, TunnelView } from '../shared/types'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'

interface Runtime {
  view: TunnelView
  wanted: boolean
  attempt: number
  retryCount: number
  abort?: AbortController
  client?: Client
  listener?: Server
  streams: Set<Duplex>
  retryTimer?: NodeJS.Timeout
  onClose?: () => void
  onError?: (error: Error) => void
}

const stoppedView = (config: TunnelConfig): TunnelView => ({ ...config, status: 'stopped', serviceStatus: 'unknown', message: '', connectionCount: 0 })
const message = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EADDRINUSE') return '监听端口已被占用，请停止占用程序或修改端口'
  if (code === 'EACCES') return '没有权限监听该地址或端口，请修改监听配置'
  if (code === 'ECONNREFUSED') return '目标端口拒绝连接，请确认服务已启动'
  return error instanceof Error ? error.message : String(error)
}

// Cancellation and deadlines also cover callbacks that SSH never answers. Late
// resources must be closed, rather than becoming unowned listeners/channels.
function guarded<T>(promise: Promise<T>, signal: AbortSignal, late: (value: T) => void = () => {}, timeout = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve(value as T)
    }
    const cancel = (): void => finish(new Error('隧道操作已取消'))
    const timer = setTimeout(() => finish(new Error('隧道连接超时，请检查网络和服务器转发权限')), timeout)
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(value => { if (settled) late(value); else finish(undefined, value) }, error => finish(error))
    if (signal.aborted) cancel()
  })
}

export class TunnelManager {
  private readonly runtimes = new Map<string, Runtime>()
  private disposed = false

  constructor(private readonly store: Pick<AppStore, 'listTunnels' | 'getTunnel' | 'getServer' | 'getSecrets'>,
    private readonly ssh: Pick<SshService, 'connect' | 'scanRequiredHostKey'>,
    private readonly changed: () => void) {}

  list(): TunnelView[] {
    return this.store.listTunnels().map(config => {
      const runtime = this.runtimes.get(config.id)
      return structuredClone(runtime ? { ...runtime.view, ...config } : stoppedView(config))
    })
  }

  assertEditable(id?: string): void {
    if (id && this.runtimes.get(id)?.wanted) throw new Error('请先停止隧道，再修改配置')
  }

  forget(id: string): void { this.stop(id); this.runtimes.delete(id); this.changed() }

  stopForServer(serverId: string): void {
    for (const [id, runtime] of this.runtimes) if (runtime.view.serverId === serverId) this.stop(id)
  }

  async start(id: string): Promise<TunnelStartResult> {
    if (this.disposed) return { status: 'failed', message: '应用正在退出' }
    const config = this.store.getTunnel(id)
    if (this.runtimes.get(id)?.wanted) return { status: 'failed', message: '隧道已经启动或正在连接' }
    const runtime: Runtime = { view: { ...stoppedView(config), status: 'starting' }, wanted: true, attempt: 0, retryCount: 0, streams: new Set() }
    this.runtimes.set(id, runtime)
    this.changed()
    return this.establish(runtime, true)
  }

  stop(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.wanted = false
    runtime.attempt++
    clearTimeout(runtime.retryTimer)
    runtime.retryTimer = undefined
    this.cleanup(runtime)
    Object.assign(runtime.view, { status: 'stopped', serviceStatus: 'unknown', message: '', connectionCount: 0, startedAt: undefined })
    this.changed()
  }

  closeAll(): void {
    this.disposed = true
    for (const id of this.runtimes.keys()) this.stop(id)
  }

  async autoStart(): Promise<void> {
    for (const config of this.store.listTunnels()) {
      if (this.disposed) break
      if (config.autoStart) await this.start(config.id)
    }
  }

  private cleanup(runtime: Runtime): void {
    runtime.abort?.abort()
    runtime.abort = undefined
    if (runtime.client) {
      if (runtime.onClose) runtime.client.removeListener('close', runtime.onClose)
      if (runtime.onError) runtime.client.removeListener('error', runtime.onError)
      // Keep an error sink while an SSH transport is shutting down.
      runtime.client.on('error', () => {})
      runtime.client.destroy()
      runtime.client = undefined
    }
    for (const stream of runtime.streams) stream.destroy()
    runtime.streams.clear()
    runtime.listener?.close()
    runtime.listener = undefined
    runtime.view.connectionCount = 0
  }

  private failed(runtime: Runtime, attempt: number, error: unknown, reconnect: boolean): void {
    if (!runtime.wanted || runtime.attempt !== attempt) return
    runtime.attempt++
    this.cleanup(runtime)
    runtime.view.message = message(error)
    runtime.view.serviceStatus = 'unknown'
    runtime.view.startedAt = undefined
    // Configuration/identity/permission errors need an explicit user action.
    const retryable = reconnect && runtime.view.autoReconnect && !/指纹|路径不存在|演示|服务器不存在|认证|authentication|permission|administratively|被占用|没有权限/i.test(runtime.view.message)
    runtime.view.status = retryable ? 'reconnecting' : 'error'
    if (retryable) {
      const delay = Math.min(30_000, 2000 * 2 ** Math.min(runtime.retryCount++, 4))
      runtime.retryTimer = setTimeout(() => {
        runtime.retryTimer = undefined
        if (runtime.wanted && !this.disposed) void this.establish(runtime, false)
      }, delay)
    } else runtime.wanted = false
    this.changed()
  }

  private async establish(runtime: Runtime, initial: boolean): Promise<TunnelStartResult> {
    const attempt = ++runtime.attempt
    const controller = new AbortController()
    runtime.abort = controller
    const current = (): boolean => runtime.wanted && runtime.attempt === attempt && !controller.signal.aborted
    try {
      const config = runtime.view
      const server = this.store.getServer(config.serverId)
      if (server.mode !== 'real') throw new Error('演示节点不能创建 SSH 隧道')
      if (!getAccessRoutes(server).some(route => route.id === config.accessRouteId)) throw new Error('连接路径不存在，请重新选择')
      const profile = applyAccessRoute(server, config.accessRouteId)
      const secrets = this.store.getSecrets(config.serverId)
      if (!profile.hostFingerprint || (profile.jumpHost && !profile.jumpHost.hostFingerprint)) {
        if (!initial) throw new Error('需要先确认 SSH 主机指纹，再重新启动隧道')
        const required = await guarded(this.ssh.scanRequiredHostKey(profile, secrets), controller.signal)
        if (!current()) throw new Error('隧道操作已取消')
        this.failed(runtime, attempt, new Error('需要确认 SSH 主机指纹'), false)
        return { status: 'host-key-required', fingerprint: required.fingerprint, hostKeyTarget: required.target, message: '请核对并信任主机指纹后继续' }
      }
      const connected = await guarded(this.ssh.connect(profile, secrets), controller.signal, value => value.client.destroy(), 25_000)
      if (!current()) { connected.client.destroy(); throw new Error('隧道操作已取消') }
      const client = runtime.client = connected.client
      runtime.onClose = () => this.failed(runtime, attempt, new Error('SSH 连接已断开'), true)
      runtime.onError = error => this.failed(runtime, attempt, error, true)
      client.once('close', runtime.onClose)
      client.once('error', runtime.onError)
      if (config.type === 'local') {
        const listener = runtime.listener = createServer(socket => {
          this.track(runtime, socket)
          void this.forward(runtime, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0).then(channel => {
            if (!current() || socket.destroyed) { channel.destroy(); return }
            this.bridge(runtime, socket, channel)
          }).catch(error => {
            if (current()) this.serviceResult(runtime, false, message(error))
            socket.destroy()
          })
        })
        await guarded(new Promise<void>((resolve, reject) => {
          listener.once('error', reject)
          listener.listen({ host: config.bindAddress, port: config.bindPort, exclusive: true }, () => {
            listener.removeListener('error', reject)
            resolve()
          })
        }), controller.signal)
        listener.on('error', error => this.failed(runtime, attempt, error, false))
      } else {
        client.on('tcp connection', (details, accept, reject) => {
          if (!current() || details.destIP !== config.bindAddress || details.destPort !== config.bindPort) { reject(); return }
          const socket = createConnection({ host: config.targetHost, port: config.targetPort })
          let accepted = false
          this.track(runtime, socket)
          socket.setTimeout(10_000, () => socket.destroy(new Error('本机目标端口连接超时')))
          socket.once('connect', () => {
            socket.setTimeout(0)
            if (!current()) { socket.destroy(); reject(); return }
            accepted = true
            this.bridge(runtime, socket, accept())
          })
          socket.once('error', error => { if (!accepted) reject(); if (current()) this.serviceResult(runtime, false, message(error)) })
        })
        await guarded(new Promise<void>((resolve, reject) => client.forwardIn(config.bindAddress, config.bindPort, error => {
          if (error) reject(new Error(`远程监听失败：${error.message}。请检查端口占用及 SSH 转发权限`))
          else resolve()
        })), controller.signal)
      }
      if (!current()) throw new Error('隧道操作已取消')
      Object.assign(runtime.view, { status: 'running', message: '', serviceStatus: 'unknown', startedAt: new Date().toISOString() })
      runtime.retryCount = 0
      this.changed()
      return { status: 'started', message: '转发已启动；目标服务可单独检测' }
    } catch (error) {
      this.failed(runtime, attempt, error, !initial)
      return { status: 'failed', message: message(error) }
    }
  }

  private track(runtime: Runtime, stream: Duplex): void {
    runtime.streams.add(stream)
    stream.on('error', () => {})
    stream.once('close', () => runtime.streams.delete(stream))
  }

  private async forward(runtime: Runtime, sourceHost = '127.0.0.1', sourcePort = 0): Promise<Duplex> {
    const client = runtime.client
    const signal = runtime.abort?.signal
    if (!client || !signal) throw new Error('隧道尚未连接')
    return guarded(new Promise<Duplex>((resolve, reject) => client.forwardOut(sourceHost, sourcePort, runtime.view.targetHost, runtime.view.targetPort, (error, channel) => {
      if (error) reject(error)
      else { this.track(runtime, channel); resolve(channel) }
    })), signal, stream => stream.destroy(), 10_000)
  }

  private bridge(runtime: Runtime, socket: Socket, channel: Duplex): void {
    const attempt = runtime.attempt
    this.track(runtime, channel)
    runtime.view.connectionCount++
    this.serviceResult(runtime, true, '')
    let closed = false
    const finish = (): void => {
      if (closed) return
      closed = true
      socket.destroy()
      channel.destroy()
      if (runtime.attempt === attempt) {
        runtime.view.connectionCount = Math.max(0, runtime.view.connectionCount - 1)
        this.changed()
      }
    }
    socket.once('error', finish)
    channel.once('error', finish)
    socket.once('close', finish)
    channel.once('close', finish)
    socket.pipe(channel).pipe(socket)
  }

  private serviceResult(runtime: Runtime, reachable: boolean, detail: string): void {
    runtime.view.serviceStatus = reachable ? 'reachable' : 'unreachable'
    runtime.view.message = detail
    this.changed()
  }

  async checkTarget(id: string): Promise<{ reachable: boolean; message: string }> {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.view.status !== 'running') throw new Error('请先启动隧道')
    const attempt = runtime.attempt
    try {
      if (runtime.view.type === 'local') (await this.forward(runtime)).destroy()
      else {
        const socket = createConnection({ host: runtime.view.targetHost, port: runtime.view.targetPort })
        this.track(runtime, socket)
        try {
          await guarded(new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) }), runtime.abort!.signal, undefined, 10_000)
        } finally { socket.destroy() }
      }
      if (!runtime.wanted || runtime.attempt !== attempt) throw new Error('隧道已停止或重新连接')
      this.serviceResult(runtime, true, '')
      return { reachable: true, message: '目标 TCP 端口可达；应用登录与响应请在客户端确认' }
    } catch (error) {
      if (runtime.wanted && runtime.attempt === attempt) this.serviceResult(runtime, false, message(error))
      return { reachable: false, message: message(error) }
    }
  }

  browserUrl(id: string): string {
    const view = this.runtimes.get(id)?.view
    if (!view || view.status !== 'running' || view.type !== 'local' || view.browserProtocol === 'none') throw new Error('仅运行中的本地网页转发可以打开浏览器')
    const host = view.bindAddress === '0.0.0.0' ? '127.0.0.1' : view.bindAddress === '::' ? '::1' : view.bindAddress
    return `${view.browserProtocol}://${host.includes(':') ? `[${host}]` : host}:${view.bindPort}`
  }
}
