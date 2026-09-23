import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppApi,
  AppSettings,
  GpuAvailableEvent,
  ServerProfileInput,
  SftpTransferProgress,
  TerminalDataEvent,
  TerminalExitEvent
} from '../shared/types'

const api: AppApi = {
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    resolveCloseAction: (action, remember) => ipcRenderer.invoke('window:resolveCloseAction', action, remember),
    onCloseRequested: (listener) => {
      const handler = (): void => listener()
      ipcRenderer.on('window:closeRequested', handler)
      return () => ipcRenderer.removeListener('window:closeRequested', handler)
    }
  },
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text)
  },
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    save: (input: ServerProfileInput) => ipcRenderer.invoke('servers:save', input),
    mergeAccessRoute: (serverId: string, sourceServerId: string) => ipcRenderer.invoke('servers:mergeAccessRoute', serverId, sourceServerId),
    remove: (id: string) => ipcRenderer.invoke('servers:remove', id),
    test: (id: string, accessRouteId?: string) => ipcRenderer.invoke('servers:test', id, accessRouteId),
    trustHost: (id: string, fingerprint: string, target?: 'server' | 'jumpHost', accessRouteId?: string) =>
      ipcRenderer.invoke('servers:trustHost', id, fingerprint, target, accessRouteId),
    choosePrivateKey: () => ipcRenderer.invoke('servers:choosePrivateKey')
  },
  sshConfig: {
    scan: () => ipcRenderer.invoke('sshConfig:scan'),
    importAll: () => ipcRenderer.invoke('sshConfig:importAll')
  },
  monitor: {
    snapshot: (id: string, accessRouteId?: string) => ipcRenderer.invoke('monitor:snapshot', id, accessRouteId),
    cachedSnapshots: () => ipcRenderer.invoke('monitor:cachedSnapshots'),
    gpuHistory: (serverId, gpuUuid, range) => ipcRenderer.invoke('monitor:gpuHistory', serverId, gpuUuid, range)
  },
  terminal: {
    connect: (serverId: string, cols: number, rows: number, accessRouteId?: string) =>
      ipcRenderer.invoke('terminal:connect', serverId, cols, rows, accessRouteId),
    connectLocal: (cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:connectLocal', cols, rows),
    write: (sessionId: string, data: string) => ipcRenderer.send('terminal:write', sessionId, data),
    autofillPassword: (sessionId: string) => ipcRenderer.invoke('terminal:autofillPassword', sessionId),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send('terminal:resize', sessionId, cols, rows),
    close: (sessionId: string) => ipcRenderer.send('terminal:close', sessionId),
    onData: (listener: (event: TerminalDataEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => listener(payload)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    onExit: (listener: (event: TerminalExitEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent): void => listener(payload)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    }
  },
  sftp: {
    openWindow: (serverId: string, accessRouteId?: string) => ipcRenderer.invoke('sftp:openWindow', serverId, accessRouteId),
    list: (serverId: string, path: string, accessRouteId?: string) => ipcRenderer.invoke('sftp:list', serverId, path, accessRouteId),
    chooseUploadFile: () => ipcRenderer.invoke('sftp:chooseUploadFile'),
    upload: (serverId: string, localPath: string, remotePath: string, transferId: string, accessRouteId?: string) =>
      ipcRenderer.invoke('sftp:upload', serverId, localPath, remotePath, transferId, accessRouteId),
    download: (serverId: string, remotePath: string, transferId: string, accessRouteId?: string) =>
      ipcRenderer.invoke('sftp:download', serverId, remotePath, transferId, accessRouteId),
    onProgress: (listener: (event: SftpTransferProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SftpTransferProgress): void => listener(payload)
      ipcRenderer.on('sftp:progress', handler)
      return () => ipcRenderer.removeListener('sftp:progress', handler)
    }
  },
  vscode: {
    openRemote: (serverId: string, accessRouteId?: string) => ipcRenderer.invoke('vscode:openRemote', serverId, accessRouteId)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings: AppSettings) => ipcRenderer.invoke('settings:save', settings)
  },
  notifications: {
    onGpuAvailable: (listener: (event: GpuAvailableEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: GpuAvailableEvent): void => listener(payload)
      ipcRenderer.on('notifications:gpuAvailable', handler)
      return () => ipcRenderer.removeListener('notifications:gpuAvailable', handler)
    }
  }
}

contextBridge.exposeInMainWorld('labApi', api)
