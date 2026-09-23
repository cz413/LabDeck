import { describe, expect, it } from 'vitest'
import type { ServerProfile } from '../shared/types'
import { renderManagedSshConfig, vscodeCliPath, vscodeSshAlias } from './vscode-service'

const server = (overrides: Partial<ServerProfile> = {}): ServerProfile => ({
  id: 'E6DE6BD7-2152-4090-B53E-72DBC5BB3A3E',
  name: 'gpu-node',
  host: 'gpu.example.test',
  port: 2222,
  username: 'researcher',
  authType: 'privateKey',
  privateKeyPath: 'C:\\Users\\Lab User\\.ssh\\id_ed25519',
  tags: [],
  group: '实验室',
  mode: 'real',
  monitorPolicy: 'manual',
  hasSecret: false,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  ...overrides
})

describe('VS Code Remote-SSH configuration', () => {
  it('builds a stable safe alias', () => {
    expect(vscodeSshAlias('ABC_123')).toBe('labdeck-abc-123')
  })

  it('uses the VS Code CLI wrapper instead of launching Code.exe for CLI commands', () => {
    expect(vscodeCliPath('D:/code/Microsoft VS Code/Code.exe')).toBe('D:\\code\\Microsoft VS Code\\bin\\code.cmd')
    expect(vscodeCliPath('D:/code/Microsoft VS Code/bin/code')).toBe('D:/code/Microsoft VS Code/bin/code.cmd')
    expect(vscodeCliPath('D:/custom/code.cmd')).toBe('D:/custom/code.cmd')
    expect(vscodeCliPath('D:/code/Microsoft VS Code Insiders/Code - Insiders.exe')).toBe('D:\\code\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd')
    expect(vscodeCliPath('D:/code/Microsoft VS Code Insiders/bin/code-insiders')).toBe('D:/code/Microsoft VS Code Insiders/bin/code-insiders.cmd')
  })

  it('writes a direct host without secrets', () => {
    const config = renderManagedSshConfig([server()])
    expect(config).toContain('Host labdeck-e6de6bd7-2152-4090-b53e-72dbc5bb3a3e')
    expect(config).toContain('  HostName gpu.example.test')
    expect(config).toContain('  Port 2222')
    expect(config).toContain('  IdentityFile "C:/Users/Lab User/.ssh/id_ed25519"')
    expect(config).not.toContain('password')
  })

  it('adds a dedicated jump host and skips demo nodes', () => {
    const config = renderManagedSshConfig([
      server({
        jumpHost: {
          host: 'jump.example.test',
          port: 22,
          username: 'relay',
          authType: 'password',
          hasSecret: true
        }
      }),
      server({ id: 'demo', mode: 'demo' })
    ])
    expect(config).toContain('Host labdeck-e6de6bd7-2152-4090-b53e-72dbc5bb3a3e-jump')
    expect(config).toContain('  ProxyJump labdeck-e6de6bd7-2152-4090-b53e-72dbc5bb3a3e-jump')
    expect(config).not.toContain('Host labdeck-demo')
    expect(config).not.toContain('hasSecret')
  })

  it('renders explicit direct and jump routes under one server identity', () => {
    const config = renderManagedSshConfig([server({
      accessRoutes: [
        {
          id: 'direct', name: '默认', kind: 'direct', host: '10.0.0.8', port: 22,
          username: 'researcher', authType: 'privateKey', privateKeyPath: 'C:\\Keys\\id_ed25519'
        },
        {
          id: 'jump', name: '跳板机', kind: 'jump', host: '10.10.0.8', port: 22,
          username: 'researcher', authType: 'privateKey', privateKeyPath: 'C:\\Keys\\id_ed25519',
          jumpHost: { host: 'jump.example.test', port: 22, username: 'relay', authType: 'privateKey', privateKeyPath: 'C:\\Keys\\jump' }
        }
      ]
    })])
    expect(config).toContain('Host labdeck-e6de6bd7-2152-4090-b53e-72dbc5bb3a3e')
    expect(config).toContain('Host labdeck-e6de6bd7-2152-4090-b53e-72dbc5bb3a3e-jump')
    expect(config).toContain('  HostName 10.10.0.8')
    expect(config).toContain('  ProxyJump labdeck-e6de6bd7-2152-4090-b53e-72dbc5bb3a3e-jump-jump')
  })
})
