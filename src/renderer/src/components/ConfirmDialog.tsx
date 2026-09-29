import { useEffect } from 'react'
import { AlertTriangle, X } from 'lucide-react'

export interface ConfirmationRequest {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
}

interface ConfirmDialogProps extends ConfirmationRequest {
  onConfirm(): void
  onCancel(): void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return <div className="app-modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
    <section className={`confirm-dialog app-modal ${tone}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message">
      <header className="dialog-header app-modal-header">
        <div className="dialog-title-wrap app-modal-title">
          <div className={`dialog-icon ${tone}`}><AlertTriangle size={19} /></div>
          <div>
            <h2 id="confirm-dialog-title">{title}</h2>
            <p>请确认此操作</p>
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="取消"><X size={18} /></button>
      </header>
      <div className="confirm-dialog-message" id="confirm-dialog-message">{message}</div>
      <footer className="dialog-footer app-modal-footer">
        <button type="button" className="secondary-button" onClick={onCancel} autoFocus>{cancelLabel}</button>
        <button type="button" className={tone === 'danger' ? 'danger-button' : 'primary-button'} onClick={onConfirm}>{confirmLabel}</button>
      </footer>
    </section>
  </div>
}
