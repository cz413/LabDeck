import { posix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { ServerProfile, SftpEntry } from '../shared/types'
import type { ServerSecrets } from './store'
import { SshService } from './ssh-service'

export class SftpService {
  constructor(private readonly ssh: SshService) {}

  async list(profile: ServerProfile, secrets: ServerSecrets, remotePath: string): Promise<SftpEntry[]> {
    const normalized = this.normalizeRemotePath(remotePath)
    return this.withSftp(profile, secrets, (sftp) =>
      new Promise((resolve, reject) => {
        sftp.readdir(normalized, (error, list) => {
          if (error) return reject(error)
          resolve(
            list
              // Match the default `ls` view: hidden dot-files are intentionally omitted.
              .filter((entry) => entry.filename !== '.' && entry.filename !== '..' && !entry.filename.startsWith('.'))
              .map((entry): SftpEntry => ({
                name: entry.filename,
                path: posix.join(normalized, entry.filename),
                type: entry.attrs.isDirectory()
                  ? 'directory'
                  : entry.attrs.isFile()
                    ? 'file'
                    : entry.attrs.isSymbolicLink()
                      ? 'link'
                      : 'other',
                size: entry.attrs.size,
                modifiedAt: entry.attrs.mtime * 1000,
                permissions: entry.attrs.mode
              }))
              .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
          )
        })
      })
    )
  }

  async upload(
    profile: ServerProfile,
    secrets: ServerSecrets,
    localPath: string,
    remotePath: string,
    onProgress?: (transferredBytes: number, totalBytes: number) => void
  ): Promise<void> {
    await this.withSftp(profile, secrets, (sftp) =>
      new Promise<void>((resolve, reject) => {
        sftp.fastPut(
          localPath,
          this.normalizeRemotePath(remotePath),
          { step: (transferredBytes, _chunk, totalBytes) => onProgress?.(transferredBytes, totalBytes) },
          (error) => error ? reject(error) : resolve()
        )
      })
    )
  }

  async download(
    profile: ServerProfile,
    secrets: ServerSecrets,
    remotePath: string,
    localPath: string,
    onProgress?: (transferredBytes: number, totalBytes: number) => void
  ): Promise<void> {
    await this.withSftp(profile, secrets, (sftp) =>
      new Promise<void>((resolve, reject) => {
        sftp.fastGet(
          this.normalizeRemotePath(remotePath),
          localPath,
          { step: (transferredBytes, _chunk, totalBytes) => onProgress?.(transferredBytes, totalBytes) },
          (error) => error ? reject(error) : resolve()
        )
      })
    )
  }

  private async withSftp<T>(
    profile: ServerProfile,
    secrets: ServerSecrets,
    action: (sftp: SFTPWrapper) => Promise<T>
  ): Promise<T> {
    if (profile.mode === 'demo') throw new Error('演示节点不支持真实文件操作')
    const connected = await this.ssh.connect(profile, secrets)
    try {
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        connected.client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper)))
      })
      sftp.on('error', (error: unknown) => console.warn('SFTP 通道中断：', error instanceof Error ? error.message : error))
      try {
        return await action(sftp)
      } finally {
        sftp.end()
      }
    } finally {
      connected.client.end()
    }
  }

  private normalizeRemotePath(remotePath: string): string {
    const normalized = posix.normalize(remotePath || '/')
    return normalized.startsWith('/') ? normalized : posix.join('/', normalized)
  }
}
