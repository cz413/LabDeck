const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const delay = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms))
app.disableHardwareAcceleration()
setTimeout(() => { console.error('Terminal dock verification timed out'); app.exit(1) }, 90_000).unref()
async function main() {
  app.setPath('userData', path.join(root, '.workbench-preview-profile'))
  await app.whenReady()
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    plugins: [{ name: 'dock-fixture', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/screenshot-init.ts')) return source.replace("Object.defineProperty(window, 'labApi'", `window.__dockResizes = []; api.terminal.resize = (...args) => window.__dockResizes.push(args);\nObject.defineProperty(window, 'labApi'`)
    } }, react()], resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, offscreen: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error(event.message) } })
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async code => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay(100) }
    throw new Error('Timed out: ' + code)
  }
  const check = async (code, label) => { if (!await run(code)) throw new Error(label); console.log('Passed: ' + label) }
  const click = async selector => { await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await delay() }
  const dockHeight = 'document.querySelector(".workbench-terminal-dock").getBoundingClientRect().height'
  const grip = '[aria-label="调整终端高度"]'
  const key = async value => { await run(`document.querySelector('${grip}').dispatchEvent(new KeyboardEvent('keydown', { key: '${value}', bubbles: true }))`); await delay() }
  const capture = async name => {
    const [width, height] = win.getSize(); win.setSize(width + 1, height); await delay(); win.setSize(width, height); await delay(300)
    await fs.writeFile(path.join(root, 'artifacts', name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  const drag = async distance => {
    const pos = await run(`(() => { const r = document.querySelector('${grip}').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...pos })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...pos, button: 'left', clickCount: 1 })
    await delay(80)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y - distance })
    await delay()
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y - distance, button: 'left', clickCount: 1 })
    await delay()
  }
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true })
  const harnessUrl = vite.resolvedUrls.local[0] + 'screenshot-harness.html'
  await win.loadURL(harnessUrl)
  await waitFor('window.__captureReady && document.querySelector(".resource-workbench")')
  await run('localStorage.removeItem("labdeck.terminal-dock-height")')
  await win.loadURL(harnessUrl); await waitFor('window.__captureReady && document.querySelector(".resource-workbench")')
  await check(`!document.querySelector('${grip}')`, 'collapsed terminal leaves no resize handle')
  await click('.wb-host-actions button')
  await waitFor('window.__labPreview.terminalConnects === 1 && document.querySelector(".xterm-screen")')
  await check(`Math.abs(${dockHeight} - 330) < 2`, 'default dock provides 330px of height')
  await waitFor('document.querySelector(".terminal-panel .connection-pill.online")')
  const initialRows = await run('window.__dockResizes.at(-1)?.[2] ?? document.querySelector(".xterm-screen").clientHeight / 18')
  await drag(180)
  await check(`Math.abs(${dockHeight} - 510) < 2 && document.querySelector('.workbench-page').clientHeight >= 159`, 'real pointer drag grows terminal while leaving resource space')
  await capture('terminal-dock-resized')
  await check(`window.__dockResizes.at(-1)?.[2] > ${initialRows} && window.__labPreview.terminalConnects === 1 && window.__labPreview.terminalCloses === 0`, 'xterm and remote rows resize without reconnecting')
  await check('localStorage.getItem("labdeck.terminal-dock-height") === "510" && document.body.style.cursor === "" && document.body.style.userSelect === ""', 'drag completion saves height and clears cursor state')
  await capture('terminal-dock-resized')
  await click('.workbench-dock-heading > button'); await click('.workbench-dock-heading > button')
  await check(`Math.abs(${dockHeight} - 510) < 2 && window.__labPreview.terminalCloses === 0`, 'collapse and reopen preserves size and session')
  await click('[aria-label="全屏终端"]')
  await check(`document.querySelector('.workbench-terminal-dock.fullscreen') && !document.querySelector('${grip}') && window.__labPreview.terminalConnects === 1`, 'full terminal page reuses session without dock height limit')
  await click('[aria-label="返回底部终端"]')
  await check(`document.querySelector('.resource-workbench') && Math.abs(${dockHeight} - 510) < 2`, 'return to bottom restores original resource page and size')
  win.setSize(700, 450); await delay(400); await capture('terminal-dock-small')
  await check(`${dockHeight} <= document.querySelector('.workbench-main').clientHeight * .66 && document.querySelector('.workbench-main').getBoundingClientRect().bottom <= innerHeight`, 'short window bounds the dock inside available space')
  win.setSize(1440, 900); await delay(400); await capture('terminal-dock-restored')
  await waitFor(`Math.abs(${dockHeight} - 510) < 2`)
  await check(`Math.abs(${dockHeight} - 510) < 2`, 'larger window restores preferred size after automatic clamping')
  await drag(-100)
  await check(`Math.abs(${dockHeight} - 410) < 2`, 'dragging downward shrinks terminal')
  await key('Home'); await check(`Math.abs(${dockHeight} - 180) < 2`, 'keyboard can reach minimum height')
  await key('ArrowUp'); await check(`Math.abs(${dockHeight} - 204) < 2`, 'keyboard adjusts height in small increments')
  await key('End'); await check('document.querySelector(".workbench-page").clientHeight >= 159', 'maximum resize keeps resource area usable')
  await run(`document.querySelector('${grip}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`); await delay()
  await check(`Math.abs(${dockHeight} - 330) < 2`, 'double click restores default height')
  await key('ArrowUp')
  await win.loadURL(harnessUrl); await waitFor('window.__captureReady && document.querySelector(".resource-workbench")')
  await click('.workbench-dock-heading > button')
  await check(`Math.abs(${dockHeight} - 354) < 2`, 'saved height survives renderer restart')
  if (errors.length) throw new Error(errors.join('\n'))
  win.close(); await vite.close(); app.quit()
}
main().catch(error => { console.error(error); app.exit(1) })
