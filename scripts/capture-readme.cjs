// Capture the real renderer with isolated, fictional SSH/SFTP fixtures.
// Run with node_modules/electron/dist/electron.exe scripts/capture-readme.cjs.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'artifacts', `readme-profile-${process.pid}`))
setTimeout(() => { console.error('README capture timed out'); app.exit(1) }, 90_000).unref()

async function main() {
  await app.whenReady()
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(root, 'src/shared') } }, server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/screenshot-harness.html`
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false, offscreen: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message)
  })
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async code => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay(100) }
    throw new Error(`Timed out: ${code}`)
  }
  const click = async (selector, text) => {
    await run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('Missing capture control'); el.click() })()`)
    await delay(200)
  }
  const capture = async name => {
    await run('document.fonts.ready')
    const [width, height] = win.getSize()
    win.setSize(width + 1, height)
    await delay(150)
    win.setSize(width, height)
    await delay(300)
    await fs.writeFile(path.join(root, 'docs/screenshots', name), (await win.webContents.capturePage()).toJPEG(90))
    console.log(`Captured ${name}`)
  }
  const load = async theme => {
    await win.loadURL(`${url}?theme=${theme}`)
    await waitFor('window.__captureReady && document.querySelectorAll(".wb-gpu-table tbody tr").length === 4')
  }
  await load('ocean')
  await capture('workbench-dark.jpg')
  await click('[aria-label="查看 GPU 2 详情"]')
  await waitFor('document.querySelector(".wb-device-page") && document.querySelectorAll(".history-series").length === 4')
  await capture('gpu-detail-workbench.jpg')
  await click('.workbench-modulebar .nav-button', '实验任务')
  await waitFor('document.querySelectorAll(".experiment-pool-table tbody tr").length === 4')
  await capture('experiment-tasks.jpg')
  await click('.sidebar-server-link', 'gpu8')
  await click('.wb-host-actions button', '连接终端')
  await waitFor('window.__labPreview.terminalConnects === 1 && document.querySelector(".xterm-screen")')
  await delay(500)
  await capture('terminal-dock.jpg')
  await click('.wb-host-actions button', '打开文件')
  await waitFor('document.querySelectorAll(".file-row").length === 2')
  await capture('files-workspace.jpg')
  await load('instrument')
  await waitFor('document.documentElement.dataset.theme === "instrument"')
  await capture('workbench-light.jpg')
  if (errors.length) throw new Error(errors.join('\n'))
  win.close()
  await vite.close()
  app.quit()
}
main().catch(error => { console.error(error); app.exit(1) })
