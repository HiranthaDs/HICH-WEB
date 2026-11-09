import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { formatCurrency } from '../lib/format'
import { StatusPill } from './ui'
import type { Invoice } from '../lib/types'

type Phase = NonNullable<Invoice['payments']>[number]
export const stageReceived = (phase: Phase) => Number(phase.paid_amount ?? ((phase.is_paid ?? phase.isPaid) ? phase.amount : 0))
export const stageBalance = (phase: Phase, restored = 0) => Math.max(0, Math.round((Number(phase.amount) - stageReceived(phase) + restored) * 100) / 100)
export const ordinal = (number: number) => `${number}${number % 100 >= 11 && number % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] || 'th')}`

export function PaymentStageCard({ phase, index, currency, children, initiallyOpen = false }: {
  phase: Phase; index: number; currency?: string; children: ReactNode; initiallyOpen?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const received = stageReceived(phase)
  const paid = Boolean(phase.is_paid ?? phase.isPaid) || (received > 0 && received >= Number(phase.amount))
  return <details className="payment-stage" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className={`payment-stage__number${paid ? ' payment-stage__number--paid' : ''}`}>{index + 1}</span>
      <span className="payment-stage__title"><small>{ordinal(index + 1)} payment</small><strong>{phase.name || 'Name this payment'}</strong><span>{formatCurrency(Number(phase.amount), currency)}</span></span>
      <span className="payment-stage__status"><StatusPill status={paid ? 'paid' : received > 0 ? 'partial' : 'pending'} /><ChevronDown size={18} aria-hidden="true" /></span>
    </summary>
    <div className="payment-stage__body">{children}</div>
  </details>
}
