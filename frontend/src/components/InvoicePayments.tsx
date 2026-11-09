import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Modal, Select } from './ui'
import { api, deletionPin } from '../lib/api'
import { formatCurrency, formatDate } from '../lib/format'
import { useToast } from '../context/ToastContext'
import type { Invoice, PaymentRecord } from '../lib/types'
import { PaymentPlanEditor } from './PaymentPlanEditor'
import { AmountInput } from './AmountInput'
import { ordinal, stageBalance, stageReceived } from './PaymentStageCard'
import './payments.css'

export function InvoicePayments({ invoice, onClose, onSaved, onPlanSaved, initialSection = 'record' }: {
  invoice: Invoice | null
  onClose: () => void
  onSaved: (invoice: Invoice, payment?: PaymentRecord) => void
  onPlanSaved?: (invoice: Invoice) => void
  initialSection?: 'record' | 'plan'
}) {
  const { toast } = useToast()
  const [receiptId, setReceiptId] = useState('')
  const [phaseId, setPhaseId] = useState('')
  const [amount, setAmount] = useState(0)
  const [method, setMethod] = useState('Bank transfer')
  const [reference, setReference] = useState('')
  const [paidDate, setPaidDate] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [currentInvoice, setCurrentInvoice] = useState<Invoice | null>(null)
  const [phases, setPhases] = useState<NonNullable<Invoice['payments']>>([])
  const [planDirty, setPlanDirty] = useState(false)
  const [section, setSection] = useState<'record' | 'plan' | 'receipts'>('record')
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })

  useEffect(() => {
    if (!invoice) return
    setCurrentInvoice(invoice)
    setPhases(invoice.payments?.map(phase => ({ ...phase })) || [])
    setPlanDirty(false)
    setSection(initialSection)
    setReceiptId('')
    const next = invoice.payments?.find(phase => Number(phase.amount) > stageReceived(phase))
    setPhaseId(next ? String(next.id || '') : '')
    setAmount(next ? stageBalance(next) : Math.max(0, Math.round((Number(invoice.amount) - Number(invoice.paid_amount || 0)) * 100) / 100))
    setMethod(invoice.payment_method || 'Bank transfer')
    setReference('')
    setPaidDate(today)
    // Keep this stable across a failed response/retry so a committed receipt
    // cannot be inserted twice.
    setIdempotencyKey(crypto.randomUUID())
  }, [invoice, today, initialSection])

  const savePlan = async () => {
    if (!currentInvoice || busy) return
    if (!phases.length || phases.some(phase => !phase.name.trim() || !Number.isFinite(Number(phase.amount)) || Number(phase.amount) <= 0 || Number(phase.amount) < stageReceived(phase))) return toast('Each phase needs a name and a positive amount covering any received funds.', 'error')
    if (phases.reduce((sum, phase) => sum + Math.round(Number(phase.amount) * 100), 0) !== Math.round(Number(currentInvoice.amount) * 100)) return toast('Allocate the phases exactly to the project total before saving.', 'error')
    setBusy(true)
    try {
      const saved = await api.invoices.update(currentInvoice.id, { payments: phases, expected_revision: currentInvoice.revision })
      setCurrentInvoice(saved); setPhases(saved.payments || []); setPlanDirty(false)
      const next = saved.payments?.find(phase => String(phase.id) === phaseId && Number(phase.amount) > stageReceived(phase)) || saved.payments?.find(phase => Number(phase.amount) > stageReceived(phase))
      setPhaseId(next ? String(next.id) : '')
      setAmount(next ? stageBalance(next) : 0)
      onPlanSaved?.(saved)
      toast('Payment plan saved. You can now record a receipt.', 'success')
    } catch (error) { toast(error instanceof Error ? error.message : 'Payment plan could not be saved.', 'error') }
    finally { setBusy(false) }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!invoice || busy) return
    if (planDirty) return toast('Save the payment plan before recording this payment.', 'error')
    if (!Number.isFinite(amount) || amount <= 0) return toast('Enter a positive payment amount.', 'error')
    if (phases.length && !phaseId) return toast('Choose the payment milestone that received these funds.', 'error')
    const originalReceipt = currentInvoice?.payment_records?.find(receipt => receipt.id === receiptId)
    const phase = phases.find(item => String(item.id) === phaseId)
    const available = phase ? stageBalance(phase, originalReceipt?.milestone_id === phaseId ? Number(originalReceipt.amount) : 0) : Number(currentInvoice?.amount || 0) - Number(currentInvoice?.paid_amount || 0) + Number(originalReceipt?.amount || 0)
    if (Math.round(amount * 100) > Math.round(available * 100)) return toast('Payment exceeds the remaining balance for this milestone.', 'error')
    setBusy(true)
    try {
      const data = {
        milestone_id: phaseId || null,
        amount,
        currency: invoice.currency || 'LKR',
        method,
        reference,
        paid_at: new Date(`${paidDate}T12:00:00+05:30`).toISOString(),
      }
      const original = currentInvoice?.payment_records?.find(receipt => receipt.id === receiptId)
      const result = receiptId
        ? await api.invoices.updatePayment(invoice.id, receiptId, data, original && amount < Number(original.amount) ? deletionPin() : undefined)
        : await api.invoices.recordPayment(invoice.id, { ...data, idempotency_key: idempotencyKey })
      onClose()
      onSaved(result.invoice, result.payment)
      toast(receiptId ? 'Payment corrected and balance updated.' : `Payment ${result.payment.receipt_number} recorded and balance updated.`, 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Payment could not be saved.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!invoice || busy) return
    setBusy(true)
    try {
      await api.invoices.removePayment(invoice.id, id)
      const saved = await api.invoices.get(invoice.id)
      onClose()
      onSaved(saved)
      toast('Payment removed; the invoice balance was recalculated.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Payment could not be removed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const currency = currentInvoice?.currency || 'LKR'
  const originalReceipt = currentInvoice?.payment_records?.find(receipt => receipt.id === receiptId)
  const selectedPhase = phases.find(phase => String(phase.id) === phaseId)
  const remaining = Math.max(0, Math.round((Number(currentInvoice?.amount || 0) - Number(currentInvoice?.paid_amount || 0)) * 100) / 100)
  const available = selectedPhase
    ? stageBalance(selectedPhase, originalReceipt?.milestone_id === phaseId ? Number(originalReceipt.amount) : 0)
    : remaining + Number(originalReceipt?.amount || 0)
  const canRecord = !planDirty && amount > 0 && (!phases.length || Boolean(phaseId))
  const choosePhase = (id: string) => {
    setPhaseId(id)
    const phase = phases.find(item => String(item.id) === id)
    if (phase) setAmount(Math.max(0, stageBalance(phase, originalReceipt?.milestone_id === id ? Number(originalReceipt.amount) : 0)))
  }
  const showSection = (next: typeof section) => {
    setSection(next)
    document.querySelector('.modal:has(.payment-workspace) .modal__body')?.scrollTo({ top: 0 })
  }
  const newReceipt = () => {
    setReceiptId(''); setReference(''); setPaidDate(today)
    setMethod(currentInvoice?.payment_method || 'Bank transfer'); setIdempotencyKey(crypto.randomUUID())
    const next = phases.find(phase => Number(phase.amount) > stageReceived(phase))
    setPhaseId(next ? String(next.id) : '')
    setAmount(next ? stageBalance(next) : remaining)
  }

  return <Modal
    open={Boolean(invoice)}
    onClose={() => { if (!busy) onClose() }}
    title={receiptId ? 'Edit recorded payment' : 'Manage payments'}
    description={[invoice?.reference, invoice?.project_title].filter(Boolean).join(' · ')}
    size="lg"
    footer={section === 'plan' && planDirty ? <><Button variant="ghost" disabled={busy} onClick={() => { setPhases(currentInvoice?.payments || []); setPlanDirty(false) }}>Discard changes</Button><Button loading={busy} onClick={() => void savePlan()}>Save payment plan</Button></> : section === 'record' ? <><Button variant="ghost" disabled={busy} onClick={() => { if (receiptId) { newReceipt(); showSection('receipts') } else onClose() }}>{receiptId ? 'Cancel edit' : 'Cancel'}</Button><Button type="submit" form="receipt-form" disabled={!canRecord} loading={busy}>{receiptId ? 'Save correction' : 'Save payment'}</Button></> : <Button variant="secondary" disabled={busy} onClick={onClose}>Done</Button>}
  >
    <div className="payment-workspace">
      <div className="payment-overview" aria-label="Invoice payment totals">
        <div><small>Invoice total</small><strong>{formatCurrency(Number(currentInvoice?.amount || 0), currency)}</strong></div>
        <div><small>Received</small><strong>{formatCurrency(Number(currentInvoice?.paid_amount || 0), currency)}</strong></div>
        <div><small>Outstanding</small><strong>{formatCurrency(remaining, currency)}</strong></div>
      </div>
      <div className="payment-navigation" role="group" aria-label="Payment sections">
        <button type="button" disabled={busy} aria-pressed={section === 'record'} onClick={() => showSection('record')}>Record payment</button>
        <button type="button" disabled={busy || Boolean(receiptId)} aria-pressed={section === 'plan'} onClick={() => showSection('plan')}>Payment plan{planDirty && <span aria-label="Unsaved changes"> *</span>}</button>
        <button type="button" disabled={busy} aria-pressed={section === 'receipts'} onClick={() => showSection('receipts')}>Receipts ({currentInvoice?.payment_records?.length || 0})</button>
      </div>
      {section === 'plan' && currentInvoice && <>
        {planDirty && <p className="payment-notice" role="status">Unsaved plan changes. Save below before recording a payment.</p>}
        <PaymentPlanEditor key={currentInvoice.id} invoice={currentInvoice} phases={phases} disabled={busy} dirty={planDirty} onChange={next => { setPhases(next); setPlanDirty(true) }} onRecord={index => { choosePhase(String(phases[index].id)); showSection('record') }} />
      </>}
      {section === 'record' && <>
        {planDirty ? <div className="payment-notice"><p>Save your payment plan before recording funds.</p><Button variant="secondary" onClick={() => showSection('plan')}>Review payment plan</Button></div> : null}
        {!receiptId && remaining <= 0 ? <div className="payment-empty"><h3>Paid in full</h3><p>All funds have been received. Open Receipts to review or correct a payment.</p></div> : <form id="receipt-form" onSubmit={save}>
          <fieldset disabled={busy || planDirty} className="payment-fieldset">
            <div className="form-grid">
              {phases.length > 0 && <Select className="form-grid__full" label="Payment milestone" required value={phaseId} onChange={event => choosePhase(event.target.value)}>
                <option value="">Choose a payment stage</option>
                {phases.map((phase, index) => <option key={phase.id || phase.name} value={String(phase.id)} disabled={stageReceived(phase) >= Number(phase.amount) && originalReceipt?.milestone_id !== phase.id}>{ordinal(index + 1)} · {phase.name}{stageReceived(phase) >= Number(phase.amount) ? ' (Paid)' : ''}</option>)}
              </Select>}
              <div className="payment-selection form-grid__full"><span>{receiptId ? 'Correcting receipt' : selectedPhase ? `${ordinal(phases.indexOf(selectedPhase) + 1)} payment` : 'Invoice payment'}</span><strong>{receiptId ? originalReceipt?.receipt_number : selectedPhase?.name || 'General payment'}</strong><small>Available to record: {formatCurrency(Math.max(0, available), currency)}</small></div>
              <AmountInput label={`Payment amount (${currency})`} min="0.01" max={available} required value={amount || ''} onValueChange={value => setAmount(Number(value))} hint="Enter the amount actually received, including partial payments." />
              <Input label="Received date" type="date" max={today} required value={paidDate} onChange={event => setPaidDate(event.target.value)} />
              <Input label="Payment method" value={method} onChange={event => setMethod(event.target.value)} maxLength={120} />
              <Input label="Transfer / receipt reference" value={reference} onChange={event => setReference(event.target.value)} maxLength={240} optional />
            </div>
            <div className="payment-result" aria-live="polite"><span>{receiptId ? 'Invoice balance after correction' : 'Invoice balance after payment'}</span><strong>{formatCurrency(Math.max(0, remaining + Number(originalReceipt?.amount || 0) - amount), currency)}</strong></div>
            <p className="field-hint">{receiptId ? 'This updates the receipt and recalculates the invoice balance.' : 'Saving creates a receipt. You can review the client message next.'}</p>
          </fieldset>
        </form>}
        {!receiptId && !planDirty && <Button className="payment-plan-link" variant="ghost" disabled={busy} onClick={() => showSection('plan')}>Add or edit payment stages</Button>}
      </>}
      {section === 'receipts' && <section className="payment-history">
        <h3>Recorded receipts</h3>
        {!currentInvoice?.payment_records?.length && <div className="payment-empty"><p>No receipts yet. Record your first cleared payment to create one.</p><Button variant="secondary" onClick={() => showSection('record')}>Record payment</Button></div>}
        <div className="client-document-list">{currentInvoice?.payment_records?.map(receipt => <article className="client-document-card" key={receipt.id}>
          <header><div><strong>{formatCurrency(Number(receipt.amount), receipt.currency)}</strong><small>{receipt.receipt_number}</small></div></header>
          <dl className="payment-receipt-details"><div><dt>Stage</dt><dd>{phases.find(phase => phase.id === receipt.milestone_id)?.name || 'General payment'}</dd></div><div><dt>Received</dt><dd>{receipt.date_confirmed === false ? 'Date not recorded' : formatDate(receipt.paid_at)}</dd></div><div><dt>Method</dt><dd>{receipt.method || 'Payment'}</dd></div>{receipt.reference && <div><dt>Reference</dt><dd>{receipt.reference}</dd></div>}</dl>
          <div className="payment-stage__actions">
            <Button variant="secondary" disabled={busy || planDirty} onClick={() => {
              setReceiptId(receipt.id); setPhaseId(receipt.milestone_id || ''); setAmount(Number(receipt.amount))
              setMethod(receipt.method || ''); setReference(receipt.reference || '')
              setPaidDate(receipt.date_confirmed === false ? '' : new Date(receipt.paid_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' }))
              showSection('record')
            }}>Edit receipt</Button>
            <Button variant="ghost" disabled={busy || planDirty} onClick={() => void remove(receipt.id)}>Delete receipt</Button>
          </div>
        </article>)}</div>
      </section>}
    </div>
  </Modal>
}
