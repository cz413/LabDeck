import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell, Tray } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AppSettings, GpuHistoryRange, GpuMetric, ServerProfile, ServerProfileInput, ServerSnapshot, SftpTransferProgress } from '../shared/types'
import { isGpuBusy } from '../shared/gpu-status'
import { applyAccessRoute, getDefaultAccessRouteId } from '../shared/access-routes'
import { AppStore } from './store'
import { MonitorService } from './monitor-service'
import { SftpService } from './sftp-service'
import { SshService } from './ssh-service'
import { SshConfigService } from './ssh-config-service'
import { TerminalManager } from './terminal-manager'
import { VsCodeService } from './vscode-service'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let terminalManager: TerminalManager | null = null
const sftpWindows = new Map<string, BrowserWindow>()
let quittingAfterTerminalCleanup = false
let trayHintShown = false
let closePromptVisible = false
const gpuNotificationCooldown = new Map<string, number>()
const pendingInitialGpuWatches = new Set<string>()

const gpuWatchKey = (serverId: string, gpuUuid?: string): string =>
  `${serverId}::${gpuUuid ?? '*'}`

const appIconPath = join(app.getAppPath(), 'resources', 'labdeck-icon.ico')

process.on('uncaughtException', (error) => {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') {
    console.warn(`连接已中断（${code}），应用继续运行`)
    return
  }
  console.error('主进程未捕获异常：', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('主进程未处理的异步异常：', reason)
})

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function hideToTray(): void {
  if (!mainWindow) return
  mainWindow.hide()
  if (!trayHintShown && tray && process.platform === 'win32') {
    trayHintShown = true
    tray.displayBalloon({
      title: 'LabDeck 仍在后台运行',
      content: '服务器监控与 GPU 空闲提醒将继续运行，双击托盘图标可恢复窗口。',
      icon: appIconPath
    })
  }
}

function createTray(): void {
  if (tray) return
  tray = new Tray(appIconPath)
  tray.setToolTip('LabDeck · 实验室算力工作台')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 LabDeck', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 LabDeck（前台任务可能中断）', click: () => app.quit() }
  ]))
  tray.on('double-click', showMainWindow)
}

