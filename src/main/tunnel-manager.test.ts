import { EventEmitter } from 'node:events'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client } from 'ssh2'
import { Server as SshServer, utils } from 'ssh2'
import { createHash } from 'node:crypto'
import { SshService } from './ssh-service'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerProfile, TunnelConfig } from '../shared/types'
import { tunnelConfigInputSchema } from '../shared/schemas'
import { TunnelManager } from './tunnel-manager'

const serverId = '11111111-1111-4111-8111-111111111111'
const tunnelId = '22222222-2222-4222-8222-222222222222'
const servers = new Set<Server>()
const sockets = new Set<Socket>()
const managers = new Set<TunnelManager>()
const track = (socket: Socket): Socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket }
async function listen(server = createServer(), port = 0): Promise<number> {
  servers.add(server)
  server.on('connection', track)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return (server.address() as { port: number }).port
}
async function unusedPort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
async function echoPort(): Promise<number> { return listen(createServer(socket => socket.pipe(socket))) }
async function exchange(port: number): Promise<string> {
  const socket = track(createConnection(port, '127.0.0.1'))
  return new Promise((resolve, reject) => {
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('echo timeout')) })
    socket.once('error', reject)
    socket.once('connect', () => socket.write('LabDeck 多段\nforwarding\n'))
    socket.once('data', data => { socket.destroy(); resolve(data.toString()) })
  })
}

class FakeClient extends EventEmitter {
  destroyed = false
  remote?: Server
  forwardOut = vi.fn((_sourceHost: string, _sourcePort: number, host: string, port: number, callback: (error: Error | undefined, channel: Duplex) => void) => {
    const socket = track(createConnection(port, host))
    socket.once('connect', () => callback(undefined, socket))
    socket.once('error', error => callback(error, socket))
  })
  forwardIn = vi.fn((host: string, port: number, callback: (error?: Error) => void) => {
    this.remote = createServer(socket => this.emit('tcp connection', { destIP: host, destPort: port }, () => socket, () => socket.destroy()))
    void listen(this.remote, port).then(() => callback(), callback)
  })
  destroy = vi.fn(() => {
    if (this.destroyed) return this
    this.destroyed = true
    this.remote?.close()
    this.emit('close')
    return this
  })
}

async function fixture(type: 'local' | 'remote' = 'local', targetPort = 9) {
  const profile: ServerProfile = { id: serverId, name: 'test', host: '127.0.0.1', port: 22, username: 'test', authType: 'password', hostFingerprint: 'SHA256:test', mode: 'real', monitorPolicy: 'manual', hasSecret: true, tags: [], group: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const config: TunnelConfig = { id: tunnelId, serverId, name: 'test forward', type, bindAddress: '127.0.0.1', bindPort: await unusedPort(), targetHost: '127.0.0.1', targetPort, accessRouteId: 'direct', browserProtocol: 'http', autoStart: false, autoReconnect: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const clients: FakeClient[] = []
  const ssh = {
    connect: vi.fn(async () => { const client = new FakeClient(); clients.push(client); return { client: client as unknown as Client, latencyMs: 1 } }),
    scanRequiredHostKey: vi.fn(async () => ({ target: 'server' as const, fingerprint: 'SHA256:untrusted' }))
  }
  const store = { listTunnels: () => [config], getTunnel: () => config, getServer: () => profile, getSecrets: () => ({ password: 'fixture' }) }
  const changed = vi.fn()
  const manager = new TunnelManager(store, ssh, changed)
  managers.add(manager)
  return { profile, config, clients, ssh, store, manager, changed }
}

afterEach(async () => {
  for (const manager of managers) manager.closeAll()
  managers.clear()
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all([...servers].map(server => new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve() })))
  servers.clear()
  vi.useRealTimers()
})

