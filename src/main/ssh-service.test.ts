import { EventEmitter } from 'node:events'
import type { Client, ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshService } from './ssh-service'

function commandClient() {
  const client = new EventEmitter() as EventEmitter & { exec: ReturnType<typeof vi.fn> }
  const stream = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    close: ReturnType<typeof vi.fn>
  }
  stream.stderr = new EventEmitter()
  stream.close = vi.fn()
  client.exec = vi.fn((_command, callback) => callback(null, stream))
  return { client, stream, sshClient: client as unknown as Client }
}

afterEach(() => vi.useRealTimers())

describe('SSH command connection lifecycle', () => {
  it('fails immediately when the connection closes during a command', async () => {
    vi.useFakeTimers()
    const { client, stream, sshClient } = commandClient()
    const request = new SshService().exec(sshClient, 'metrics', 15_000)
    const rejected = expect(request).rejects.toThrow('SSH 连接已关闭')
    client.emit('close')
    await rejected
    expect(stream.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(client.listenerCount('close')).toBe(0)
    expect(client.listenerCount('error')).toBe(0)
  })

  it('closes a channel returned after the connection has already failed', async () => {
    const { client, stream, sshClient } = commandClient()
    let open!: (error: Error | null, stream: ClientChannel) => void
    client.exec.mockImplementation((_command, callback) => { open = callback })
    const request = new SshService().exec(sshClient, 'metrics')
    const rejected = expect(request).rejects.toThrow('connection reset')
    client.emit('error', new Error('connection reset'))
    open(null, stream as unknown as ClientChannel)
    await rejected
    expect(stream.close).toHaveBeenCalledOnce()
  })

  it('removes connection listeners and the timer after success', async () => {
    vi.useFakeTimers()
    const { client, stream, sshClient } = commandClient()
    const request = new SshService().exec(sshClient, 'metrics')
    stream.emit('data', Buffer.from('result'))
    stream.emit('close', 0)
    await expect(request).resolves.toBe('result')
    expect(client.listenerCount('close')).toBe(0)
    expect(client.listenerCount('error')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up when exec throws synchronously', async () => {
    vi.useFakeTimers()
    const { client, sshClient } = commandClient()
    client.exec.mockImplementation(() => { throw new Error('Not connected') })
    await expect(new SshService().exec(sshClient, 'metrics')).rejects.toThrow('Not connected')
    expect(client.listenerCount('close')).toBe(0)
    expect(client.listenerCount('error')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
