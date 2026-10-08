import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Modal, Select } from './ui'
import { api, deletionPin } from '../lib/api'
import { formatCurrency, formatDate } from '../lib/format'
import { useToast } from '../context/ToastContext'
import type { Invoice } from '../lib/types'

export function InvoicePayments({ invoice, onClose, onSaved }: { invoice: Invoice | null; onClose: () => void; onSaved: (invoice: Invoice) => void }) {
  const { toast } = useToast()
  const [receiptId, setReceiptId] = useState('')
  const [phaseId, setPhaseId] = useState('')
  const [amount, setAmount] = useState(0)
  const [method, setMethod] = useState('Bank transfer')
  const [reference, setReference] = useState('')
  const [paidDate, setPaidDate] = useState('')
  const [busy, setBusy] = useState(false)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })
  useEffect(() => {
    if (!invoice) return
    setReceiptId(''); setPhaseId(invoice.payments?.length === 1 ? String(invoice.payments[0].id || '') : ''); setAmount(Math.max(0, Number(invoice.amount) - Number(invoice.paid_amount || 0)))
    setMethod(invoice.payment_method || 'Bank transfer'); setReference(''); setPaidDate(today)
  }, [invoice, today])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!invoice || busy) return
    if (amount <= 0) return toast('Enter a positive payment amount.', 'error')
    setBusy(true)
    try {
      const data = { milestone_id: phaseId || null, amount, currency: invoice.currency || 'LKR', method, reference, paid_at: new Date(`${paidDate}T12:00:00+05:30`).toISOString() }
      const original = invoice.payment_records?.find(receipt => receipt.id === receiptId)
      const saved = receiptId ? await api.invoices.updatePayment(invoice.id, receiptId, data, original && amount < Number(original.amount) ? deletionPin() : undefined) : await api.invoices.recordPayment(invoice.id, data)
      onClose(); onSaved(saved); toast(receiptId ? 'Payment corrected and balance updated.' : 'Payment recorded and balance updated.', 'success')
    } catch (e) { toast(e instanceof Error ? e.message : 'Payment could not be saved.', 'error') }
    finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    if (!invoice || busy) return
    setBusy(true)
    try { await api.invoices.removePayment(invoice.id, id); const saved = await api.invoices.get(invoice.id); onClose(); onSaved(saved); toast('Payment removed; the invoice balance was recalculated.', 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Payment could not be removed.', 'error') }
    finally { setBusy(false) }
  }
  return <Modal open={Boolean(invoice)} onClose={() => { if (!busy) onClose() }} title={receiptId ? 'Correct a recorded payment' : 'Record a payment'} description={`Record cleared funds against ${invoice?.reference || 'this invoice'}. Mid payments may cover part of a milestone.`} size="lg" footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" form="receipt-form" loading={busy}>Save payment & prepare message</Button></>}>
    <form id="receipt-form" className="form-grid" onSubmit={save}><Select className="form-grid__full" label="Payment milestone" value={phaseId} onChange={e => { setPhaseId(e.target.value); const phase = invoice?.payments?.find(p => String(p.id) === e.target.value); if (phase) setAmount(Math.max(0, Number(phase.amount) - Number(phase.paid_amount || 0))) }}><option value="">General payment against invoice</option>{invoice?.payments?.map(phase => <option key={phase.id || phase.name} value={String(phase.id)}>{phase.name} — {formatCurrency(Number(phase.amount), invoice.currency)}</option>)}</Select><Input label={`Payment amount (${invoice?.currency || 'LKR'})`} type="number" min="0.01" step="0.01" required value={amount || ''} onChange={e => setAmount(Number(e.target.value))} /><Input label="Received date" type="date" max={today} required value={paidDate} onChange={e => setPaidDate(e.target.value)} /><Input label="Payment method" value={method} onChange={e => setMethod(e.target.value)} maxLength={120} /><Input label="Transfer / receipt reference" value={reference} onChange={e => setReference(e.target.value)} maxLength={240} optional /></form>
    <section className="agreement-section"><h3>Recorded receipts</h3><div className="client-document-list">{invoice?.payment_records?.map(receipt => <article className="client-document-card" key={receipt.id}><header><div><strong>{formatCurrency(Number(receipt.amount), receipt.currency)}</strong><small>{formatDate(receipt.paid_at)} · {receipt.method || 'Payment'} · {receipt.reference || 'No reference'}</small></div></header><div className="document-toolbar"><Button size="sm" variant="secondary" disabled={busy} onClick={() => { setReceiptId(receipt.id); setPhaseId(receipt.milestone_id || ''); setAmount(Number(receipt.amount)); setMethod(receipt.method || ''); setReference(receipt.reference || ''); setPaidDate(new Date(receipt.paid_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })) }}>Edit receipt</Button><Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(receipt.id)}>Delete receipt</Button></div></article>)}</div></section>
  </Modal>
}