describe('SSH tunnels', () => {
  it.each(['local', 'remote', 'jump'] as const)('transfers bytes over a real SSH connection: %s', async kind => {
    const key = utils.generateKeyPairSync('ed25519')
    const parsedKey = utils.parseKey(key.private)
    if (parsedKey instanceof Error || Array.isArray(parsedKey)) throw new Error('Cannot parse fixture key')
    const fingerprint = `SHA256:${createHash('sha256').update(parsedKey.getPublicSSH()).digest('hex')}`
    const fixtureConnections: Array<{ end(): void }> = []
    const sshServers: SshServer[] = []
    const startSsh = async (): Promise<number> => {
      const sshServer = new SshServer({ hostKeys: [key.private] }, connection => {
        fixtureConnections.push(connection)
        connection.on('error', () => {})
        connection.on('authentication', context => context.method === 'password' && context.password === 'fixture' ? context.accept() : context.reject())
        connection.on('tcpip', (accept, reject, info) => {
          const socket = track(createConnection(info.destPort, info.destIP))
          let accepted = false
          socket.once('error', () => { if (!accepted) reject() })
          socket.once('connect', () => {
            accepted = true
            const channel = accept()
            channel.on('error', () => socket.destroy())
            channel.once('close', () => socket.destroy())
            socket.once('close', () => channel.destroy())
            socket.pipe(channel).pipe(socket)
          })
        })
        connection.on('request', (accept, reject, name, info) => {
          if (name !== 'tcpip-forward') { reject?.(); return }
          const listener = createServer(socket => {
            connection.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress!, socket.remotePort!, (error, channel) => {
              if (error) { socket.destroy(); return }
              channel.on('error', () => socket.destroy())
              channel.once('close', () => socket.destroy())
              socket.once('close', () => channel.destroy())
              socket.pipe(channel).pipe(socket)
            })
          })
          connection.once('close', () => listener.close())
          void listen(listener, info.bindPort).then(() => accept?.(), () => reject?.())
        })
      })
      sshServers.push(sshServer)
      await new Promise<void>(resolve => sshServer.listen(0, '127.0.0.1', resolve))
      return (sshServer.address() as { port: number }).port
    }
    const { config, profile, store } = await fixture(kind === 'remote' ? 'remote' : 'local', await echoPort())
    let realManager: TunnelManager | undefined
    try {
      profile.port = await startSsh()
      profile.hostFingerprint = fingerprint
      if (kind === 'jump') profile.jumpHost = { host: '127.0.0.1', port: await startSsh(), username: 'test', authType: 'password', hostFingerprint: fingerprint }
      if (kind === 'jump') config.accessRouteId = 'jump'
      store.getSecrets = () => ({ password: 'fixture', jumpPassword: 'fixture' })
      realManager = new TunnelManager(store, new SshService(), () => {})
      managers.add(realManager)
      expect(await realManager.start(config.id)).toMatchObject({ status: 'started' })
      expect(await exchange(config.bindPort)).toBe('LabDeck 多段\nforwarding\n')
      expect((await realManager.checkTarget(config.id)).reachable).toBe(true)
    } finally {
      realManager?.closeAll()
      for (const connection of fixtureConnections) connection.end()
      await Promise.all(sshServers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    }
  }, 10_000)

  it.each(['local', 'remote'] as const)('forwards bytes both ways for %s forwarding and releases the port on stop', async type => {
    const { manager, config } = await fixture(type, await echoPort())
    expect((await manager.start(config.id)).status).toBe('started')
    expect(manager.list()[0].serviceStatus).toBe('unknown')
    expect(await exchange(config.bindPort)).toBe('LabDeck 多段\nforwarding\n')
    expect(manager.list()[0].serviceStatus).toBe('reachable')
    manager.stop(config.id)
    expect(manager.list()[0].status).toBe('stopped')
    await listen(createServer(), config.bindPort)
  })

  it('reports an occupied local port without switching ports or leaking SSH', async () => {
    const { manager, config, clients } = await fixture()
    await listen(createServer(), config.bindPort)
    const result = await manager.start(config.id)
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toContain('已被占用')
    expect(manager.list()[0].bindPort).toBe(config.bindPort)
    expect(clients[0].destroy).toHaveBeenCalled()
  })

  it('keeps a running tunnel when its target service is unavailable', async () => {
    const { manager, config } = await fixture('local', await unusedPort())
    await manager.start(config.id)
    expect((await manager.checkTarget(config.id)).reachable).toBe(false)
    expect(manager.list()[0]).toMatchObject({ status: 'running', serviceStatus: 'unreachable' })
  })

  it('does not authenticate before an unknown host key is confirmed', async () => {
    const { profile, manager, config, ssh } = await fixture()
    profile.hostFingerprint = undefined
    expect(await manager.start(config.id)).toMatchObject({ status: 'host-key-required', fingerprint: 'SHA256:untrusted' })
    expect(ssh.connect).not.toHaveBeenCalled()
    expect(manager.list()[0].status).toBe('error')
  })

  it('does not fall back to another route when the saved route is removed', async () => {
    const { config, manager, ssh } = await fixture()
    config.accessRouteId = 'deleted-route'
    expect(await manager.start(config.id)).toMatchObject({ status: 'failed' })
    expect(ssh.connect).not.toHaveBeenCalled()
  })

  it('deduplicates starts and prevents editing while active', async () => {
    const { manager, config, ssh } = await fixture()
    await manager.start(config.id)
    expect((await manager.start(config.id)).status).toBe('failed')
    expect(ssh.connect).toHaveBeenCalledOnce()
    expect(() => manager.assertEditable(config.id)).toThrow('先停止')
    manager.stop(config.id)
    expect(() => manager.assertEditable(config.id)).not.toThrow()
  })

  it('closes a late SSH connection after the user cancels a pending start', async () => {
    const { manager, config, ssh } = await fixture()
    let resolve!: (value: { client: Client; latencyMs: number }) => void
    ssh.connect.mockImplementation(() => new Promise(done => { resolve = done }))
    const pending = manager.start(config.id)
    await vi.waitFor(() => expect(ssh.connect).toHaveBeenCalled())
    manager.stop(config.id)
    expect((await pending).status).toBe('failed')
    const late = new FakeClient()
    resolve({ client: late as unknown as Client, latencyMs: 1 })
    await Promise.resolve()
    expect(late.destroy).toHaveBeenCalledOnce()
    expect(manager.list()[0].status).toBe('stopped')
    await listen(createServer(), config.bindPort)
  })

  it('reconnects after a disconnect and cancels retries on an explicit stop', async () => {
    const { manager, config, clients, ssh } = await fixture('local', await echoPort())
    await manager.start(config.id)
    vi.useFakeTimers()
    clients[0].emit('close')
    expect(manager.list()[0].status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(2000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(manager.list()[0].status).toBe('running'))
    expect(await exchange(config.bindPort)).toContain('forwarding')
    vi.useFakeTimers()
    clients[1].emit('close')
    manager.stop(config.id)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ssh.connect).toHaveBeenCalledTimes(2)
    expect(manager.list()[0].status).toBe('stopped')
  })

  it('honors disabled reconnect and only starts opted-in configs on launch', async () => {
    const { config, manager, ssh, clients } = await fixture()
    await manager.autoStart()
    expect(ssh.connect).not.toHaveBeenCalled()
    config.autoStart = true
    config.autoReconnect = false
    await manager.autoStart()
    clients[0].emit('close')
    expect(manager.list()[0].status).toBe('error')
  })

  it('surfaces remote listener refusal and blocks unsupported browser actions', async () => {
    const { config, manager, ssh } = await fixture('remote')
    const client = new FakeClient()
    client.forwardIn.mockImplementation((_host, _port, callback) => callback(new Error('administratively prohibited')))
    ssh.connect.mockResolvedValue({ client: client as unknown as Client, latencyMs: 1 })
    expect((await manager.start(config.id)).message).toContain('转发权限')
    expect(client.destroy).toHaveBeenCalled()
    expect(() => manager.browserUrl(config.id)).toThrow()
  })

  it('uses a loopback browser address for a wildcard listener and shuts down all resources', async () => {
    const { config, manager } = await fixture()
    config.bindAddress = '0.0.0.0'
    await manager.start(config.id)
    expect(manager.browserUrl(config.id)).toBe(`http://127.0.0.1:${config.bindPort}`)
    manager.closeAll()
    expect((await manager.start(config.id)).status).toBe('failed')
    await listen(createServer(), config.bindPort)
  })

  it('rejects invalid ports, bind addresses and target control characters', async () => {
    const { config } = await fixture()
    expect(tunnelConfigInputSchema.safeParse(config).success).toBe(true)
    for (const invalid of [{ bindPort: 0 }, { targetPort: 65536 }, { bindAddress: 'localhost' }, { targetHost: 'host\nother' }]) {
      expect(tunnelConfigInputSchema.safeParse({ ...config, ...invalid }).success).toBe(false)
    }
  })
})
