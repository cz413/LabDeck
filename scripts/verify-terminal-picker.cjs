const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const delay = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
app.disableHardwareAcceleration()
setTimeout(() => { console.error('Terminal picker verification timed out'); app.exit(1) }, 60_000).unref()

async function main() {
  app.setPath('userData', path.join(root, '.workbench-preview-profile'))
  await app.whenReady()
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const fixture = `
const originalList = api.servers.list;
api.servers.list = async () => {
  const list = await originalList();
  list[0].jumpHost = { host: 'jump.example.test', port: 2222, username: 'relay', authType: 'privateKey' };
  return [...list, ...Array.from({ length: 12 }, (_, i) => ({ ...list[1], id: 'picker-' + i, name: 'node-' + i, monitorPolicy: 'manual' }))];
};
window.__pickerRequests = [];
const originalConnect = api.terminal.connect;
api.terminal.connect = async (...args) => { window.__pickerRequests.push(args); return originalConnect(...args); };
`
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    plugins: [{ name: 'picker-fixture', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/screenshot-init.ts')) return source.replace("Object.defineProperty(window, 'labApi'", fixture + "\nObject.defineProperty(window, 'labApi'")
    } }, react()], resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    server: { host: '127.0.0.1', port: 4323, strictPort: true } })
  await vite.listen()
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, offscreen: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error(event.message) } })
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async code => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay(100) }
    throw new Error(`Timed out: ${code}`)
  }
  const check = async (code, label) => { if (!await run(code)) throw new Error(label); console.log(`Passed: ${label}`) }
  const click = async (selector, text) => {
    await run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('Missing: ' + ${JSON.stringify(selector)}); el.click(); })()`)
    await delay()
  }
  const inViewport = `(() => { const el = document.querySelector('#terminal-add-picker'); if (!el || getComputedStyle(el).visibility !== 'visible') return false; const r = el.getBoundingClientRect(); return r.top >= 7 && r.left >= 7 && r.bottom <= innerHeight - 7 && r.right <= innerWidth - 7 && r.height > 0; })()`
  const capture = async name => {
    const [width, height] = win.getSize(); win.setSize(width + 1, height); await delay(); win.setSize(width, height); await delay(250)
    await fs.writeFile(path.join(root, `artifacts/${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true })
  await win.loadURL('http://127.0.0.1:4323/screenshot-harness.html')
  await waitFor('window.__captureReady')
  await click('.workbench-modulebar .nav-button', '终端')
  await click('[aria-label="新建终端会话"]')
  await waitFor(inViewport)
  await check('document.querySelector("#terminal-add-picker").dataset.placement === "below" && document.querySelector("#terminal-add-picker").getBoundingClientRect().top > document.querySelector("[aria-label=新建终端会话]").getBoundingClientRect().bottom', 'fullscreen picker opens below add button and stays inside window')
  await check('document.querySelector("#terminal-add-picker").scrollHeight > document.querySelector("#terminal-add-picker").clientHeight', 'long server list scrolls inside menu')
  await capture('terminal-picker-fullscreen')
  await run('document.querySelector("#terminal-add-picker").scrollTop = 10000')
  await check('document.querySelector("#terminal-add-picker").scrollTop > 0 && !!document.querySelector("#terminal-add-picker .ssh-route-group:last-child")', 'last server remains reachable in long list')
  win.setSize(700, 450); await delay(300)
  await waitFor(inViewport)
  await check(inViewport, 'open picker repositions in short narrow window')
  await capture('terminal-picker-small')
  await run('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))')
  await check('!document.querySelector("#terminal-add-picker") && document.activeElement.getAttribute("aria-label") === "新建终端会话"', 'Escape closes menu and restores button focus')
  await click('[aria-label="新建终端会话"]')
  await run('document.querySelector(".workbench-wordmark").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))')
  await delay()
  await check('!document.querySelector("#terminal-add-picker")', 'outside pointer closes portalled menu')
  await click('[aria-label="选择服务器并打开文件"]'); await waitFor(inViewport)
  await check('document.querySelector("#terminal-add-picker").getAttribute("aria-label") === "选择服务器"', 'file server picker uses the same viewport positioning')
  await run('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))')
  await click('[aria-label="新建终端会话"]'); await waitFor(inViewport)
  await run(`(() => { const el = document.querySelector('#terminal-add-picker .ssh-route-choice.route-jump'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.click(); })()`)
  await waitFor('window.__pickerRequests.length === 1')
  await check('window.__pickerRequests[0][0] === "demo-gpu-01" && window.__pickerRequests[0][3] === "jump" && !document.querySelector("#terminal-add-picker")', 'menu pointer selects correct jump route and closes')
  win.setSize(1440, 900); await delay()
  await click('.workbench-modulebar .nav-button', '资源')
  await click('[aria-label="新建终端会话"]'); await waitFor(inViewport)
  await check('document.querySelector("#terminal-add-picker").dataset.placement === "above" && document.querySelector("#terminal-add-picker").getBoundingClientRect().bottom < document.querySelector("[aria-label=新建终端会话]").getBoundingClientRect().top', 'bottom terminal dock opens menu above button')
  await capture('terminal-picker-dock')
  win.setSize(700, 450); await delay(300); await waitFor(inViewport)
  await check(inViewport, 'bottom dock menu fits short narrow window')
  await run('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))')
  await click('.workbench-dock-heading > button')
  await check('!document.querySelector("#terminal-add-picker")', 'collapsed dock leaves no floating menu')
  if (errors.length) throw new Error(errors.join('\n'))
  win.close(); await vite.close(); app.quit()
}
main().catch(error => { console.error(error); app.exit(1) })
