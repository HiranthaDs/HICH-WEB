import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Input } from './ui'
import { addPaymentPhase } from '../lib/paymentPlan'
import { formatCurrency, formatDate } from '../lib/format'
import { useToast } from '../context/ToastContext'
import type { Invoice } from '../lib/types'

type Phase = NonNullable<Invoice['payments']>[number]
const cents = (value: unknown) => Math.round(Number(value || 0) * 100)

export function PaymentPlanEditor({ invoice, phases, onChange, onRecord, disabled = false }: {
  invoice: Invoice; phases: Phase[]; onChange: (phases: Phase[]) => void
  onRecord: (index: number) => void; disabled?: boolean
}) {
  const { toast } = useToast()
  const [visitFee, setVisitFee] = useState(0)
  const total = cents(invoice.amount)
  const allocated = phases.reduce((sum, phase) => sum + cents(phase.amount), 0)
  const paid = cents(invoice.paid_amount)
  const currency = invoice.currency || 'LKR'
  const money = (value: number) => formatCurrency(value / 100, currency)
  const update = (index: number, patch: Partial<Phase>) => onChange(phases.map((phase, i) => i === index ? { ...phase, ...patch } : phase))
  const add = (mid = false) => {
    let suffix = phases.length + 1
    let name = mid ? 'Mid-project payment' : `Payment phase ${suffix}`
    while (phases.some(phase => phase.name === name)) name = `${mid ? 'Mid-project payment' : 'Payment phase'} ${++suffix}`
    try { onChange(addPaymentPhase(phases, Number(invoice.amount), name)) }
    catch (error) { toast(error instanceof Error ? error.message : 'Cannot add phase.', 'error') }
  }
  const addVisit = () => {
    if (currency !== 'LKR') return toast('Agree an LKR conversion before adding a visiting fee to a foreign-currency invoice.', 'error')
    if (visitFee < 5000 || visitFee > 15000) return toast('Enter a visiting fee between LKR 5,000 and LKR 15,000.', 'error')
    if (phases.length >= 100 || phases.some(phase => /visiting fee/i.test(phase.name))) return toast('Edit the existing plan before adding another visiting fee.', 'error')
    const fee = cents(visitFee)
    const source = phases.map((phase, index) => ({ phase, index })).reverse().find(({ phase }) => /final|balance/i.test(phase.name) && cents(phase.amount) - cents(phase.paid_amount) >= fee)
    if (!source) return toast('The unpaid final balance must cover the visiting fee.', 'error')
    const next = phases.map(phase => ({ ...phase }))
    next[source.index].amount = (cents(source.phase.amount) - fee) / 100
    next.splice(source.index, 0, { name: 'Visiting fee (credited to project balance)', amount: visitFee, is_paid: false, status: 'Pending' })
    if (next[source.index + 1].amount === 0 && !cents(source.phase.paid_amount)) next.splice(source.index + 1, 1)
    onChange(next)
    setVisitFee(0)
  }
  return <section className="milestone-editor">
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {invoice.invoice_kind !== 'renewal' && <div className="visiting-fee-editor"><Input label="Optional visiting fee (LKR)" type="number" min="5000" max="15000" step="0.01" optional value={visitFee || ''} onChange={event => setVisitFee(Number(event.target.value))} hint="Only add this milestone when a visit and fee have been agreed." /><Button type="button" variant="secondary" onClick={addVisit} disabled={!visitFee}>Add visiting fee</Button></div>}
      <div className="document-toolbar"><Button type="button" variant="secondary" size="sm" onClick={() => add(true)}>Add mid payment</Button><Button type="button" variant="secondary" size="sm" onClick={() => {
        const candidates = phases.map((phase, index) => ({ phase, index })).filter(({ phase }) => cents(phase.amount) > cents(phase.paid_amount))
        const final = candidates.filter(({ phase }) => /final|balance/i.test(phase.name)).at(-1) || candidates.at(-1)
        if (final) onRecord(final.index); else toast('All milestones are paid.', 'success')
      }}>Record final payment</Button></div>
      <header><div><p className="eyebrow">Payment plan</p><h3>Milestones</h3><p>Add up to 100 phases. New phases split the unpaid balance. Save the plan before recording a receipt.</p></div><Button type="button" variant="secondary" icon={Plus} size="sm" onClick={() => add()}>Add phase</Button></header>
      <div className="milestone-summary" aria-live="polite"><span>Project total <strong>{money(total)}</strong></span><span>Allocated <strong>{money(allocated)}</strong></span><span>{allocated === total ? 'Fully allocated' : allocated > total ? 'Over allocated' : 'Still to allocate'} <strong>{money(Math.abs(total - allocated))}</strong></span><span>Paid <strong>{money(paid)}</strong></span><span>Outstanding <strong>{money(Math.max(0, total - paid))}</strong></span></div>
      <div className="milestone-list">{phases.map((phase, index) => {
        const received = cents(phase.paid_amount)
        const complete = received >= cents(phase.amount) && received > 0
        return <div className="milestone-row" key={phase.id || index}>
          <Input label="Phase" value={phase.name} onChange={event => update(index, { name: event.target.value })} />
          <Input label="Amount" type="number" readOnly={Boolean(phase.is_paid ?? phase.isPaid)} min={received / 100 || 0.01} step="0.01" value={phase.amount || ''} onChange={event => update(index, { amount: Number(event.target.value) })} hint={complete ? 'Fully received. Correct the receipt before changing this amount.' : received > 0 ? `Cannot be lower than ${money(received)} already received.` : undefined} />
          <div><small>Payment date</small><p>{phase.paid_at ? formatDate(phase.paid_at) : 'Not received'}</p></div>
          <Button type="button" size="sm" variant="secondary" disabled={complete} onClick={() => onRecord(index)}>{complete ? 'Paid' : received ? 'Record balance' : 'Record payment'}</Button>
          <Button type="button" size="sm" variant="ghost" icon={Trash2} aria-label={`Remove ${phase.name}`} disabled={received > 0 || invoice.payment_records?.some(receipt => receipt.milestone_id === phase.id)} onClick={() => onChange(phases.filter((_, i) => i !== index))} />
          <div className="milestone-row__calculation"><span>{total ? (cents(phase.amount) / total * 100).toFixed(1) : '0.0'}% of project total{received > 0 ? ` · ${money(received)} received` : ''}</span><span>{money(Math.max(0, total - phases.slice(0, index + 1).reduce((sum, item) => sum + cents(item.amount), 0)))} remaining after this milestone</span></div>
        </div>
      })}</div>
    </fieldset>
  </section>
}
