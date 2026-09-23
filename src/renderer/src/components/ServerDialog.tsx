import { useEffect, useState, type FormEvent } from 'react'
import { Eye, EyeOff, KeyRound, Server, X } from 'lucide-react'
import type { AuthType, MonitorPolicy, ServerProfile, ServerProfileInput } from '@shared/types'
import { getAccessRoutes } from '@shared/access-routes'

interface ServerDialogProps {
  server?: ServerProfile | null
  onClose(): void
  onSaved(server: ServerProfile): void
}

export function ServerDialog({ server, onClose, onSaved }: ServerDialogProps): React.JSX.Element {
  const existingJumpRoute = server ? getAccessRoutes(server).find((route) => route.kind === 'jump') : undefined
  const [name, setName] = useState(server?.name ?? '')
  const [host, setHost] = useState(server?.host ?? '')
  const [port, setPort] = useState(server?.port ?? 22)
  const [username, setUsername] = useState(server?.username ?? '')
  const [group, setGroup] = useState(server?.group ?? '实验室服务器')
  const [tags, setTags] = useState(server?.tags.join(', ') ?? '')
  const [monitorPolicy, setMonitorPolicy] = useState<MonitorPolicy>(server?.monitorPolicy ?? 'manual')
  const [authType, setAuthType] = useState<AuthType>(server?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [privateKeyPath, setPrivateKeyPath] = useState(server?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [jumpEnabled, setJumpEnabled] = useState(Boolean(existingJumpRoute?.jumpHost))
  const [jumpTargetHost, setJumpTargetHost] = useState(existingJumpRoute?.host ?? server?.host ?? '')
  const [jumpTargetPort, setJumpTargetPort] = useState(existingJumpRoute?.port ?? server?.port ?? 22)
  const [jumpTargetUsername, setJumpTargetUsername] = useState(existingJumpRoute?.username ?? server?.username ?? '')
  const [jumpHost, setJumpHost] = useState(existingJumpRoute?.jumpHost?.host ?? server?.jumpHost?.host ?? '')
  const [jumpPort, setJumpPort] = useState(existingJumpRoute?.jumpHost?.port ?? server?.jumpHost?.port ?? 22)
  const [jumpUsername, setJumpUsername] = useState(existingJumpRoute?.jumpHost?.username ?? server?.jumpHost?.username ?? '')
  const [jumpAuthType, setJumpAuthType] = useState<AuthType>(existingJumpRoute?.jumpHost?.authType ?? server?.jumpHost?.authType ?? 'password')
  const [jumpPassword, setJumpPassword] = useState('')
  const [jumpPrivateKeyPath, setJumpPrivateKeyPath] = useState(existingJumpRoute?.jumpHost?.privateKeyPath ?? server?.jumpHost?.privateKeyPath ?? '')
  const [jumpPassphrase, setJumpPassphrase] = useState('')
  const [showJumpPassword, setShowJumpPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const choosePrivateKey = async (): Promise<void> => {
    const path = await window.labApi.servers.choosePrivateKey()
    if (path) setPrivateKeyPath(path)
  }

  const chooseJumpPrivateKey = async (): Promise<void> => {
    const path = await window.labApi.servers.choosePrivateKey()
    if (path) setJumpPrivateKeyPath(path)
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError('')
    const directRoute = {
      id: 'direct',
      name: '默认',
      kind: 'direct' as const,
      host,
      port,
      username,
      authType,
      privateKeyPath: authType === 'privateKey' ? privateKeyPath : undefined,
      hostFingerprint: server ? getAccessRoutes(server).find((route) => route.id === 'direct')?.hostFingerprint : undefined
    }
    const jumpGateway = jumpEnabled ? {
      host: jumpHost,
      port: jumpPort,
      username: jumpUsername,
      authType: jumpAuthType,
      privateKeyPath: jumpAuthType === 'privateKey' ? jumpPrivateKeyPath : undefined,
      hostFingerprint: existingJumpRoute?.jumpHost?.hostFingerprint ?? server?.jumpHost?.hostFingerprint,
      password: jumpPassword || undefined,
      passphrase: jumpPassphrase || undefined
    } : undefined
    const input: ServerProfileInput = {
      id: server?.id,
      name,
      host,
      port,
      username,
      group,
      tags: tags
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
      authType,
      password: password || undefined,
      privateKeyPath: authType === 'privateKey' ? privateKeyPath : undefined,
      passphrase: passphrase || undefined,
      mode: server?.mode ?? 'real',
      monitorPolicy,
      accessRoutes: [
        directRoute,
        ...(jumpEnabled ? [{
          id: 'jump',
          name: '跳板机',
          kind: 'jump' as const,
          host: jumpTargetHost,
          port: jumpTargetPort,
          username: jumpTargetUsername,
          authType,
          privateKeyPath: authType === 'privateKey' ? privateKeyPath : undefined,
          hostFingerprint: existingJumpRoute?.hostFingerprint,
          jumpHost: jumpGateway
            ? {
                host: jumpGateway.host,
                port: jumpGateway.port,
                username: jumpGateway.username,
                authType: jumpGateway.authType,
                privateKeyPath: jumpGateway.privateKeyPath,
                hostFingerprint: jumpGateway.hostFingerprint,
                hasSecret: server?.jumpHost?.hasSecret
              }
            : undefined
        }] : [])
      ],
      defaultAccessRouteId: server?.defaultAccessRouteId ?? 'direct',
      jumpHost: jumpGateway
    }
    try {
      const saved = await window.labApi.servers.save(input)
      onSaved(saved)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存服务器失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop app-modal-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="server-dialog app-modal" role="dialog" aria-modal="true" aria-label="添加服务器">
        <div className="dialog-header">
          <div className="dialog-title-wrap">
            <div className="dialog-icon"><Server size={20} /></div>
            <div>
              <h2>{server ? '编辑服务器' : '添加真实服务器'}</h2>
              <p>连接凭据仅加密保存在当前 Windows 用户下</p>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        </div>

        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="field field-wide">
              <span>服务器名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：GPU-03" required />
            </label>
            <label className="field field-host">
              <span>主机地址</span>
              <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="IP 或域名" required />
            </label>
            <label className="field field-port">
              <span>端口</span>
              <input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} required />
            </label>
            <label className="field">
              <span>登录用户名</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="非 root 用户" required />
            </label>
            <label className="field">
              <span>服务器分组</span>
              <input value={group} onChange={(event) => setGroup(event.target.value)} placeholder="实验室服务器" />
            </label>
            <label className="field field-wide">
              <span>标签</span>
              <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="GPU, 训练, 4090（逗号分隔）" />
            </label>
            <label className="field field-wide">
              <span>状态采集策略</span>
              <select value={monitorPolicy} onChange={(event) => setMonitorPolicy(event.target.value as MonitorPolicy)}>
                <option value="manual">手动采集（默认，启动时不连接）</option>
                <option value="onView">按需采集（打开服务器或 GPU 页面时连接）</option>
                <option value="background">持续监控（启动后采集并定时告警）</option>
              </select>
              <small className="field-help">终端、SFTP 和“测试连接”始终可手动使用，不受此策略限制。</small>
            </label>
          </div>

          <div className="auth-section">
            <div className="section-caption"><KeyRound size={16} />认证方式</div>
            <div className="auth-tabs">
              <button type="button" className={authType === 'privateKey' ? 'active' : ''} onClick={() => setAuthType('privateKey')}>SSH 私钥</button>
              <button type="button" className={authType === 'password' ? 'active' : ''} onClick={() => setAuthType('password')}>密码</button>
            </div>

            {authType === 'privateKey' ? (
              <div className="form-grid auth-fields">
                <label className="field field-wide">
                  <span>私钥文件</span>
                  <div className="input-action">
                    <input value={privateKeyPath} readOnly placeholder="选择 OpenSSH 私钥文件" required />
                    <button type="button" className="secondary-button" onClick={choosePrivateKey}>选择</button>
                  </div>
                </label>
                <label className="field field-wide">
                  <span>私钥口令{server?.hasSecret ? '（留空则保持不变）' : '（可选）'}</span>
                  <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="new-password" />
                </label>
              </div>
            ) : (
              <label className="field field-wide auth-fields">
                <span>SSH 密码{server?.hasSecret ? '（已保存，留空则保持不变）' : ''}</span>
                <div className="input-action password-input">
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder={server?.hasSecret ? '已安全保存；输入新密码可替换' : '输入该 Linux 用户的 SSH 密码'} required={!server?.hasSecret} autoFocus />
                  <button type="button" className="icon-button password-toggle" onClick={() => setShowPassword((value) => !value)} title={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                </div>
                <small className="field-help">支持普通 Password 和 PAM Keyboard-Interactive 认证，密码仅加密保存在本机。</small>
              </label>
            )}
          </div>

          <div className="access-section">
            <div className="section-caption"><Server size={16} />连接路径</div>
            <label className="route-toggle"><input type="checkbox" checked={jumpEnabled} onChange={(event) => setJumpEnabled(event.target.checked)} /><span><strong>启用跳板机</strong><small>与默认路径共享同一台服务器记录，操作时可直接切换。</small></span></label>
            {jumpEnabled && <div className="jump-route-card">
              <div className="jump-route-heading"><strong>跳板机路径</strong><span>目标服务器认证复用上方设置</span></div>
              <div className="form-grid">
                <label className="field field-host"><span>跳板路径目标地址</span><input value={jumpTargetHost} onChange={(event) => setJumpTargetHost(event.target.value)} placeholder="目标服务器内网 IP" required={jumpEnabled} /></label>
                <label className="field field-port"><span>目标端口</span><input type="number" min={1} max={65535} value={jumpTargetPort} onChange={(event) => setJumpTargetPort(Number(event.target.value))} required={jumpEnabled} /></label>
                <label className="field"><span>目标用户名</span><input value={jumpTargetUsername} onChange={(event) => setJumpTargetUsername(event.target.value)} required={jumpEnabled} /></label>
                <label className="field field-wide"><span>跳板机地址</span><input value={jumpHost} onChange={(event) => setJumpHost(event.target.value)} placeholder="跳板机 IP 或域名" required={jumpEnabled} /></label>
                <label className="field field-port"><span>跳板端口</span><input type="number" min={1} max={65535} value={jumpPort} onChange={(event) => setJumpPort(Number(event.target.value))} required={jumpEnabled} /></label>
                <label className="field"><span>跳板机用户名</span><input value={jumpUsername} onChange={(event) => setJumpUsername(event.target.value)} required={jumpEnabled} /></label>
              </div>
              <div className="auth-tabs jump-auth-tabs"><button type="button" className={jumpAuthType === 'privateKey' ? 'active' : ''} onClick={() => setJumpAuthType('privateKey')}>跳板机私钥</button><button type="button" className={jumpAuthType === 'password' ? 'active' : ''} onClick={() => setJumpAuthType('password')}>跳板机密码</button></div>
              {jumpAuthType === 'privateKey' ? <div className="form-grid auth-fields"><label className="field field-wide"><span>跳板机私钥</span><div className="input-action"><input value={jumpPrivateKeyPath} readOnly placeholder="选择 OpenSSH 私钥文件" required={jumpEnabled} /><button type="button" className="secondary-button" onClick={chooseJumpPrivateKey}>选择</button></div></label><label className="field field-wide"><span>私钥口令{server?.jumpHost?.hasSecret ? '（留空则保持不变）' : '（可选）'}</span><input type="password" value={jumpPassphrase} onChange={(event) => setJumpPassphrase(event.target.value)} autoComplete="new-password" /></label></div> : <label className="field field-wide auth-fields"><span>跳板机 SSH 密码{server?.jumpHost?.hasSecret ? '（已保存，留空则保持不变）' : ''}</span><div className="input-action password-input"><input type={showJumpPassword ? 'text' : 'password'} value={jumpPassword} onChange={(event) => setJumpPassword(event.target.value)} autoComplete="new-password" placeholder={server?.jumpHost?.hasSecret ? '已安全保存；输入新密码可替换' : '输入跳板机 SSH 密码'} required={jumpEnabled && !server?.jumpHost?.hasSecret} /><button type="button" className="icon-button password-toggle" onClick={() => setShowJumpPassword((value) => !value)} title={showJumpPassword ? '隐藏密码' : '显示密码'}>{showJumpPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>}
            </div>}
          </div>

          {error && <div className="form-error">{error}</div>}
          <div className="dialog-footer">
            <button type="button" className="secondary-button" onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={saving}>{saving ? '正在保存…' : '保存服务器'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
