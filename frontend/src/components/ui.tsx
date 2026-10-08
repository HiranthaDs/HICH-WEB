import {
  AlertCircle,
  ChevronDown,
  Inbox,
  LoaderCircle,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { classNames, initials, titleCase } from '../lib/format'
import { createPortal } from 'react-dom'

const openDialogs: symbol[] = []

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon: Icon,
  children,
  className,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: LucideIcon
}) {
  return (
    <button
      className={classNames('button', `button--${variant}`, `button--${size}`, className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : Icon ? <Icon size={18} aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  )
}

type FieldProps = {
  label?: string
  hint?: string
  error?: string
  optional?: boolean
  className?: string
}

export function Input({ label, hint, error, optional, className, id, ...props }: InputHTMLAttributes<HTMLInputElement> & FieldProps) {
  const generatedId = useId()
  const inputId = id || generatedId
  return (
    <label className={classNames('field', className)} htmlFor={inputId}>
      {label && <span className="field__label">{label}{optional && <em>Optional</em>}</span>}
      <input id={inputId} className={classNames('input', error && 'input--error')} aria-invalid={Boolean(error)} aria-describedby={error || hint ? `${inputId}-help` : undefined} {...props} />
      {(error || hint) && <small id={`${inputId}-help`} className={error ? 'field__error' : 'field__hint'}>{error || hint}</small>}
    </label>
  )
}

export function Textarea({ label, hint, error, optional, className, id, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps) {
  const generatedId = useId()
  const inputId = id || generatedId
  return (
    <label className={classNames('field', className)} htmlFor={inputId}>
      {label && <span className="field__label">{label}{optional && <em>Optional</em>}</span>}
      <textarea id={inputId} className={classNames('input textarea', error && 'input--error')} aria-invalid={Boolean(error)} aria-describedby={error || hint ? `${inputId}-help` : undefined} {...props} />
      {(error || hint) && <small id={`${inputId}-help`} className={error ? 'field__error' : 'field__hint'}>{error || hint}</small>}
    </label>
  )
}

export function Select({ label, hint, error, optional, className, id, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & FieldProps) {
  const generatedId = useId()
  const inputId = id || generatedId
  return (
    <label className={classNames('field', className)} htmlFor={inputId}>
      {label && <span className="field__label">{label}{optional && <em>Optional</em>}</span>}
      <span className="select-wrap">
        <select id={inputId} className={classNames('input', error && 'input--error')} aria-invalid={Boolean(error)} aria-describedby={error || hint ? `${inputId}-help` : undefined} {...props}>{children}</select>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
      {(error || hint) && <small id={`${inputId}-help`} className={error ? 'field__error' : 'field__hint'}>{error || hint}</small>}
    </label>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search…', label = 'Search' }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
}) {
  return (
    <label className="search-box">
      <span className="sr-only">{label}</span>
      <Search size={17} aria-hidden="true" />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      {value && <button type="button" onClick={() => onChange('')} aria-label="Clear search"><X size={15} /></button>}
    </label>
  )
}

export function StatusPill({ status }: { status?: string }) {
  const safeStatus = status || 'unknown'
  const positive = ['active', 'paid', 'signed', 'published', 'completed']
  const warning = ['pending', 'sent', 'viewed', 'partial', 'lead', 'overdue']
  const muted = ['draft', 'archived', 'void', 'cancelled']
  const tone = positive.includes(safeStatus.toLowerCase()) ? 'positive' : warning.includes(safeStatus.toLowerCase()) ? 'warning' : muted.includes(safeStatus.toLowerCase()) ? 'muted' : 'neutral'
  return <span className={`status status--${tone}`}><i aria-hidden="true" />{titleCase(safeStatus)}</span>
}

export function Avatar({ name, image, size = 'md' }: { name?: string; image?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  return image
    ? <img className={`avatar avatar--${size}`} src={image} alt="" />
    : <span className={`avatar avatar--${size}`} aria-hidden="true">{initials(name)}</span>
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="page-header__action">{action}</div>}
    </header>
  )
}

export function LoadingState({ label = 'Loading workspace…', compact = false }: { label?: string; compact?: boolean }) {
  return <div className={classNames('state-card', compact && 'state-card--compact')} role="status"><LoaderCircle className="spin" size={24} /><span>{label}</span></div>
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <div className="state-card state-card--error" role="alert">
      <span className="state-card__icon"><AlertCircle size={24} /></span>
      <div><strong>{title}</strong><p>{message || 'The request could not be completed. Please try again.'}</p></div>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  )
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }: { icon?: LucideIcon; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Icon size={26} /></span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const dialogKey = useRef(Symbol('dialog'))
  const onCloseRef = useRef(onClose)
  const titleId = useId()
  const descriptionId = useId()
  onCloseRef.current = onClose
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const key = dialogKey.current
    openDialogs.push(key)
    const onKey = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== key) return
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return }
      if (event.key !== 'Tab') return
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || []).filter((element) => element.offsetParent !== null)
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    // Keep the footer above the on-screen keyboard as the visual viewport changes.
    const viewport = window.visualViewport
    const resize = () => {
      shellRef.current?.style.setProperty('--dialog-height', `${viewport?.height || window.innerHeight}px`)
      shellRef.current?.style.setProperty('--dialog-top', `${viewport?.offsetTop || 0}px`)
    }
    resize()
    viewport?.addEventListener('resize', resize)
    viewport?.addEventListener('scroll', resize)
    window.addEventListener('resize', resize)
    document.addEventListener('keydown', onKey)
    document.body.classList.add('modal-open')
    const timer = window.setTimeout(() => {
      const initial = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')
      ;(initial || closeRef.current)?.focus()
    }, 10)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      viewport?.removeEventListener('resize', resize)
      viewport?.removeEventListener('scroll', resize)
      window.removeEventListener('resize', resize)
      openDialogs.splice(openDialogs.indexOf(key), 1)
      if (!openDialogs.length) document.body.classList.remove('modal-open')
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <div ref={shellRef} className="modal-shell" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section ref={dialogRef} className={`modal modal--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
        <header className="modal__header">
          <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
          <button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </section>
    </div>, document.body
  )
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, loading, confirmLabel = 'Delete', warning = 'This action cannot be undone.' }: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description: string
  loading?: boolean
  confirmLabel?: string
  warning?: string
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="sm" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="danger" loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
    </>}>
      <div className="confirm-visual"><AlertCircle size={25} /><p>{warning}</p></div>
    </Modal>
  )
}
