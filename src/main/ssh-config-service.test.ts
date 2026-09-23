import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SshConfigService } from './ssh-config-service'
import type { AppStore } from './store'

const tempPaths: string[] = []
const service = new SshConfigService({} as AppStore)

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SshConfigService', () => {
  it('parses resolved OpenSSH configuration', () => {
    const result = service.parseSshG(
      'gpu-prod',
      [
        'host gpu-prod',
        'hostname 10.20.0.21',
        'user researcher',
        'port 2202',
        'identityfile ~/.ssh/id_ed25519',
        'proxyjump lab-gateway'
      ].join('\n')
    )

    expect(result).toMatchObject({
      alias: 'gpu-prod',
      host: '10.20.0.21',
      port: 2202,
      username: 'researcher',
      proxyJump: 'lab-gateway'
    })
    expect(result.identityFile).toContain('id_ed25519')
  })

  it('collects concrete Host aliases and skips wildcard templates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labpilot-ssh-config-'))
    tempPaths.push(root)
    await mkdir(join(root, 'config.d'))
    await writeFile(
      join(root, 'config'),
      ['Host *', '  ServerAliveInterval 30', 'Host gpu-01 gpu-02', 'Include config.d/*'].join('\n')
    )
    await writeFile(
      join(root, 'config.d', 'storage.conf'),
      ['Host storage-*', '  User lab', 'Host storage-main', '  HostName 10.20.0.31'].join('\n')
    )

    await expect(service.collectAliases(join(root, 'config'))).resolves.toEqual([
      'gpu-01',
      'gpu-02',
      'storage-main'
    ])
  })
})
