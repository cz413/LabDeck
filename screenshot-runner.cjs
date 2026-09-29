const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const root = __dirname
const output = path.join(root, 'docs', 'screenshots')
const tempProfile = path.join(root, '.screenshot-userdata')

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  app.setPath('userData', tempProfile)
  await app.whenReady()
  const { createServer } = await import('vite')
  const reactPlugin = (await import('@vitejs/plugin-react')).default
  const viteServer = await createServer({
    configFile: false,
    root: path.join(root, 'src', 'renderer'),
    plugins: [reactPlugin()],
    resolve: {
      alias: {
        '@renderer': path.join(root, 'src', 'renderer', 'src'),
        '@shared': path.join(root, 'src', 'shared')
      }
    },
    server: { host: '127.0.0.1', port: 4317, strictPort: true }
  })
  await viteServer.listen()
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    offscreen: true,
    backgroundColor: '#0b1118',
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: true }
  })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error(`[renderer] ${message}`)
  })
  await win.loadURL('http://127.0.0.1:4317/screenshot-harness.html')
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  await delay(2200)
  await fs.mkdir(output, { recursive: true })

  const capture = async (name) => {
    await delay(850)
    const image = await win.webContents.capturePage()
    await fs.writeFile(path.join(output, name), image.toPNG())
    console.log(`Captured ${name} (${image.getSize().width}x${image.getSize().height})`)
  }
  const clickNav = async (label) => {
    const result = await win.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll('.nav-button')].find((item) => item.textContent.includes(${JSON.stringify(label)})); if (!button) return false; button.click(); return true })()`)
    if (!result) throw new Error(`Could not find navigation button: ${label}`)
    await delay(900)
  }

  await capture('dashboard-demo.png')
  await clickNav('服务器管理')
  await capture('servers-demo.png')
  await clickNav('GPU 资源')
  await capture('gpu-overview-demo.png')
  const openedGpu = await win.webContents.executeJavaScript(`(() => { const card = document.querySelector('.gpu-overview-card'); if (!card) return false; card.click(); return true })()`)
  if (!openedGpu) throw new Error('Could not open a GPU detail panel')
  await delay(900)
  await capture('gpu-detail-demo.png')
  await win.close()
  await viteServer.close()
  app.quit()
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
