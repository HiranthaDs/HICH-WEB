import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

type ToastTone = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  title?: string
  tone: ToastTone
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone, title?: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback((message: string, tone: ToastTone = 'info', title?: string) => {
    const id = Date.now() + Math.random()
    setItems((current) => [...current.slice(-3), { id, message, tone, title }])
    window.setTimeout(() => dismiss(id), 4600)
  }, [dismiss])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((item) => {
          const Icon = item.tone === 'success' ? CheckCircle2 : item.tone === 'error' ? AlertTriangle : Info
          return (
            <div className={`toast toast--${item.tone}`} key={item.id}>
              <Icon size={19} aria-hidden="true" />
              <div className="toast__copy">
                {item.title && <strong>{item.title}</strong>}
                <span>{item.message}</span>
              </div>
              <button className="toast__close" type="button" onClick={() => dismiss(item.id)} aria-label="Dismiss notification">
                <X size={16} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside ToastProvider')
  return context
}
