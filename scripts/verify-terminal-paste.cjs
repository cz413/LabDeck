const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const delay = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
app.disableHardwareAcceleration()
setTimeout(() => { console.error('Paste verification timed out'); app.exit(1) }, 90_000).unref()

const fixture = `
window.__pastePreview = { text: '', writes: [], emit: (sessionId, data) => dataListeners.forEach(listener => listener({ sessionId, data })) };
api.clipboard.readText = async () => window.__pastePreview.text;
api.terminal.write = (sessionId, data) => window.__pastePreview.writes.push({ sessionId, data });
const originalList = api.servers.list;
api.servers.list = async () => {
  const list = await originalList();
  list[0].accessRoutes = [
    { id: 'direct', name: '默认', kind: 'direct', host: list[0].host, port: 22, username: list[0].username, authType: 'privateKey' },
    { id: 'jump', name: '跳板机', kind: 'jump', host: '10.0.0.8', port: 22, username: 'internal', authType: 'privateKey', jumpHost: { host: 'jump.example.test', port: 22, username: 'relay', authType: 'privateKey' } }
  ];
  return list;
};
`

async function main() {
  app.setPath('userData', path.join(root, 'artifacts', 'paste-profile-' + process.pid))
  await app.whenReady()
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    plugins: [{ name: 'paste-fixture', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/screenshot-init.ts')) return source.replace("Object.defineProperty(window, 'labApi'", fixture + "\nObject.defineProperty(window, 'labApi'")
    } }, react()], resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, offscreen: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async code => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay(100) }
    throw new Error('Timed out: ' + code)
  }
  const check = async (code, label) => { if (!await run(code)) throw new Error(label); console.log('Passed: ' + label) }
  const click = async selector => { await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await delay() }
  const capture = async name => {
    win.setSize(1441, 900); await delay(); win.setSize(1440, 900); await delay(300)
    await fs.writeFile(path.join(root, 'artifacts', name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true })
  await win.loadURL(vite.resolvedUrls.local[0] + 'screenshot-harness.html')
  await waitFor('window.__captureReady && document.querySelector(".wb-host-connection button")')
  await check('getComputedStyle(document.querySelector(".workbench-modulebar")).paddingLeft === "0px" && document.querySelector(".workbench-modulebar > button").getBoundingClientRect().left === 0', 'module tabs begin at the window edge')
  for (const theme of ['ocean', 'instrument']) {
    await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    await click('.wb-host-connection .access-route-trigger')
    await run('document.querySelector(".wb-host-connection .access-route-trigger").focus()')
    await check(`(() => { const root = document.querySelector('.wb-host-connection .access-route-select'); const trigger = root.querySelector('button'); const a = getComputedStyle(root), b = getComputedStyle(trigger), m = getComputedStyle(root.querySelector('.access-route-menu')), o = getComputedStyle(root.querySelector('.selected')); return a.padding === '0px' && a.borderWidth === '0px' && a.boxShadow === 'none' && a.backgroundColor === 'rgba(0, 0, 0, 0)' && Math.abs(root.getBoundingClientRect().width - trigger.getBoundingClientRect().width) < 1 && b.boxShadow === 'none' && m.padding === '0px' && m.gap === '0px' && o.borderWidth === '0px' && o.borderRadius === '0px'; })()`, theme + ': route selector has one border and flush menu selection')
    await check(`[...document.querySelectorAll('.access-route-indicator')].every(el => getComputedStyle(el).boxShadow === 'none')`, theme + ': route indicators have no outer halo')
    await capture('route-selector-' + theme)
    await click('.wb-host-connection .access-route-trigger')
  }
  await click('.wb-host-actions button')
  await waitFor('document.querySelector(".terminal-panel .connection-pill.online")')
  const terminalSelector = '.local-terminal-view.active .xterm-helper-textarea'
  // Native browser paste and application clipboard shortcuts must both pass through xterm.
  const multiline = '第一段\r\n第二行\n\n第二段 🙂\n结束'
  const normalized = multiline.replace(/\r?\n/g, '\r')
  const keyPaste = async (text, modifiers, keyCode = 'V') => {
    await run(`window.__pastePreview.text = ${JSON.stringify(text)}; document.querySelector(${JSON.stringify(terminalSelector)}).focus()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await delay(250)
  }
  const assertLast = async (expected, sessionId, label) => {
    await check(`window.__pastePreview.writes.at(-1)?.data === ${JSON.stringify(expected)} && window.__pastePreview.writes.at(-1)?.sessionId === ${JSON.stringify(sessionId)}`, label)
  }
  await keyPaste(multiline, ['control'])
  await assertLast(normalized, 'preview-1', 'Ctrl+V preserves all paragraphs and normalizes mixed line endings')
  await keyPaste('下一段\n中文', ['control', 'shift'])
  await assertLast('下一段\r中文', 'preview-1', 'Ctrl+Shift+V supports subsequent pastes')
  await keyPaste('Shift\r\nInsert', ['shift'], 'Insert')
  await assertLast('Shift\rInsert', 'preview-1', 'Shift+Insert pastes multiline text')
  await run(`(() => { const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(multiline)}); document.querySelector(${JSON.stringify(terminalSelector)}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`)
  await assertLast(normalized, 'preview-1', 'native paste event preserves paragraph breaks')
  await run('window.__pastePreview.emit("preview-1", "\x1b[?2004h")'); await delay()
  const count = await run('window.__pastePreview.writes.length')
  await keyPaste(multiline, ['control'])
  await assertLast('\x1b[200~' + normalized + '\x1b[201~', 'preview-1', 'shell bracketed paste mode wraps the complete text')
  await check(`window.__pastePreview.writes.length === ${count + 1}`, 'keyboard paste sends exactly once')
  await run(`window.__pastePreview.text = ${JSON.stringify(multiline)}; document.querySelector('.terminal-container').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`)
  await delay()
  await assertLast('\x1b[200~' + normalized + '\x1b[201~', 'preview-1', 'right-click paste also honors shell paste mode')
  await click('.workbench-dock-heading > div > button:last-child')
  await waitFor('window.__labPreview.terminalConnects === 2 && document.querySelector(".local-terminal-view.active .connection-pill.online")')
  await keyPaste(multiline, ['control'])
  await assertLast(normalized, 'preview-2', 'local terminal uses the same multiline paste path')
  const largeText = '多段文本 🙂\r\n\r\n'.repeat(3000)
  await keyPaste(largeText, ['control'])
  await assertLast(largeText.replace(/\r?\n/g, '\r'), 'preview-2', 'large multiline clipboard text is not truncated')
  const emptyCount = await run('window.__pastePreview.writes.length')
  await keyPaste('', ['control'])
  await check(`window.__pastePreview.writes.length === ${emptyCount}`, 'empty clipboard sends no terminal input')
  for (const [theme, foreground, background] of [
    ['ocean', 'rgb(226, 229, 232)', 'rgb(25, 27, 29)'],
    ['instrument', 'rgb(38, 50, 56)', 'rgb(251, 252, 252)']
  ]) {
    await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`); await delay()
    await check(`getComputedStyle(document.querySelector('.local-terminal-view.active .xterm-rows')).color === ${JSON.stringify(foreground)} && getComputedStyle(document.querySelector('.local-terminal-view.active .terminal-container')).backgroundColor === ${JSON.stringify(background)}`, theme + ': open terminal updates its foreground and background')
    await check('window.__labPreview.terminalConnects === 2 && window.__labPreview.terminalCloses === 0', theme + ': theme switch preserves terminal sessions')
  }
  await keyPaste(multiline, ['control'])
  await assertLast(normalized, 'preview-2', 'paste keeps working after live theme changes')
  await capture('terminal-multiline-paste')
  await vite.close(); win.destroy(); app.exit(0)
}
main().catch(error => { console.error(error); app.exit(1) })
