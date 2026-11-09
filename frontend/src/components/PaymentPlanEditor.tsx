import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Input } from './ui'
import { AmountInput } from './AmountInput'
import { PaymentStageCard, stageReceived } from './PaymentStageCard'
import { addPaymentPhase } from '../lib/paymentPlan'
import { formatCurrency, formatDate } from '../lib/format'
import { useToast } from '../context/ToastContext'
import type { Invoice } from '../lib/types'

type Phase = NonNullable<Invoice['payments']>[number]
const cents = (value: unknown) => Math.round(Number(value || 0) * 100)

export function PaymentPlanEditor({ invoice, phases, onChange, onRecord, disabled = false, dirty = false }: {
  invoice: Invoice; phases: Phase[]; onChange: (phases: Phase[]) => void
  onRecord: (index: number) => void; disabled?: boolean; dirty?: boolean
}) {
  const { toast } = useToast()
  const [visitFee, setVisitFee] = useState(0)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState(0)
  const total = cents(invoice.amount)
  const allocated = phases.reduce((sum, phase) => sum + cents(phase.amount), 0)
  const currency = invoice.currency || 'LKR'
  const money = (value: number) => formatCurrency(value / 100, currency)
  const update = (index: number, patch: Partial<Phase>) => onChange(phases.map((phase, i) => i === index ? { ...phase, ...patch } : phase))
  const startAdding = () => {
    let suffix = 1
    let nextName = 'Additional payment'
    while (phases.some(phase => phase.name === nextName)) nextName = `Additional payment ${++suffix}`
    try {
      const next = addPaymentPhase(phases, Number(invoice.amount), nextName)
      setName(nextName); setAmount(next.find(phase => phase.name === nextName)!.amount); setAdding(true)
    } catch (error) { toast(error instanceof Error ? error.message : 'Cannot add stage.', 'error') }
  }
  let preview: Phase[] | null = null
  let previewError = ''
  if (adding) {
    try {
      if (!name.trim()) throw new Error('Give this payment a name.')
      if (phases.some(phase => phase.name.trim().toLowerCase() === name.trim().toLowerCase())) throw new Error('Choose a different name for this payment.')
      preview = addPaymentPhase(phases, Number(invoice.amount), name.trim(), amount)
    } catch (error) { previewError = error instanceof Error ? error.message : 'Check this stage.' }
  }
  const addVisit = () => {
    if (currency !== 'LKR') return toast('Agree an LKR conversion before adding a visiting fee to a foreign-currency invoice.', 'error')
    if (visitFee < 5000 || visitFee > 15000) return toast('Enter a visiting fee between LKR 5,000 and LKR 15,000.', 'error')
    if (phases.length >= 100 || phases.some(phase => /visiting fee/i.test(phase.name))) return toast('Edit the existing plan before adding another visiting fee.', 'error')
    const fee = cents(visitFee)
    const source = phases.map((phase, index) => ({ phase, index })).reverse().find(({ phase }) => /final|balance/i.test(phase.name) && cents(phase.amount) - cents(stageReceived(phase)) >= fee)
    if (!source) return toast('The unpaid final balance must cover the visiting fee.', 'error')
    const next = phases.map(phase => ({ ...phase }))
    next[source.index].amount = (cents(source.phase.amount) - fee) / 100
    next.splice(source.index, 0, { name: 'Visiting fee (credited to project balance)', amount: visitFee, is_paid: false, status: 'Pending' })
    if (next[source.index + 1].amount === 0 && !cents(stageReceived(source.phase))) next.splice(source.index + 1, 1)
    onChange(next); setVisitFee(0)
  }
  return <section className="milestone-editor payment-plan">
    <fieldset disabled={disabled} className="payment-fieldset">
      <header><div><p className="eyebrow">Payment plan</p><h3>{phases.length} payment {phases.length === 1 ? 'stage' : 'stages'}</h3><p>Tap a stage to edit it. Adding a stage divides the unpaid balance.</p></div></header>
      <p className={`payment-allocation${allocated !== total ? ' payment-allocation--warning' : ''}`} role="status">{allocated === total ? `Plan total ${money(allocated)} · Matches invoice` : `${money(Math.abs(total - allocated))} ${allocated > total ? 'over allocated' : 'still to allocate'}`}</p>
      <div className="milestone-list">{phases.map((phase, index) => {
        const received = cents(stageReceived(phase))
        const complete = received >= cents(phase.amount) && received > 0
        return <PaymentStageCard key={phase.id || `new-${index}`} phase={phase} index={index} currency={currency} initiallyOpen={!phase.id}>
          <div className="form-grid">
            <Input className="form-grid__full" label="Stage name" value={phase.name} maxLength={200} onChange={event => update(index, { name: event.target.value })} />
            <AmountInput label={`Stage amount (${currency})`} readOnly={complete} min={received / 100 || 0.01} value={phase.amount || ''} onValueChange={value => update(index, { amount: Number(value) })} hint={complete ? 'Fully received. Edit its receipt to correct a payment.' : received > 0 ? `${money(received)} already received.` : undefined} />
            <div className="payment-stage__balance"><small>Remaining to receive</small><strong>{money(Math.max(0, cents(phase.amount) - received))}</strong><small>{phase.paid_at ? `Last paid ${formatDate(phase.paid_at)}` : 'No payment date recorded'}</small></div>
          </div>
          <div className="payment-stage__actions"><Button type="button" variant="secondary" disabled={complete || dirty || !phase.id} onClick={() => onRecord(index)}>{complete ? 'Paid in full' : 'Record payment'}</Button><Button type="button" variant="ghost" icon={Trash2} aria-label={`Remove ${phase.name}`} disabled={received > 0 || invoice.payment_records?.some(receipt => receipt.milestone_id === phase.id)} onClick={() => onChange(phases.filter((_, i) => i !== index))}>Remove</Button></div>
        </PaymentStageCard>
      })}</div>
      {adding ? <div className="payment-add-stage">
        <h3>Add a payment stage</h3>
        <Input label="New stage name" value={name} maxLength={200} onChange={event => setName(event.target.value)} />
        <AmountInput label={`New stage amount (${currency})`} min="0.01" value={amount || ''} onValueChange={value => setAmount(Number(value))} />
        <div className="payment-add-stage__preview" aria-live="polite">{preview ? <><strong>After adding this stage</strong>{preview.filter(phase => !phases.some(old => old.name === phase.name && cents(old.amount) === cents(phase.amount))).map(phase => <p key={phase.name}><span>{phase.name}</span><b>{formatCurrency(phase.amount, currency)}</b></p>)}<small>Invoice total stays {money(total)}. Received payments stay the same.</small></> : <p className="field__error">{previewError}</p>}</div>
        <div className="payment-stage__actions"><Button type="button" disabled={!preview} onClick={() => { if (preview) { onChange(preview); setAdding(false) } }}>Add to plan</Button><Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel stage</Button></div>
      </div> : <Button className="payment-plan__add" type="button" variant="secondary" icon={Plus} disabled={phases.length >= 100} onClick={startAdding}>Add payment stage</Button>}
      {invoice.invoice_kind !== 'renewal' && <details className="payment-extra"><summary>Optional visiting fee</summary><div className="visiting-fee-editor"><AmountInput label="Visiting fee (LKR)" min="5000" max="15000" value={visitFee || ''} onValueChange={value => setVisitFee(Number(value))} hint="LKR 5,000–15,000, credited from the final balance." /><Button type="button" variant="secondary" onClick={addVisit} disabled={!visitFee}>Add visiting fee</Button></div></details>}
    </fieldset>
  </section>
}
