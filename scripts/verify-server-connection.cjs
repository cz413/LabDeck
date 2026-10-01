const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
app.disableHardwareAcceleration()
const delay = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
setTimeout(() => { console.error('Connection verification timed out'); app.exit(1) }, 60_000).unref()

// Extend the existing isolated preview; all SSH, SFTP and editor calls stay mocked.
const fixture = `
const connectionPreview = { snapshots: [], terminals: [], files: [], editors: [], holdNext: false, release: null };
window.__connectionPreview = connectionPreview;
const originalList = api.servers.list;
api.servers.list = async () => {
  const list = await originalList();
  list[0].jumpHost = { host: 'jump.example.test', port: 2222, username: 'relay', authType: 'privateKey' };
  list[0].accessRoutes = [
    { id: 'direct', name: '默认', kind: 'direct', host: list[0].host, port: 22, username: list[0].username, authType: 'privateKey' },
    { id: 'jump', name: '跳板机', kind: 'jump', host: '10.0.0.8', port: 22, username: 'internal', authType: 'privateKey', jumpHost: list[0].jumpHost }
  ];
  return list;
};
for (const [apiName, method, calls] of [
  ['monitor', 'snapshot', 'snapshots'], ['terminal', 'connect', 'terminals'],
  ['sftp', 'list', 'files'], ['vscode', 'openRemote', 'editors']
]) {
  const original = api[apiName][method];
  api[apiName][method] = async (...args) => {
    connectionPreview[calls].push(args);
    if (calls === 'snapshots' && connectionPreview.holdNext) {
      connectionPreview.holdNext = false;
      await new Promise(resolve => { connectionPreview.release = resolve; });
    }
    return original(...args);
  };
}
`

async function main() {
  app.setPath('userData', path.join(root, '.workbench-preview-profile'))
  await app.whenReady()
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    plugins: [{ name: 'connection-fixture', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/screenshot-init.ts')) return source.replace("Object.defineProperty(window, 'labApi'", fixture + "\nObject.defineProperty(window, 'labApi'")
    } }, react()], resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    server: { host: '127.0.0.1', port: 4321, strictPort: true } })
  await vite.listen()
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, offscreen: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async code => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay() }
    throw new Error(`Timed out: ${code}`)
  }
  const check = async (code, label) => { if (!await run(code)) throw new Error(label); console.log(`Passed: ${label}`) }
  const click = async (selector, text) => {
    await run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('Missing: ' + ${JSON.stringify(selector)}); el.click(); })()`)
    await delay()
  }
  const choose = async text => { await click('.wb-host-connection button'); await click('.wb-host-connection [role=option]', text) }
  await win.loadURL('http://127.0.0.1:4321/screenshot-harness.html')
  await waitFor('window.__captureReady && window.__connectionPreview.snapshots.length >= 3 && !document.querySelector(".wb-refresh").disabled')
  await check('document.querySelector(".wb-host-connection").textContent.includes("连接方式") && document.querySelector(".wb-host-connection button")', 'connection selector visible on default GPU tab')
  await run('window.__connectionPreview.snapshots.length = 0')
  await choose('跳板机')
  await waitFor('window.__connectionPreview.snapshots.some(args => args[0] === "demo-gpu-01" && args[1] === "jump")')
  await check('document.querySelector(".wb-server-identity p").textContent === "internal@10.0.0.8:22" && document.querySelector(".wb-host-connection small").textContent.includes("jump.example.test:2222")', 'switch updates target and jump gateway and refreshes selected route')
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true })
  await run('document.fonts.ready')
  win.setSize(1441, 900)
  await delay(150)
  win.setSize(1440, 900)
  await delay(300)
  await fs.writeFile(path.join(root, 'artifacts/server-connection.png'), (await win.webContents.capturePage()).toPNG())
  await click('.wb-tabs button', '连接与存储')
  await check('new Set([...document.querySelectorAll(".resource-workbench [aria-controls]")].map(el => el.getAttribute("aria-controls"))).size === 2', 'header and connection tab selectors have unique menu IDs')
  await click('.wb-connection-grid .access-route-trigger')
  await click('.wb-connection-grid [role=option]', '默认')
  await check('document.querySelector(".wb-host-connection strong").textContent === "默认" && !document.querySelector(".wb-host-connection small")', 'connection tab and header share selection')
  for (const tab of ['任务', '历史', 'GPU']) {
    await click('.wb-tabs button', tab)
    await check('!!document.querySelector(".wb-host-connection button")', `connection selector stays visible on ${tab} tab`)
  }
  await waitFor('!document.querySelector(".wb-refresh").disabled')
  await run('window.__connectionPreview.holdNext = true; window.__connectionPreview.snapshots.length = 0')
  await click('.wb-refresh')
  await waitFor('!!window.__connectionPreview.release')
  await choose('跳板机')
  await run('window.__connectionPreview.release()')
  await waitFor('window.__connectionPreview.snapshots.some(args => args[0] === "demo-gpu-01" && args[1] === "jump")')
  await check('window.__connectionPreview.snapshots.filter(args => args[0] === "demo-gpu-01").at(-1)[1] === "jump"', 'queued refresh uses latest route after in-flight direct request')
  await click('.wb-host-actions button', 'VS Code')
  await check('window.__connectionPreview.editors.at(-1)[1] === "jump"', 'VS Code receives selected jump route')
  await click('.wb-host-actions button', '连接终端')
  await waitFor('window.__connectionPreview.terminals.length === 1')
  await check('window.__connectionPreview.terminals[0][3] === "jump"', 'terminal receives selected jump route')
  await click('.wb-host-actions button', '打开文件')
  await waitFor('window.__connectionPreview.files.length > 0')
  await check('window.__connectionPreview.files.at(-1)[2] === "jump"', 'files receive selected jump route')
  await click('.workbench-modulebar .nav-button', '资源')
  await click('.sidebar-server-link', 'gpu7')
  await check('document.querySelector(".wb-host-connection").textContent.includes("直连") && !document.querySelector(".wb-host-connection button")', 'single route server displays connection method without an empty dropdown')
  await win.setSize(850, 900)
  await delay()
  await check('document.querySelector(".workbench-main").scrollWidth <= document.querySelector(".workbench-main").clientWidth', 'connection header fits narrow window')
  if (errors.length) throw new Error(errors.join('\n'))
  win.close()
  await vite.close()
  app.quit()
}
main().catch(error => { console.error(error); app.exit(1) })
