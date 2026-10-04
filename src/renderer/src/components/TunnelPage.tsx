import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Copy, ExternalLink, Network, Pencil, Play, Plus, RefreshCw, Square, Trash2, X } from 'lucide-react'
import type { ServerProfile, TunnelConfigInput, TunnelView } from '@shared/types'
import { getAccessRoutes, getDefaultAccessRouteId, routeLabel } from '@shared/access-routes'
import type { ConfirmationRequest } from './ConfirmDialog'

export interface TunnelRequest { id: number; serverId: string; accessRouteId: string }
interface Props {
  tunnels: TunnelView[]
  servers: ServerProfile[]
  request: TunnelRequest | null
  onRequestHandled(): void
  onChanged(): Promise<void>
  onTrusted(): Promise<void>
  notify(message: string, kind?: 'success' | 'error'): void
  confirm(request: ConfirmationRequest): Promise<boolean>
}
const statusNames = { stopped: '已停止', starting: '正在连接', running: '转发已启动', reconnecting: '等待重连', error: '启动失败' }
const active = (tunnel: TunnelView): boolean => ['starting', 'running', 'reconnecting'].includes(tunnel.status)
const address = (host: string, port: number): string => `${host.includes(':') ? `[${host}]` : host}:${port}`
const localAddress = (tunnel: TunnelView): string => address(tunnel.bindAddress === '0.0.0.0' ? '127.0.0.1' : tunnel.bindAddress === '::' ? '::1' : tunnel.bindAddress, tunnel.bindPort)
const copyAddress = (tunnel: TunnelView): string => `${tunnel.type === 'local' && tunnel.browserProtocol !== 'none' ? `${tunnel.browserProtocol}://` : ''}${tunnel.type === 'local' ? localAddress(tunnel) : address(tunnel.bindAddress, tunnel.bindPort)}`
const templates = [{ name: '自定义', port: 8080, protocol: 'none' }, { name: 'Jupyter', port: 8888, protocol: 'http' }, { name: 'TensorBoard', port: 6006, protocol: 'http' }, { name: 'Gradio', port: 7860, protocol: 'http' }] as const

