const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const auditOnly = process.argv.includes('--audit')
const delay = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
app.disableHardwareAcceleration()
setTimeout(() => { console.error('Theme verification timed out'); app.exit(1) }, 120_000).unref()

// Evaluate actual computed text colours against composited ancestor backgrounds.
// Disabled controls and the terminal canvas use their own presentation rules.
function auditText() {
  const parse = value => {
    const numbers = value.match(/[\d.]+/g)?.map(Number) ?? []
    if (value.startsWith('color(srgb')) return [...numbers.slice(0, 3).map(n => n * 255), numbers[3] ?? 1]
    return [...numbers.slice(0, 3), numbers[3] ?? 1]
  }
  const blend = (top, bottom) => top.slice(0, 3).map((n, i) => n * top[3] + bottom[i] * (1 - top[3]))
  const luminance = rgb => rgb.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0)
  const findings = []
  let checked = 0
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement) || el.closest('.sr-only, .xterm, [disabled], [aria-hidden=true]')) continue
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || style.visibility !== 'visible') continue
    const text = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim()
    const inputText = el.matches('input,textarea,select') ? (el.value || el.getAttribute('placeholder') || '') : ''
    if (!text && !inputText) continue
    const layers = []
    let hidden = false
    for (let parent = el; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent)
      if (Number(parentStyle.opacity) === 0 || parentStyle.visibility === 'hidden') { hidden = true; break }
      layers.push(parse(parentStyle.backgroundColor))
    }
    if (hidden) continue
    let background = [255, 255, 255]
    for (const layer of layers.reverse()) background = blend(layer, background)
    let foreground = parse(style.color)
    if (inputText && !el.value && el.getAttribute('placeholder')) {
      const placeholderStyle = getComputedStyle(el, '::placeholder')
      foreground = parse(placeholderStyle.color)
      foreground[3] *= Number(placeholderStyle.opacity)
    }
    foreground = blend(foreground, background)
    const [low, high] = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
    const contrast = (high + .05) / (low + .05)
    const size = parseFloat(style.fontSize)
    const threshold = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5
    checked++
    if (contrast < threshold - .01) findings.push({ text: (text || inputText).slice(0, 70), element: el.tagName.toLowerCase(), className: el.className, foreground: style.color, background: background.map(Math.round), ratio: +contrast.toFixed(2) })
  }
  return { checked, findings }
}

async function main() {
  app.setPath('userData', path.join(root, '.workbench-preview-profile'))
  await app.whenReady()
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), plugins: [
    { name: 'theme-fixture', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/screenshot-init.ts')) return source.replace("Object.defineProperty(window, 'labApi'", "servers[0].jumpHost = { host: 'jump.example.test', port: 2222, username: 'relay', authType: 'privateKey' };\nObject.defineProperty(window, 'labApi'")
    } }, react()],
    resolve: { alias: { '@shared': path.join(root, 'src/shared') } }, server: { host: '127.0.0.1', port: 4322, strictPort: true } })
  await vite.listen()
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false, offscreen: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async code => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay(100) }
    throw new Error(`Timed out: ${code}`)
  }
  const click = async (selector, text) => {
    await run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('Missing: ' + ${JSON.stringify(selector)}); el.click(); })()`)
    await delay()
  }
  await fs.mkdir(path.join(root, 'artifacts/theme-contrast'), { recursive: true })
  const results = []
  for (const theme of ['ocean', 'instrument', 'machineRoom']) {
    await win.loadURL(`http://127.0.0.1:4322/screenshot-harness.html?theme=${theme}`)
    await waitFor('window.__captureReady')
    const sample = async (page, capture = false) => {
      const result = await run(`(${auditText.toString()})()`)
      results.push({ theme, page, ...result })
      await fs.writeFile(path.join(root, `artifacts/theme-contrast/${auditOnly ? 'before' : 'after'}.json`), JSON.stringify(results, null, 2))
      console.log(`${theme}/${page}: ${result.checked} text elements, ${result.findings.length} low contrast`)
      if (capture) {
        win.setSize(1441, 1000); await delay(); win.setSize(1440, 1000); await delay(250)
        await fs.writeFile(path.join(root, `artifacts/theme-contrast/${theme}-${page}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }
    await sample('server', true)
    await click('.wb-host-connection button'); await sample('connection-menu')
    await click('.wb-host-connection [role=option]', '默认')
    await click('.wb-tabs button', '连接与存储'); await sample('connection')
    await click('.wb-connection-actions button', '编辑服务器'); await sample('server-dialog', true)
    await click('.server-dialog .dialog-header .icon-button')
    await click('.wb-tabs button', '历史'); await waitFor('document.querySelectorAll(".history-series").length === 4'); await sample('history', true)
    await click('.wb-tabs button', 'GPU')
    await click('.wb-host-actions button', '连接终端'); await waitFor('window.__labPreview.terminalConnects === 1'); await sample('terminal')
    await click('.wb-gpu-select'); await waitFor('document.querySelectorAll(".history-series").length === 4'); await sample('gpu-detail', true)
    await click('.workbench-modulebar .nav-button', '实验任务'); await sample('tasks', true)
    await click('.experiment-pool-table .wb-text-button', 'LISA 复现 · 已取消')
    await click('.experiment-task-card button', '编辑'); await sample('task-editor', true)
    await click('.app-modal .dialog-header .icon-button');
    await click('.workbench-modulebar > button', '设置'); await sample('settings', true)
    await click('.workbench-modulebar > button', '告警'); await sample('alerts')
    await click('.workbench-modulebar .nav-button', '资源');
    await click('.wb-host-actions button', '打开文件'); await waitFor('document.querySelectorAll(".file-row").length === 2'); await sample('files')
    await click('.workbench-browser-links button', '全部服务器'); await sample('servers')
    await click('.workbench-browser-links button', 'GPU 总览'); await sample('gpu-pool')
  }
  const report = path.join(root, `artifacts/theme-contrast/${auditOnly ? 'before' : 'after'}.json`)
  await fs.writeFile(report, JSON.stringify(results, null, 2))
  const count = results.reduce((sum, r) => sum + r.findings.length, 0)
  console.log(`Total low contrast: ${count}; report: ${report}`)
  win.close(); await vite.close()
  app.exit(!auditOnly && count ? 1 : 0)
}
main().catch(error => { console.error(error); app.exit(1) })
