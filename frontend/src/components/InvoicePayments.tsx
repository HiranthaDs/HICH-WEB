import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Modal, Select } from './ui'
import { api, deletionPin } from '../lib/api'
import { formatCurrency, formatDate } from '../lib/format'
import { useToast } from '../context/ToastContext'
import type { Invoice, PaymentRecord } from '../lib/types'
import { PaymentPlanEditor } from './PaymentPlanEditor'

export function InvoicePayments({ invoice, onClose, onSaved, onPlanSaved }: {
  invoice: Invoice | null
  onClose: () => void
  onSaved: (invoice: Invoice, payment?: PaymentRecord) => void
  onPlanSaved?: (invoice: Invoice) => void
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
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })

  useEffect(() => {
    if (!invoice) return
    setCurrentInvoice(invoice)
    setPhases(invoice.payments?.map(phase => ({ ...phase })) || [])
    setPlanDirty(false)
    setReceiptId('')
    setPhaseId(invoice.payments?.length === 1 ? String(invoice.payments[0].id || '') : '')
    setAmount(Math.max(0, Number(invoice.amount) - Number(invoice.paid_amount || 0)))
    setMethod(invoice.payment_method || 'Bank transfer')
    setReference('')
    setPaidDate(today)
    // Keep this stable across a failed response/retry so a committed receipt
    // cannot be inserted twice.
    setIdempotencyKey(crypto.randomUUID())
  }, [invoice, today])

  const savePlan = async () => {
    if (!currentInvoice || busy) return
    if (!phases.length || phases.some(phase => !phase.name.trim() || Number(phase.amount) <= 0 || Number(phase.amount) < Number(phase.paid_amount || 0))) return toast('Each phase needs a name and a positive amount covering any received funds.', 'error')
    if (phases.reduce((sum, phase) => sum + Math.round(Number(phase.amount) * 100), 0) !== Math.round(Number(currentInvoice.amount) * 100)) return toast('Allocate the phases exactly to the project total before saving.', 'error')
    setBusy(true)
    try {
      const saved = await api.invoices.update(currentInvoice.id, { payments: phases, expected_revision: currentInvoice.revision })
      setCurrentInvoice(saved); setPhases(saved.payments || []); setPlanDirty(false)
      onPlanSaved?.(saved)
      toast('Payment plan saved. You can now record a receipt.', 'success')
    } catch (error) { toast(error instanceof Error ? error.message : 'Payment plan could not be saved.', 'error') }
    finally { setBusy(false) }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!invoice || busy) return
    if (planDirty) return toast('Save the payment plan before recording this payment.', 'error')
    if (amount <= 0) return toast('Enter a positive payment amount.', 'error')
    if (phases.length && !phaseId) return toast('Choose the payment milestone that received these funds.', 'error')
    const originalReceipt = currentInvoice?.payment_records?.find(receipt => receipt.id === receiptId)
    const phase = phases.find(item => String(item.id) === phaseId)
    const available = phase ? Number(phase.amount) - Number(phase.paid_amount || 0) + (originalReceipt?.milestone_id === phaseId ? Number(originalReceipt.amount) : 0) : Number(currentInvoice?.amount || 0) - Number(currentInvoice?.paid_amount || 0) + Number(originalReceipt?.amount || 0)
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

  return <Modal
    open={Boolean(invoice)}
    onClose={() => { if (!busy) onClose() }}
    title={receiptId ? 'Correct a recorded payment' : 'Record a payment'}
    description={`Record cleared funds against ${invoice?.reference || 'this invoice'}. Every saved payment receives a permanent receipt number.`}
    size="xl"
    footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" form="receipt-form" loading={busy}>Save payment & prepare receipt</Button></>}
  >
    {currentInvoice && !receiptId && <><PaymentPlanEditor invoice={currentInvoice} phases={phases} disabled={busy} onChange={next => { setPhases(next); setPlanDirty(true) }} onRecord={index => {
      if (planDirty) return toast('Save the payment plan first.', 'error')
      const phase = phases[index]
      setPhaseId(String(phase.id)); setAmount(Math.max(0, Number(phase.amount) - Number(phase.paid_amount || 0)))
      document.getElementById('receipt-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }} />{planDirty && <div className="document-toolbar"><Button loading={busy} onClick={() => void savePlan()}>Save payment plan</Button><Button variant="ghost" disabled={busy} onClick={() => { setPhases(currentInvoice.payments || []); setPlanDirty(false) }}>Discard plan changes</Button></div>}</>}
    <form id="receipt-form" className="form-grid" onSubmit={save}>
      <Select
        className="form-grid__full"
        label="Payment milestone"
        required={Boolean(phases.length)}
        value={phaseId}
        onChange={event => {
          setPhaseId(event.target.value)
          const phase = phases.find(item => String(item.id) === event.target.value)
          const original = currentInvoice?.payment_records?.find(receipt => receipt.id === receiptId)
          if (phase) setAmount(Math.max(0, Number(phase.amount) - Number(phase.paid_amount || 0) + (original && original.milestone_id === phase.id ? Number(original.amount) : 0)))
        }}
      >
        <option value="">{invoice?.payments?.length ? 'Select the paid milestone…' : 'General payment against invoice'}</option>
        {phases.map(phase => <option
          key={phase.id || phase.name}
          value={String(phase.id)}
          disabled={Number(phase.paid_amount || 0) >= Number(phase.amount) && currentInvoice?.payment_records?.find(receipt => receipt.id === receiptId)?.milestone_id !== phase.id}
        >{phase.name} — {formatCurrency(Math.max(0, Number(phase.amount) - Number(phase.paid_amount || 0)), invoice?.currency)} remaining</option>)}
      </Select>
      <Input label={`Payment amount (${invoice?.currency || 'LKR'})`} type="number" min="0.01" step="0.01" required value={amount || ''} onChange={event => setAmount(Number(event.target.value))} />
      <Input label="Received date" type="date" max={today} required value={paidDate} onChange={event => setPaidDate(event.target.value)} />
      <Input label="Payment method" value={method} onChange={event => setMethod(event.target.value)} maxLength={120} />
      <Input label="Transfer / receipt reference" value={reference} onChange={event => setReference(event.target.value)} maxLength={240} optional />
    </form>
    <section className="agreement-section">
      <h3>Recorded receipts</h3>
      <div className="client-document-list">{currentInvoice?.payment_records?.map(receipt => <article className="client-document-card" key={receipt.id}>
        <header><div><strong>{formatCurrency(Number(receipt.amount), receipt.currency)}</strong><small>{receipt.receipt_number} · {receipt.date_confirmed === false ? 'Date not recorded' : formatDate(receipt.paid_at)} · {receipt.method || 'Payment'} · {receipt.reference || 'No reference'}</small></div></header>
        <div className="document-toolbar">
          <Button size="sm" variant="secondary" disabled={busy || planDirty} onClick={() => {
            setReceiptId(receipt.id)
            setPhaseId(receipt.milestone_id || '')
            setAmount(Number(receipt.amount))
            setMethod(receipt.method || '')
            setReference(receipt.reference || '')
            setPaidDate(receipt.date_confirmed === false ? '' : new Date(receipt.paid_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' }))
          }}>Edit receipt</Button>
          <Button size="sm" variant="danger" disabled={busy || planDirty} onClick={() => void remove(receipt.id)}>Delete receipt</Button>
        </div>
      </article>)}</div>
    </section>
  </Modal>
}