function createWindow(store: AppStore): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    frame: false,
    thickFrame: true,
    icon: appIconPath,
    backgroundColor: '#07111f',
    title: 'LabDeck · 实验室算力工作台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    const capturePath = process.env.LAB_DEMO_CAPTURE
    if (capturePath) {
      setTimeout(() => {
        void (async () => {
          const view = process.env.LAB_DEMO_CAPTURE_VIEW
          if (view === 'gpus' || view === 'gpu-detail') {
            await mainWindow?.webContents.executeJavaScript(
              "[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('GPU 资源'))?.click()"
            )
          }
          if (view === 'gpu-detail') {
            await new Promise((resolve) => setTimeout(resolve, 300))
            await mainWindow?.webContents.executeJavaScript(
              "document.querySelector('.gpu-overview-card')?.click()"
            )
          }
          if (view === 'server-detail') {
            await mainWindow?.webContents.executeJavaScript(
              "document.querySelector('.sidebar-server-link')?.click()"
            )
            await new Promise((resolve) => setTimeout(resolve, 350))
          }
          if (view === 'server-terminal') {
            await mainWindow?.webContents.executeJavaScript(
              "document.querySelector('.sidebar-server-link')?.click()"
            )
            await new Promise((resolve) => setTimeout(resolve, 250))
            await mainWindow?.webContents.executeJavaScript(
              "[...document.querySelectorAll('.server-detail-tabs button')].find((button) => button.textContent?.includes('终端'))?.click()"
            )
            await new Promise((resolve) => setTimeout(resolve, 500))
            await mainWindow?.webContents.executeJavaScript(
              "document.querySelector('.server-terminal-workspace .local-terminal-add')?.click()"
            )
          }
          if (view === 'password') {
            await mainWindow?.webContents.executeJavaScript(
              "[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('添加服务器'))?.click()"
            )
          }
          if (view === 'terminal-drag') {
            await mainWindow?.webContents.executeJavaScript(
              "document.querySelector('.terminal-action')?.click()"
            )
            await new Promise((resolve) => setTimeout(resolve, 300))
            await mainWindow?.webContents.executeJavaScript(`(() => {
              const handle = document.querySelector('.terminal-drag-handle')
              if (!handle) return false
              const rect = handle.getBoundingClientRect()
              const options = { bubbles: true, pointerId: 7, clientX: rect.left + 120, clientY: rect.top + 24 }
              handle.dispatchEvent(new PointerEvent('pointerdown', options))
              window.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: window.innerWidth + 900, clientY: window.innerHeight + 700 }))
              window.dispatchEvent(new PointerEvent('pointerup', { ...options, clientX: window.innerWidth + 900, clientY: window.innerHeight + 700 }))
              return true
            })()`)
          }
          if (view === 'local-terminal') {
            await mainWindow?.webContents.executeJavaScript(
              "[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('本地终端'))?.click()"
            )
            await new Promise((resolve) => setTimeout(resolve, 450))
            await mainWindow?.webContents.executeJavaScript(
              "document.querySelector('.local-terminal-add')?.click(); document.querySelector('.local-terminal-add')?.click()"
            )
            await new Promise((resolve) => setTimeout(resolve, 900))
          }
          if (view === 'settings') {
            await mainWindow?.webContents.executeJavaScript(
                "[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('偏好设置'))?.click()"
            )
            const theme = process.env.LAB_DEMO_CAPTURE_THEME
            if (theme) {
              await new Promise((resolve) => setTimeout(resolve, 150))
              await mainWindow?.webContents.executeJavaScript(
                `[...document.querySelectorAll('.theme-option')].find((button) => button.textContent?.includes(${JSON.stringify(theme)}))?.click()`
              )
            }
          }
          if (view === 'close-prompt') {
            await mainWindow?.webContents.executeJavaScript('window.labApi.windowControls.close()')
            await new Promise((resolve) => setTimeout(resolve, 220))
          }
          const forcedTheme = process.env.LAB_DEMO_CAPTURE_THEME
          if (forcedTheme && view !== 'settings') {
            const theme = forcedTheme === '浅色仪器台' ? 'instrument' : forcedTheme === '深色机房' ? 'machineRoom' : 'ocean'
            await mainWindow?.webContents.executeJavaScript(
              `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`
            )
          }
          await new Promise((resolve) => setTimeout(resolve, 350))
          const image = await mainWindow?.webContents.capturePage()
          if (image) await writeFile(capturePath, image.toPNG())
          app.quit()
        })()
      }, 1500)
    }
  })
  mainWindow.on('close', (event) => {
    if (quittingAfterTerminalCleanup) return
    const closeBehavior = store.getSettings().closeBehavior
    if (closeBehavior === 'exit') return
    event.preventDefault()
    if (closeBehavior === 'tray') {
      hideToTray()
      return
    }
    if (closePromptVisible || !mainWindow) return
    closePromptVisible = true
    mainWindow.webContents.send('window:closeRequested')
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.setMenuBarVisibility(false)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function resolveConnectionProfile(store: AppStore, serverId: string, accessRouteId?: string): ServerProfile {
  return applyAccessRoute(store.getServer(serverId), accessRouteId)
}

function createSftpWindow(store: AppStore, serverId: string, accessRouteId?: string): BrowserWindow {
  const routeId = accessRouteId ?? getDefaultAccessRouteId(store.getServer(serverId))
  const windowKey = `${serverId}:${routeId}`
  const existing = sftpWindows.get(windowKey)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const server = store.getServer(serverId)
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    show: false,
    frame: false,
    thickFrame: true,
    icon: appIconPath,
    backgroundColor: '#07111f',
    title: `${server.name} · 文件管理`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })
  sftpWindows.set(windowKey, window)
  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })
  window.on('closed', () => {
    if (sftpWindows.get(windowKey) === window) sftpWindows.delete(windowKey)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.setMenuBarVisibility(false)
  const query = `?sftpServerId=${encodeURIComponent(serverId)}&sftpRouteId=${encodeURIComponent(routeId)}`
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}${query}`)
  else void window.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
  return window
}

function isGpuAvailable(gpu: GpuMetric): boolean {
  return gpu.temperatureC < 80 && !isGpuBusy(gpu)
}

function notifyGpuAvailability(
  store: AppStore,
  server: ServerProfile,
  previous: ServerSnapshot | undefined,
  current: ServerSnapshot
): void {
  if (current.status === 'offline') return
  const watches = store.getSettings().gpuWatches.filter((watch) => watch.serverId === server.id)
  if (!watches.length) return
  const watchesServer = watches.some((watch) => !watch.gpuUuid)
  const pendingServerWatch = pendingInitialGpuWatches.has(gpuWatchKey(server.id))
  const candidates: GpuMetric[] = []
  for (const gpu of current.gpus) {
    if (!watchesServer && !watches.some((watch) => watch.gpuUuid === gpu.uuid)) continue
    const previousGpu = previous?.gpus.find((item) => item.uuid === gpu.uuid)
    const pendingGpuWatch = pendingInitialGpuWatches.has(gpuWatchKey(server.id, gpu.uuid))
    const becameAvailable = Boolean(previousGpu && !isGpuAvailable(previousGpu) && isGpuAvailable(gpu))
    if (isGpuAvailable(gpu) && (pendingServerWatch || pendingGpuWatch || becameAvailable)) candidates.push(gpu)
    pendingInitialGpuWatches.delete(gpuWatchKey(server.id, gpu.uuid))
  }
  pendingInitialGpuWatches.delete(gpuWatchKey(server.id))
  if (!Notification.isSupported()) return
  const currentTime = Date.now()
  const notifyCandidates = candidates.filter((gpu) => {
    const notificationKey = `${server.id}::${gpu.uuid}`
    if (currentTime - (gpuNotificationCooldown.get(notificationKey) ?? 0) < 10 * 60_000) return false
    gpuNotificationCooldown.set(notificationKey, currentTime)
    return true
  })
  if (!notifyCandidates.length) return
  const bestGpu = [...notifyCandidates].sort((left, right) =>
    (right.memoryTotalMiB - right.memoryUsedMiB) - (left.memoryTotalMiB - left.memoryUsedMiB)
  )[0]
  const singleGpu = notifyCandidates.length === 1 ? notifyCandidates[0] : null
  const body = singleGpu
    ? `当前空闲显存 ${((singleGpu.memoryTotalMiB - singleGpu.memoryUsedMiB) / 1024).toFixed(1)} GB，点击查看 GPU 详情。`
    : `${notifyCandidates.slice(0, 4).map((gpu) => `GPU ${gpu.index}（${((gpu.memoryTotalMiB - gpu.memoryUsedMiB) / 1024).toFixed(1)} GB）`).join('、')}${notifyCandidates.length > 4 ? ' 等' : ''}`
  const notification = new Notification({
    title: singleGpu
      ? `${server.name} · GPU ${singleGpu.index} 已空闲`
      : `${server.name} · ${notifyCandidates.length} 块 GPU 已空闲`,
    body,
    icon: appIconPath
  })
  notification.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
    mainWindow?.webContents.send('notifications:gpuAvailable', {
      serverId: server.id,
      gpuUuid: bestGpu.uuid,
      gpuIndex: bestGpu.index
    })
  })
  notification.show()
}

function trackGpuWatchChanges(previous: AppSettings, current: AppSettings): void {
  const previousKeys = new Set(previous.gpuWatches.map((watch) => gpuWatchKey(watch.serverId, watch.gpuUuid)))
  const currentKeys = new Set(current.gpuWatches.map((watch) => gpuWatchKey(watch.serverId, watch.gpuUuid)))
  for (const key of currentKeys) {
    if (previousKeys.has(key)) continue
    pendingInitialGpuWatches.add(key)
    if (key.endsWith('::*')) {
      const serverPrefix = `${key.slice(0, -1)}`
      for (const cooldownKey of gpuNotificationCooldown.keys()) {
        if (cooldownKey.startsWith(serverPrefix)) gpuNotificationCooldown.delete(cooldownKey)
      }
    } else {
      gpuNotificationCooldown.delete(key)
    }
  }
  for (const key of previousKeys) {
    if (!currentKeys.has(key)) pendingInitialGpuWatches.delete(key)
  }
}

function registerIpc(store: AppStore): void {
  const ssh = new SshService()
  const sshConfig = new SshConfigService(store)
  const monitor = new MonitorService(ssh)
  const sftp = new SftpService(ssh)
  const vscode = new VsCodeService(store)
  terminalManager = new TerminalManager(ssh, () => mainWindow?.webContents ?? null)

  ipcMain.on('window:minimize', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    if (!targetWindow) return
    targetWindow.minimize()
  })
  ipcMain.handle('window:toggleMaximize', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender)
    if (!targetWindow) return false
    if (targetWindow.isMaximized()) targetWindow.unmaximize()
    else targetWindow.maximize()
    return targetWindow.isMaximized()
  })
  ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.handle('window:resolveCloseAction', async (_event, action: 'tray' | 'exit' | 'cancel', remember: boolean) => {
    if (!['tray', 'exit', 'cancel'].includes(action)) throw new Error('无效的关闭操作')
    closePromptVisible = false
    let settings = store.getSettings()
    if (remember && action !== 'cancel') {
      settings = await store.saveSettings({ ...settings, closeBehavior: action })
    }
    if (action === 'tray') hideToTray()
    if (action === 'exit') setTimeout(() => app.quit(), 50)
    return settings
  })
  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  ipcMain.handle('clipboard:writeText', (_event, text: string) => clipboard.writeText(text))

  ipcMain.handle('servers:list', () => store.listServers())
  ipcMain.handle('servers:save', (_event, input: ServerProfileInput) => store.saveServer(input))
  ipcMain.handle('servers:mergeAccessRoute', (_event, serverId: string, sourceServerId: string) => store.mergeAccessRoute(serverId, sourceServerId))
  ipcMain.handle('servers:remove', (_event, id: string) => store.removeServer(id))
  ipcMain.handle('servers:test', async (_event, id: string, accessRouteId?: string) => {
    const profile = resolveConnectionProfile(store, id, accessRouteId)
    return ssh.testConnection(profile, store.getSecrets(id))
  })
  ipcMain.handle('servers:trustHost', (_event, id: string, fingerprint: string, target?: 'server' | 'jumpHost', accessRouteId?: string) =>
    store.trustHost(id, fingerprint, target, accessRouteId)
  )
  ipcMain.handle('servers:choosePrivateKey', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 SSH 私钥',
      properties: ['openFile'],
      filters: [{ name: 'SSH 私钥', extensions: ['pem', 'key', 'ppk', '*'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('sshConfig:scan', () => sshConfig.scan())
  ipcMain.handle('sshConfig:importAll', () => sshConfig.importAll())

  ipcMain.handle('monitor:snapshot', async (_event, id: string, accessRouteId?: string) => {
    const profile = resolveConnectionProfile(store, id, accessRouteId)
    const previous = store.getCachedSnapshots()[id]
    const snapshot = await monitor.snapshot(profile, store.getSecrets(id))
    await store.recordSnapshot(snapshot, profile.mode === 'demo')
    notifyGpuAvailability(store, profile, previous, snapshot)
    return snapshot
  })
  ipcMain.handle('monitor:cachedSnapshots', () => store.getCachedSnapshots())
  ipcMain.handle('monitor:gpuHistory', (_event, id: string, gpuUuid: string, range: GpuHistoryRange) => {
    store.getServer(id)
    return store.getGpuHistory(id, gpuUuid, range)
  })

  ipcMain.handle('terminal:connect', async (_event, id: string, cols: number, rows: number, accessRouteId?: string) => {
    const profile = resolveConnectionProfile(store, id, accessRouteId)
    return terminalManager!.connect(profile, store.getSecrets(id), cols, rows)
  })
  ipcMain.handle('terminal:connectLocal', (_event, cols: number, rows: number) =>
    terminalManager!.connectLocal(cols, rows)
  )
  ipcMain.on('terminal:write', (_event, sessionId: string, data: string) =>
    terminalManager?.write(sessionId, data)
  )
  ipcMain.handle('terminal:autofillPassword', (_event, sessionId: string) =>
    terminalManager?.autofillPassword(sessionId) ?? false
  )
  ipcMain.on('terminal:resize', (_event, sessionId: string, cols: number, rows: number) =>
    terminalManager?.resize(sessionId, cols, rows)
  )
  ipcMain.on('terminal:close', (_event, sessionId: string) => terminalManager?.close(sessionId))

  ipcMain.handle('sftp:list', async (_event, id: string, remotePath: string, accessRouteId?: string) => {
    const profile = resolveConnectionProfile(store, id, accessRouteId)
    return sftp.list(profile, store.getSecrets(id), remotePath)
  })
  ipcMain.handle('sftp:openWindow', (_event, id: string, accessRouteId?: string) => {
    createSftpWindow(store, id, accessRouteId)
  })
  ipcMain.handle('sftp:chooseUploadFile', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) ?? mainWindow!, {
      title: '选择要上传的文件',
      properties: ['openFile']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(
    'sftp:upload',
    async (event, id: string, localPath: string, remotePath: string, transferId: string, accessRouteId?: string) => {
      const profile = resolveConnectionProfile(store, id, accessRouteId)
      const fileName = basename(localPath)
      const sendProgress = (payload: SftpTransferProgress): void => {
        if (!event.sender.isDestroyed()) event.sender.send('sftp:progress', payload)
      }
      let lastTransferredBytes = 0
      let lastTotalBytes = 0
      const update = (transferredBytes: number, totalBytes: number, status: SftpTransferProgress['status'], error?: string): void => {
        lastTransferredBytes = transferredBytes
        lastTotalBytes = totalBytes
        sendProgress({ transferId, direction: 'upload', fileName, transferredBytes, totalBytes, status, ...(error ? { error } : {}) })
      }
      update(0, 0, 'running')
      try {
        await sftp.upload(profile, store.getSecrets(id), localPath, remotePath, (transferredBytes, totalBytes) => update(transferredBytes, totalBytes, 'running'))
        update(lastTotalBytes || lastTransferredBytes, lastTotalBytes || lastTransferredBytes, 'completed')
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught)
        update(0, 0, 'failed', message)
        throw caught
      }
    }
  )
  ipcMain.handle('sftp:download', async (event, id: string, remotePath: string, transferId: string, accessRouteId?: string) => {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) ?? mainWindow!, {
      title: '保存远程文件',
      defaultPath: basename(remotePath)
    })
    if (result.canceled || !result.filePath) return null
    const profile = resolveConnectionProfile(store, id, accessRouteId)
    const fileName = basename(remotePath)
    const sendProgress = (payload: SftpTransferProgress): void => {
      if (!event.sender.isDestroyed()) event.sender.send('sftp:progress', payload)
    }
    let lastTransferredBytes = 0
    let lastTotalBytes = 0
    const update = (transferredBytes: number, totalBytes: number, status: SftpTransferProgress['status'], error?: string): void => {
      lastTransferredBytes = transferredBytes
      lastTotalBytes = totalBytes
      sendProgress({ transferId, direction: 'download', fileName, transferredBytes, totalBytes, status, ...(error ? { error } : {}) })
    }
    update(0, 0, 'running')
    try {
      await sftp.download(profile, store.getSecrets(id), remotePath, result.filePath, (transferredBytes, totalBytes) => update(transferredBytes, totalBytes, 'running'))
      update(lastTotalBytes || lastTransferredBytes, lastTotalBytes || lastTransferredBytes, 'completed')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      update(0, 0, 'failed', message)
      throw caught
    }
    return result.filePath
  })

  ipcMain.handle('vscode:openRemote', (_event, id: string, accessRouteId?: string) => {
    return vscode.openRemote(resolveConnectionProfile(store, id, accessRouteId), accessRouteId)
  })

  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:save', async (_event, settings: AppSettings) => {
    const previous = store.getSettings()
    const saved = await store.saveSettings(settings)
    trackGpuWatchChanges(previous, saved)
    return saved
  })
}

app.whenReady().then(async () => {
  app.setAppUserModelId('cn.lab.server-manager')
  const store = new AppStore()
  await store.initialize()
  for (const watch of store.getSettings().gpuWatches) {
    pendingInitialGpuWatches.add(gpuWatchKey(watch.serverId, watch.gpuUuid))
  }
  registerIpc(store)
  createWindow(store)
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(store)
    else showMainWindow()
  })
})

app.on('before-quit', (event) => {
  if (quittingAfterTerminalCleanup || !terminalManager) return
  event.preventDefault()
  quittingAfterTerminalCleanup = true
  void terminalManager.closeAll().finally(() => app.quit())
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
