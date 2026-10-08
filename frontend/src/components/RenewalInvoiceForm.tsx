import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { formatCurrency, formatDate } from '../lib/format'
import { useToast } from '../context/ToastContext'
import type { Invoice, RenewalItem } from '../lib/types'
import { Button, Input, Modal, Select, Textarea } from './ui'

export function RenewalItemsEditor({ items, onChange }: { items: RenewalItem[]; onChange: (items: RenewalItem[]) => void }) {
  return <section className="agreement-section"><div className="document-toolbar"><h3>Renewal service charges</h3><Button variant="secondary" size="sm" type="button" disabled={items.length >= 20} icon={Plus} onClick={() => onChange([...items, { service: 'hosting', description: 'Hosting renewal', amount: 0 }])}>Add service</Button></div>{items.map((item, index) => <div className="renewal-service-row" key={index}><Select label={`Service ${index + 1}`} value={item.service} onChange={e => onChange(items.map((current, i) => i === index ? { ...current, service: e.target.value as RenewalItem['service'], description: e.target.value === 'domain' ? 'Domain renewal' : e.target.value === 'hosting' ? 'Hosting renewal' : 'Domain & hosting renewal' } : current))}><option value="domain_hosting">Domain & hosting</option><option value="domain">Domain</option><option value="hosting">Hosting</option></Select><Input label={`Service description ${index + 1}`} required maxLength={240} value={item.description} placeholder="e.g. example.com — annual domain renewal" onChange={e => onChange(items.map((current, i) => i === index ? { ...current, description: e.target.value } : current))} /><Input label={`Service amount ${index + 1}`} required type="number" min="0.01" step="0.01" value={item.amount || ''} onChange={e => onChange(items.map((current, i) => i === index ? { ...current, amount: Number(e.target.value) } : current))} /><button className="icon-button icon-button--danger" type="button" disabled={items.length === 1} aria-label={`Remove renewal service ${index + 1}`} onClick={() => onChange(items.filter((_, i) => i !== index))}><Trash2 size={17} /></button></div>)}</section>
}

export function RenewalInvoiceForm({ source, onClose, onSaved }: { source: Invoice | null; onClose: () => void; onSaved: (invoice: Invoice, recordPayment: boolean) => void }) {
  const { toast } = useToast()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })
  const [items, setItems] = useState<RenewalItem[]>([])
  const [currency, setCurrency] = useState('LKR')
  const [due, setDue] = useState(today)
  const [accepted, setAccepted] = useState(false)
  const [applyFee, setApplyFee] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const expired = Boolean(source?.renewal_due_date && source.renewal_due_date.slice(0, 10) < today)
  useEffect(() => {
    if (!source) return
    setItems([{ service: 'domain_hosting', description: 'Domain & hosting renewal', amount: Number(source.renewal_amount || 0) }])
    setCurrency(source.renewal_currency || source.currency || 'LKR')
    setDue(source.renewal_due_date && source.renewal_due_date.slice(0, 10) > today ? source.renewal_due_date.slice(0, 10) : today)
    setAccepted(false); setApplyFee(false); setNote('')
  }, [source, today])
  const base = Math.round(items.reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100
  const fee = expired && accepted && applyFee ? Math.round(base * 18) / 100 : 0
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!source || busy) return
    if (!source.renewal_due_date) return toast('Save the service expiry / renewal date on the project invoice first.', 'error')
    if (!items.length || items.some(item => !item.description.trim() || item.amount <= 0)) return toast('Enter a description and positive amount for every renewal service.', 'error')
    const recordPayment = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'record'
    setBusy(true)
    try {
      const invoice = await api.invoices.createRenewal(source.id, { renewal_period_date: source.renewal_due_date.slice(0, 10), items, currency, due_date: due, apply_late_fee: expired && accepted && applyFee, late_fee_accepted: accepted, customer_note: note })
      onClose(); onSaved(invoice, recordPayment && invoice.status !== 'paid')
      toast('Renewal invoice ready. An existing invoice is reused for this renewal cycle.', 'success')
    } catch (e) { toast(e instanceof Error ? e.message : 'Renewal invoice could not be prepared.', 'error') }
    finally { setBusy(false) }
  }
  return <Modal open={Boolean(source)} onClose={() => { if (!busy) onClose() }} title="Create domain & hosting renewal invoice" description="Bill this renewal separately. Record cleared payment to prepare the paid renewal invoice for your client." size="lg" footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="secondary" form="renewal-invoice-form" type="submit" value="share" loading={busy}>Create & share invoice</Button><Button form="renewal-invoice-form" type="submit" value="record" loading={busy}>Create & record payment</Button></>}>
    <form id="renewal-invoice-form" onSubmit={save}>
      <dl className="document-summary"><div><dt>Client</dt><dd>{source?.client_name}</dd></div><div><dt>Project</dt><dd>{source?.project_title}</dd></div><div><dt>Renewal cycle / service expiry</dt><dd>{formatDate(source?.renewal_due_date)}</dd></div></dl>
      <RenewalItemsEditor items={items} onChange={setItems} />
      <div className="form-grid"><Select label="Billing currency" value={currency} onChange={e => setCurrency(e.target.value)}>{[...new Set(['LKR', 'USD', 'GBP', currency])].map(value => <option key={value}>{value}</option>)}</Select><Input label="Renewal invoice payment due" required type="date" min={today} value={due} onChange={e => setDue(e.target.value)} /></div>
      {expired && <div className="renewal-fee-options"><label className="renewal-charge-consent"><input type="checkbox" checked={accepted} onChange={e => { setAccepted(e.target.checked); if (!e.target.checked) setApplyFee(false) }} />Client accepted the 18% late-payment surcharge for this renewal.</label><label className="renewal-charge-consent"><input type="checkbox" disabled={!accepted} checked={applyFee} onChange={e => setApplyFee(e.target.checked)} />Include the single 18% surcharge on this overdue renewal invoice.</label></div>}
      <div className="invoice-totals"><div><span>Renewal services</span><strong>{formatCurrency(base, currency)}</strong></div>{fee > 0 && <div><span>Agreed late-payment surcharge (18%)</span><strong>{formatCurrency(fee, currency)}</strong></div>}<div><span>Renewal invoice total</span><strong>{formatCurrency(base + fee, currency)}</strong></div></div>
      <Textarea label="Renewal client note" value={note} onChange={e => setNote(e.target.value)} rows={2} optional placeholder="Service period, domain name or other renewal details" />
      <p className="field-hint">Record payment only after funds clear. Payment does not confirm that the registrar or hosting provider has completed the renewal.</p>
    </form>
  </Modal>
}