export function TunnelPage(props: Props): React.JSX.Element {
  const realServers = props.servers.filter(server => server.mode === 'real')
  const [draft, setDraft] = useState<TunnelConfigInput | null>(null)
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [editorError, setEditorError] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const savedFocus = useRef<HTMLElement | null>(null)
  const selectedServer = realServers.find(server => server.id === draft?.serverId)
  const routes = selectedServer ? getAccessRoutes(selectedServer) : []

  const newDraft = (serverId?: string, accessRouteId?: string): TunnelConfigInput | null => {
    if (serverId && props.servers.some(server => server.id === serverId && server.mode !== 'real')) return null
    const server = realServers.find(item => item.id === serverId) ?? realServers[0]
    if (!server) return null
    return { name: '', serverId: server.id, accessRouteId: accessRouteId ?? getDefaultAccessRouteId(server), type: 'local', bindAddress: '127.0.0.1', bindPort: 8888, targetHost: '127.0.0.1', targetPort: 8888, browserProtocol: 'http', autoReconnect: true, autoStart: false }
  }
  const edit = (value: TunnelConfigInput | null): void => { setEditorError(''); setDraft(value) }
  useEffect(() => {
    if (!props.request) return
    const value = newDraft(props.request.serverId, props.request.accessRouteId)
    if (value) edit(value)
    else props.notify('请先添加真实服务器，再创建 SSH 隧道', 'error')
    props.onRequestHandled()
  }, [props.request?.id])

  useEffect(() => {
    if (!draft) return
    savedFocus.current = document.activeElement as HTMLElement
    const onKeyDown = (event: KeyboardEvent): void => {
      // A host-key confirmation is stacked above the editor; it owns keyboard focus.
      if (document.querySelector('[role="alertdialog"]')) return
      if (event.key === 'Escape' && !busy.has('save')) { event.preventDefault(); setDraft(null) }
      if (event.key === 'Tab') {
        const controls = [...(formRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary') ?? [])]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); savedFocus.current?.focus() }
  }, [Boolean(draft), busy.has('save')])

  const run = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setBusy(current => new Set(current).add(key))
    try { await operation(); await props.onChanged() }
    catch (error) { props.notify(error instanceof Error ? error.message : '隧道操作失败', 'error') }
    finally { setBusy(current => { const next = new Set(current); next.delete(key); return next }) }
  }
  const start = async (tunnel: TunnelView): Promise<void> => {
    let result = await window.labApi.tunnels.start(tunnel.id)
    for (let attempt = 0; attempt < 2 && result.status === 'host-key-required'; attempt++) {
      const trusted = await props.confirm({ title: '信任 SSH 主机指纹？', message: `连接${result.hostKeyTarget === 'jumpHost' ? '跳板机' : '目标服务器'}前，请核对以下指纹：\n\n${result.fingerprint}`, confirmLabel: '信任并继续' })
      if (!trusted) return
      await window.labApi.servers.trustHost(tunnel.serverId, result.fingerprint, result.hostKeyTarget, tunnel.accessRouteId)
      await props.onTrusted()
      result = await window.labApi.tunnels.start(tunnel.id)
    }
    if (result.status === 'started') props.notify(`${tunnel.name}：转发已启动`)
    else if (result.status === 'failed') props.notify(result.message, 'error')
  }
  const save = async (startNow: boolean): Promise<void> => {
    if (!draft || !formRef.current?.reportValidity()) return
    const value = draft
    setBusy(current => new Set(current).add('save'))
    setEditorError('')
    try {
      const saved = await window.labApi.tunnels.save(value)
      await props.onChanged()
      setDraft(null)
      if (startNow) await run(`start:${saved.id}`, () => start(saved))
      else props.notify('隧道配置已保存')
    } catch (error) { setEditorError(error instanceof Error ? error.message : '保存隧道失败') }
    finally { setBusy(current => { const next = new Set(current); next.delete('save'); return next }) }
  }
  const patch = (value: Partial<TunnelConfigInput>): void => setDraft(current => current ? { ...current, ...value } : null)
  const visible = props.tunnels.filter(tunnel => filter === 'all' || tunnel.serverId === filter)
  const count = props.tunnels.filter(active).length

  return <section className="tunnel-page">
    <header className="workbench-page-heading"><div><h1>SSH 隧道</h1><p>通过服务器访问远程服务，或让服务器访问本机端口</p></div><button className="primary-button" disabled={!realServers.length} onClick={() => edit(newDraft())}><Plus size={14} />新建隧道</button></header>
    <div className="tunnel-toolbar"><label>服务器<select aria-label="隧道服务器筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部服务器</option>{props.servers.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label><span>{props.tunnels.length} 条配置 · {count} 条活动隧道</span><small>关闭终端不影响隧道，退出应用会停止转发</small></div>
    {visible.length ? <div className="wb-table-scroll"><table className="wb-table tunnel-table"><thead><tr><th>名称 / 连接路径</th><th>转发关系</th><th>状态</th><th>操作</th></tr></thead><tbody>{visible.map(tunnel => {
      const server = props.servers.find(item => item.id === tunnel.serverId)
      const routeExists = server && getAccessRoutes(server).some(route => route.id === tunnel.accessRouteId)
      const isActive = active(tunnel)
      return <tr key={tunnel.id}><td><strong>{tunnel.name}</strong><small className="wb-cell-secondary">{server?.name ?? '服务器已删除'} · {routeExists ? routeLabel(server!, tunnel.accessRouteId) : '路径已删除'}</small>{tunnel.autoStart && <small className="wb-cell-secondary">随应用启动</small>}</td>
        <td><div className="tunnel-mapping"><span>{tunnel.type === 'local' ? '本机' : server?.name ?? '远程'} {address(tunnel.bindAddress, tunnel.bindPort)}</span><ArrowRight size={13} /><span>{tunnel.type === 'local' ? '远程目标' : '本机目标'} {address(tunnel.targetHost, tunnel.targetPort)}</span></div><small className="wb-cell-secondary">{tunnel.type === 'local' ? '本地转发' : '远程转发'}{tunnel.autoReconnect ? ' · 断线重连' : ''}</small></td>
        <td><span className={`wb-state ${tunnel.status === 'running' ? 'running' : tunnel.status === 'error' ? 'failed' : tunnel.status === 'reconnecting' ? 'queued' : 'paused'}`}><i />{statusNames[tunnel.status]}</span>{tunnel.status === 'running' && <small className="wb-cell-secondary">{tunnel.serviceStatus === 'reachable' ? '目标端口可达' : tunnel.serviceStatus === 'unreachable' ? '目标端口不可达' : '目标服务尚未检测'} · {tunnel.connectionCount} 个连接</small>}{tunnel.message && <small className="tunnel-error" title={tunnel.message}>{tunnel.message}</small>}</td>
        <td><div className="tunnel-actions">{isActive ? <button className="wb-text-button" aria-label={`停止隧道 ${tunnel.name}`} onClick={() => void run(`stop:${tunnel.id}`, () => window.labApi.tunnels.stop(tunnel.id))}><Square size={13} />停止</button> : <button className="wb-text-button" disabled={!routeExists || busy.has(`start:${tunnel.id}`)} aria-label={`启动隧道 ${tunnel.name}`} onClick={() => void run(`start:${tunnel.id}`, () => start(tunnel))}><Play size={13} />启动</button>}
          {tunnel.type === 'local' && tunnel.browserProtocol !== 'none' && <button className="icon-button small" title="打开浏览器" aria-label={`打开 ${tunnel.name}`} disabled={tunnel.status !== 'running'} onClick={() => void run(`open:${tunnel.id}`, () => window.labApi.tunnels.openBrowser(tunnel.id))}><ExternalLink size={14} /></button>}
          <button className="icon-button small" title={tunnel.type === 'local' ? '复制本机访问地址' : '复制服务器监听地址'} aria-label={`复制隧道地址 ${tunnel.name}`} onClick={() => void run(`copy:${tunnel.id}`, async () => { await window.labApi.clipboard.writeText(copyAddress(tunnel)); props.notify(tunnel.type === 'local' ? '已复制本机访问地址' : '已复制服务器监听地址') })}><Copy size={14} /></button>
          <button className="icon-button small" title="检测目标 TCP 端口" aria-label={`检测隧道目标 ${tunnel.name}`} disabled={tunnel.status !== 'running' || busy.has(`check:${tunnel.id}`)} onClick={() => void run(`check:${tunnel.id}`, async () => { const result = await window.labApi.tunnels.checkTarget(tunnel.id); props.notify(result.message, result.reachable ? 'success' : 'error') })}><RefreshCw size={14} className={busy.has(`check:${tunnel.id}`) ? 'spin' : ''} /></button>
          <button className="icon-button small" title={isActive ? '请先停止，再编辑' : '编辑隧道'} aria-label={`编辑隧道 ${tunnel.name}`} disabled={isActive} onClick={() => edit(tunnel)}><Pencil size={14} /></button>
          <button className="icon-button small danger" title="删除隧道" aria-label={`删除隧道 ${tunnel.name}`} onClick={() => void run(`delete:${tunnel.id}`, async () => { if (await props.confirm({ title: '删除隧道？', message: `删除“${tunnel.name}”的配置${isActive ? '并停止现有转发与连接' : ''}。`, confirmLabel: '删除', tone: 'danger' })) await window.labApi.tunnels.remove(tunnel.id) })}><Trash2 size={14} /></button>
        </div></td></tr>
    })}</tbody></table></div> : <div className="tunnel-empty"><Network size={30} /><h2>{props.tunnels.length ? '没有匹配的隧道' : '把远程服务接到本机'}</h2><p>{!realServers.length ? '先添加真实服务器或导入 SSH Config，再创建隧道。' : '为 Jupyter、TensorBoard 或其他服务保存转发配置，需要时一键启动。'}</p>{realServers.length > 0 && <button className="secondary-button" onClick={() => edit(newDraft(filter === 'all' ? undefined : filter))}><Plus size={14} />新建隧道</button>}</div>}
    {draft && <div className="app-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy.has('save')) setDraft(null) }}><form ref={formRef} className="app-modal tunnel-editor" role="dialog" aria-modal="true" aria-labelledby="tunnel-editor-title" onSubmit={event => { event.preventDefault(); void save(false) }}>
      <header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><Network size={19} /></div><div><h2 id="tunnel-editor-title">{draft.id ? '编辑 SSH 隧道' : '新建 SSH 隧道'}</h2><p>沿用服务器的认证信息和连接路径</p></div></div><button type="button" className="icon-button" aria-label="关闭隧道配置" disabled={busy.has('save')} onClick={() => setDraft(null)}><X size={18} /></button></header>
      <div className="tunnel-editor-body"><fieldset disabled={busy.has('save')}>
        <div className="tunnel-templates" aria-label="隧道模板">{templates.map(template => <button type="button" className="secondary-button" key={template.name} onClick={() => patch({ name: template.name === '自定义' ? '' : template.name, type: 'local', bindPort: template.port, targetPort: template.port, targetHost: '127.0.0.1', browserProtocol: template.protocol })}>{template.name}</button>)}</div>
        <div className="form-grid"><label className="field field-wide"><span>名称</span><input autoFocus required maxLength={80} value={draft.name} placeholder="例如：gpu8 Jupyter" onChange={event => patch({ name: event.target.value })} /></label>
          <label className="field"><span>SSH 服务器</span><select required value={draft.serverId} onChange={event => { const server = realServers.find(item => item.id === event.target.value)!; patch({ serverId: server.id, accessRouteId: getDefaultAccessRouteId(server) }) }}>{realServers.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label>
          <label className="field"><span>连接路径</span><select required value={draft.accessRouteId} onChange={event => patch({ accessRouteId: event.target.value })}>{!routes.some(route => route.id === draft.accessRouteId) && <option value="">请选择有效路径</option>}{routes.map(route => <option key={route.id} value={route.id}>{route.name} · {route.host}:{route.port}</option>)}</select></label>
          <label className="field field-wide"><span>转发类型</span><select value={draft.type} onChange={event => patch({ type: event.target.value as 'local' | 'remote' })}><option value="local">本地转发 — 本机访问远程服务</option><option value="remote">远程转发 — 服务器访问本机服务</option></select></label>
        </div>
        <div className="tunnel-diagram" aria-label="转发方向"><div><small>{draft.type === 'local' ? '本机监听' : '服务器监听'}</small><strong>{address(draft.bindAddress, draft.bindPort)}</strong></div><ArrowRight size={18} /><div><small>SSH 加密连接</small><strong>{selectedServer?.name ?? '选择服务器'}</strong><span>{selectedServer && routeLabel(selectedServer, draft.accessRouteId)}</span></div><ArrowRight size={18} /><div><small>{draft.type === 'local' ? '远程目标' : '本机目标'}</small><strong>{address(draft.targetHost, draft.targetPort)}</strong></div></div>
        <div className="form-grid"><label className="field"><span>{draft.type === 'local' ? '本机监听端口' : '服务器监听端口'}</span><input required type="number" min={1} max={65535} step={1} value={draft.bindPort || ''} onChange={event => patch({ bindPort: Number(event.target.value) })} /></label>
          <label className="field"><span>目标端口</span><input required type="number" min={1} max={65535} step={1} value={draft.targetPort || ''} onChange={event => patch({ targetPort: Number(event.target.value) })} /></label>
          <label className="field field-wide"><span>{draft.type === 'local' ? '目标地址（从远程服务器访问）' : '目标地址（从本机访问）'}</span><input required maxLength={253} value={draft.targetHost} onChange={event => patch({ targetHost: event.target.value })} /><small className="field-help">127.0.0.1 指{draft.type === 'local' ? 'SSH 目标服务器自身' : '运行 LabDeck 的电脑'}。</small></label>
        </div>
        <details className="tunnel-advanced" open={draft.bindAddress !== '127.0.0.1' || undefined}><summary>高级选项</summary><div className="form-grid"><label className="field"><span>监听地址</span><input required value={draft.bindAddress} onChange={event => patch({ bindAddress: event.target.value })} /><small className="field-help">默认仅本机回环；0.0.0.0 允许其他电脑访问监听端口。远程监听范围受服务器 GatewayPorts 配置限制。</small></label><label className="field"><span>浏览器访问协议</span><select value={draft.browserProtocol} onChange={event => patch({ browserProtocol: event.target.value as TunnelConfigInput['browserProtocol'] })}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="none">非网页服务</option></select><small className="field-help">用于本地转发的浏览器入口，不会转换服务协议。</small></label></div><label className="tunnel-check"><input type="checkbox" checked={draft.autoReconnect} onChange={event => patch({ autoReconnect: event.target.checked })} />断线后自动重连</label><label className="tunnel-check"><input type="checkbox" checked={draft.autoStart} onChange={event => patch({ autoStart: event.target.checked })} />随 LabDeck 启动（需已信任主机指纹）</label></details>
      </fieldset>{editorError && <p className="tunnel-error" role="alert">{editorError}</p>}</div>
      <footer className="dialog-footer app-modal-footer"><button type="button" className="secondary-button" disabled={busy.has('save')} onClick={() => setDraft(null)}>取消</button><button type="submit" className="secondary-button" disabled={busy.has('save')}>保存配置</button><button type="button" className="primary-button" disabled={busy.has('save')} onClick={() => void save(true)}><Play size={14} />{busy.has('save') ? '保存中…' : '保存并启动'}</button></footer>
    </form></div>}
  </section>
}
