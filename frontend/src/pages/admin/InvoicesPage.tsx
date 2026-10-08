import { Check, CircleDollarSign, Link2, History, Download, FileText, MessageCircle, Plus, RefreshCw, Trash2, WalletCards } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { SharePanel } from '../../components/SharePanel'
import { exportCsv, whatsappUrl } from '../../lib/sharing'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Button, ConfirmDialog, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, SearchInput, Select, StatusPill, Textarea } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { api } from '../../lib/api'
import { formatCurrency, formatDate, getClientName } from '../../lib/format'
import type { Client, Invoice, InvoiceVersion } from '../../lib/types'

type Payment = NonNullable<Invoice['payments']>[number]
type InvoiceForm = Partial<Invoice> & { payments: Payment[] }
const blankInvoice: InvoiceForm = { client_id: '', project_title: '', amount: 0, paid_amount: 0, currency: 'LKR', status: 'draft', issue_date: new Date().toISOString().slice(0, 10), due_date: '', payment_method: 'Bank transfer', notes: '', renewal_amount: 0, renewal_currency: 'LKR', renewal_due_date: '', payments: [{ name: 'Advance payment', amount: 0, status: 'Pending', is_paid: false }, { name: 'Final balance', amount: 0, status: 'Pending', is_paid: false }] }
const blankClient: Partial<Client> = { name: '', company: '', email: '', phone: '', address: '', notes: '', status: 'active' }

const clientFor = (invoice: Invoice, clients: Client[]) => clients.find((client) => String(client.id) === String(invoice.client_id)) || (typeof invoice.client === 'object' ? invoice.client : undefined)
const paymentPaid = (payment: Payment) => Boolean(payment.is_paid ?? payment.isPaid)

export function InvoicesPage() {
  const { toast } = useToast()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('search') || '')
  useEffect(() => setQuery(params.get('search') || ''), [params])
  const [shared, setShared] = useState<Invoice | null>(null)
  const [shareBusy, setShareBusy] = useState(false)
  const [linkExpiry, setLinkExpiry] = useState('')
  const [history, setHistory] = useState<InvoiceVersion[] | null>(null)
  const [historyTitle, setHistoryTitle] = useState('')
  const [status, setStatus] = useState('all')
  const [editing, setEditing] = useState<Invoice | 'new' | null>(null)
  const [form, setForm] = useState<InvoiceForm>({ ...blankInvoice })
  const [clientMode, setClientMode] = useState<'existing' | 'new'>('existing')
  const [newClient, setNewClient] = useState<Partial<Client>>({ ...blankClient })
  const openedRequest = useRef('')
  const [paymentPlanTouched, setPaymentPlanTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Invoice | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const [invoiceResult, clientResult] = await Promise.all([api.invoices.list(), api.clients.list()]); setInvoices(invoiceResult.items); setClients(clientResult.items) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Invoices could not be loaded.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const clientFilter = params.get('client')
  const filtered = useMemo(() => invoices.filter((invoice) => (!clientFilter || String(invoice.client_id) === clientFilter) && (!query || [invoice.reference, invoice.project_title, getClientName(invoice.client, invoice.client_name)].join(' ').toLowerCase().includes(query.toLowerCase())) && (status === 'all' || invoice.status === status)), [invoices, query, status, clientFilter])
  const liveInvoices = invoices.filter((invoice) => invoice.status !== 'void')
  const currencyTotals = Object.entries(liveInvoices.reduce<Record<string, { paid: number; outstanding: number }>>((totals, invoice) => {
    const currency = invoice.currency || 'LKR'
    const paid = Number(invoice.paid_amount || 0)
    const current = totals[currency] || { paid: 0, outstanding: 0 }
    totals[currency] = { paid: current.paid + paid, outstanding: current.outstanding + Math.max(0, Number(invoice.amount) - paid) }
    return totals
  }, {}))
  const totalPaid = currencyTotals.map(([currency, total]) => formatCurrency(total.paid, currency)).join(' / ') || formatCurrency(0)
  const totalOutstanding = currencyTotals.map(([currency, total]) => formatCurrency(total.outstanding, currency)).join(' / ') || formatCurrency(0)

  const openEditor = (invoice?: Invoice) => {
    setEditing(invoice || 'new')
    const payments = invoice?.payments?.length ? invoice.payments.map((payment) => ({ ...payment })) : blankInvoice.payments.map((payment) => ({ ...payment }))
    const selectedId = params.get('client') || ''
    setForm(invoice ? { ...invoice, payments } : { ...blankInvoice, client_id: selectedId, issue_date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' }), payments })
    setClientMode(invoice || selectedId || clients.length ? 'existing' : 'new')
    setNewClient({ ...blankClient })
    setPaymentPlanTouched(Boolean(invoice))
  }

  useEffect(() => {
    if (loading || error) return
    const request = params.toString()
    if (openedRequest.current === request) return
    if (params.get('create') === '1') { openedRequest.current = request; openEditor() }
    else if (params.get('invoice')) {
      const invoice = invoices.find(item => String(item.id) === params.get('invoice'))
      if (invoice) { openedRequest.current = request; openEditor(invoice) }
    }
  }, [loading, error, params, invoices])

  const updatePayment = (index: number, patch: Partial<Payment>) => {
    setPaymentPlanTouched(true)
    setForm((current) => ({ ...current, payments: current.payments.map((payment, paymentIndex) => paymentIndex === index ? { ...payment, ...patch } : payment) }))
  }
  const updateProjectValue = (value: number) => setForm((current) => {
    if (paymentPlanTouched || editing !== 'new' || value <= 0) return { ...current, amount: value }
    const advance = Math.round(value * 50) / 100
    return {
      ...current,
      amount: value,
      payments: value < 0.02
        ? [{ name: 'Full project payment', amount: value, status: 'Pending', is_paid: false }]
        : [
            { name: 'Advance payment', amount: advance, status: 'Pending', is_paid: false },
            { name: 'Final balance', amount: Number((value - advance).toFixed(2)), status: 'Pending', is_paid: false },
          ],
    }
  })
  const allocated = form.payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  const paidInForm = form.payments.filter(paymentPaid).reduce((sum, payment) => sum + Number(payment.amount || 0), 0)

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    if (clientMode === 'existing' && !form.client_id) return toast('Choose an existing client or create a new client below.', 'error')
    if (clientMode === 'new' && !newClient.name?.trim()) return toast('Enter the new client’s name.', 'error')
    if (!form.project_title?.trim() || Number(form.amount) <= 0) return toast('Enter the project title and total project amount.', 'error')
    const payments = form.payments.filter((payment) => Number(payment.amount) > 0)
    if (payments.some((payment) => !payment.name.trim())) return toast('Enter a name for each payment milestone.', 'error')
    const normalizedPayments = payments.length ? payments : [{ name: 'Full project payment', amount: Number(form.amount), status: 'Pending', is_paid: false }]
    const normalizedAllocated = normalizedPayments.reduce((sum, payment) => sum + Number(payment.amount), 0)
    if (Math.abs(normalizedAllocated - Number(form.amount)) > 0.01) return toast(`Payment milestones must add up to ${formatCurrency(Number(form.amount), form.currency || 'LKR')}. ${formatCurrency(Math.abs(Number(form.amount) - normalizedAllocated), form.currency || 'LKR')} is ${normalizedAllocated < Number(form.amount) ? 'still unallocated' : 'over-allocated'}.`, 'error')
    setSaving(true)
    const paidAmount = normalizedPayments.filter(paymentPaid).reduce((sum, payment) => sum + Number(payment.amount), 0)
    let clientCreated = false
    try {
      let selectedClient = clients.find((client) => String(client.id) === String(form.client_id))
      if (clientMode === 'new') {
        selectedClient = await api.clients.create(newClient)
        clientCreated = true
        setClients(current => [selectedClient!, ...current])
        // Keep the saved client selected if the invoice request fails, so retrying cannot create it twice.
        setForm(current => ({ ...current, client_id: selectedClient!.id }))
        setClientMode('existing')
        setNewClient({ ...blankClient })
      }
      const payload: Partial<Invoice> = { client_id: selectedClient?.id || form.client_id, reference: form.reference || undefined, project_title: form.project_title, amount: form.amount, currency: form.currency, issue_date: form.issue_date, due_date: form.due_date || '', payment_method: form.payment_method, notes: form.notes, payment_instructions: form.payment_instructions, customer_note: form.customer_note, status: form.status, payments: normalizedPayments, renewal_amount: form.renewal_amount, renewal_currency: form.renewal_currency, renewal_due_date: form.renewal_due_date || '', client_name: selectedClient?.name, phone: selectedClient?.phone, paid_amount: paidAmount, expected_revision: editing === 'new' ? undefined : form.revision }
      const saved = editing === 'new' ? await api.invoices.create(payload) : await api.invoices.update((editing as Invoice).id, payload)
      setInvoices((current) => editing === 'new' ? [saved, ...current] : current.map((invoice) => invoice.id === saved.id ? saved : invoice))
      toast(editing === 'new' ? clientCreated ? 'Client and invoice created.' : 'Invoice created.' : 'Invoice updated.', 'success'); setEditing(null)
    } catch (requestError) { toast(`${clientCreated ? 'Client saved. Retry the invoice with this selected client. ' : ''}${requestError instanceof Error ? requestError.message : 'Invoice could not be saved.'}`, 'error') }
    finally { setSaving(false) }
  }

  const remove = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try { await api.invoices.remove(deleting.id); setInvoices((current) => current.map((invoice) => invoice.id === deleting.id ? { ...invoice, status: 'void' } : invoice)); setDeleting(null); toast('Invoice voided.', 'success') }
    catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'Invoice could not be voided.', 'error') }
    finally { setDeleteBusy(false) }
  }

  const share = async (invoice: Invoice, rotate = false, setExpiry = false) => {
    setShareBusy(true)
    try {
      const result = await api.invoices.share(invoice.id, { rotate, ...(setExpiry ? { expires_at: linkExpiry ? new Date(`${linkExpiry}T23:59:59+05:30`).toISOString() : null } : {}) })
      const updated = { ...invoice, ...result.invoice, share_url: result.share_url, share_expires_at: result.expires_at }
      setShared(updated)
      setLinkExpiry(result.expires_at?.slice(0, 10) || '')
      setInvoices(current => current.map(item => item.id === invoice.id ? updated : item))
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not create link.', 'error') }
    finally { setShareBusy(false) }
  }
  const revoke = async () => {
    if (!shared) return
    setShareBusy(true)
    try { await api.invoices.revoke(shared.id); setInvoices(current => current.map(item => item.id === shared.id ? { ...item, share_url: undefined } : item)); setShared(null); toast('Invoice link revoked.', 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not revoke link.', 'error') }
    finally { setShareBusy(false) }
  }
  const showHistory = async (invoice: Invoice) => {
    try { setHistory(await api.invoices.versions(invoice.id)); setHistoryTitle(invoice.reference || invoice.project_title || 'Invoice') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not load history.', 'error') }
  }

  const whatsapp = (invoice: Invoice, renewal = false) => {
    const client = clientFor(invoice, clients)
    const phone = invoice.phone || client?.phone
    if (!phone) return toast('Add a phone number to this client first.', 'error')
    const name = getClientName(invoice.client, invoice.client_name || client?.name)
    const paid = Number(invoice.paid_amount ?? invoice.payments?.filter(paymentPaid).reduce((sum, payment) => sum + Number(payment.amount || 0), 0) ?? 0)
    const balance = Math.max(0, invoice.amount - paid)
    const text = renewal
      ? `Hello ${name}, this is a friendly reminder that your Hich Studio annual renewal of ${formatCurrency(invoice.renewal_amount || 0, invoice.renewal_currency || 'LKR')} is due on ${formatDate(invoice.renewal_due_date)}.${invoice.share_url ? `\n\nView details: ${invoice.share_url}` : ''}`
      : `Hello ${name}, here is an update for ${invoice.reference || invoice.project_title}. The remaining balance is ${formatCurrency(balance, invoice.currency || 'LKR')}.${invoice.share_url ? `\n\nView invoice: ${invoice.share_url}` : ''}`
    window.open(whatsappUrl(phone, text), '_blank', 'noopener,noreferrer')
  }

  return <div className="admin-page">
    <PageHeader eyebrow="Payments" title="Invoices" description="Track payment milestones, balances and annual renewals without losing context." action={<Button icon={Plus} onClick={() => openEditor()}>New invoice</Button>} />
    {clientFilter && <div className="document-toolbar"><span>Invoices for {clients.find(client => String(client.id) === clientFilter)?.name || 'this client'}</span><Link className="text-link" to="/admin/invoices">Show all clients</Link></div>}
    <section className="invoice-summary"><article><span><CircleDollarSign size={21} /></span><div><small>Collected</small><strong>{totalPaid}</strong></div></article><article><span><WalletCards size={21} /></span><div><small>Outstanding</small><strong>{totalOutstanding}</strong></div></article><article><span><FileText size={21} /></span><div><small>Open invoices</small><strong>{invoices.filter((invoice) => !['paid', 'void'].includes(invoice.status)).length}</strong></div></article></section>
    <section className="toolbar panel panel--flat"><SearchInput value={query} onChange={setQuery} placeholder="Search invoice, project or client…" label="Search invoices" /><div className="toolbar__right"><Button variant="ghost" size="sm" icon={Download} disabled={!filtered.length} onClick={() => exportCsv('hich-invoices.csv', filtered.map(i => ({ Reference: i.reference, Client: i.client_name, Project: i.project_title, Total: i.amount, Paid: i.paid_amount, Currency: i.currency, Status: i.status, Due: i.due_date, Renewal: i.renewal_amount, 'Renewal currency': i.renewal_currency, 'Renewal due': i.renewal_due_date })))}>Export</Button><Select aria-label="Filter invoice status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="draft">Draft</option><option value="sent">Sent</option><option value="partial">Partially paid</option><option value="paid">Paid</option><option value="overdue">Overdue</option><option value="void">Void</option></Select><Button variant="ghost" size="sm" icon={RefreshCw} loading={loading} onClick={load}>Refresh</Button></div></section>
    {loading && !invoices.length ? <LoadingState label="Loading invoices…" /> : error ? <ErrorState message={error} onRetry={load} /> : filtered.length === 0 ? <EmptyState icon={FileText} title={query || status !== 'all' ? 'No invoices match' : 'No invoices yet'} description={query || status !== 'all' ? 'Try a different search or status filter.' : 'Create an invoice with flexible payment milestones for your first client.'} action={!query && status === 'all' ? <Button icon={Plus} onClick={() => openEditor()}>Create invoice</Button> : undefined} /> : <div className="invoice-list">{filtered.map((invoice) => {
      const client = clientFor(invoice, clients)
      const paid = Number(invoice.paid_amount ?? invoice.payments?.filter(paymentPaid).reduce((sum, payment) => sum + Number(payment.amount || 0), 0) ?? 0)
      const balance = Math.max(0, invoice.amount - paid)
      const percentage = invoice.amount ? Math.min(100, paid / invoice.amount * 100) : 0
      return <article className="invoice-row" key={invoice.id}><div className="invoice-row__main"><span className="invoice-row__icon"><FileText size={20} /></span><div><span>{invoice.reference || `INV-${invoice.id}`}</span><h3>{invoice.project_title || 'Project invoice'}</h3><p>{invoice.client_id ? <Link className="text-link" to={`/admin/clients?client=${encodeURIComponent(String(invoice.client_id))}`}>{getClientName(invoice.client, invoice.client_name || client?.name)}</Link> : getClientName(invoice.client, invoice.client_name || client?.name)} · Due {formatDate(invoice.due_date)}</p></div></div><div className="invoice-row__progress"><div><span>Paid {formatCurrency(paid, invoice.currency || 'LKR')}</span><span>{Math.round(percentage)}%</span></div><progress max="100" value={percentage} /></div><div className="invoice-row__amount"><small>Total {formatCurrency(Number(invoice.amount), invoice.currency || 'LKR')}</small><small>Balance</small><strong>{formatCurrency(balance, invoice.currency || 'LKR')}</strong><StatusPill status={invoice.status} /></div><div className="invoice-row__actions">{invoice.status !== 'void' && <Button variant="secondary" size="sm" icon={Link2} loading={shareBusy} onClick={() => void share(invoice)}>Share</Button>}<button className="icon-button" type="button" onClick={() => void showHistory(invoice)} aria-label="Invoice revision history"><History size={17} /></button>{(invoice.phone || client?.phone) && <button className="icon-button icon-button--whatsapp" type="button" onClick={() => void share(invoice)} aria-label="Send WhatsApp payment reminder"><MessageCircle size={17} /></button>}<Button variant="secondary" size="sm" onClick={() => openEditor(invoice)}>Edit</Button><button className="icon-button icon-button--danger" type="button" onClick={() => setDeleting(invoice)} aria-label="Delete invoice"><Trash2 size={17} /></button></div>{invoice.renewal_amount ? <button type="button" className="invoice-row__renewal" onClick={() => whatsapp(invoice, true)}><RefreshCw size={14} /> Renewal {formatCurrency(invoice.renewal_amount, invoice.renewal_currency || 'LKR')} · {formatDate(invoice.renewal_due_date)}{(invoice.phone || client?.phone) && <MessageCircle size={14} />}</button> : null}</article>
    })}</div>}

    <Modal open={Boolean(editing)} onClose={() => { if (!saving) setEditing(null) }} title={editing === 'new' ? 'Create an invoice' : 'Edit invoice'} description="Add your client, project amount, payment phases and annual renewal in one place." size="xl" footer={<><Button variant="ghost" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="invoice-form" loading={saving}>{editing === 'new' ? 'Create invoice' : 'Save changes'}</Button></>}>
      <form id="invoice-form" className="invoice-form" onSubmit={save}>
        <section className="invoice-client-editor">
          <div><p className="eyebrow">Client details</p><h3>Who is this invoice for?</h3><p>New clients are saved to Clients and can be selected when creating an agreement.</p></div>
          <Select label="Client option" value={clientMode} disabled={saving} onChange={event => setClientMode(event.target.value as 'existing' | 'new')}><option value="existing">Select an existing client</option><option value="new">Create a new client</option></Select>
          {clientMode === 'new' ? <div className="form-grid">
            <Input label="Client name" value={newClient.name || ''} onChange={event => setNewClient({ ...newClient, name: event.target.value })} maxLength={160} autoComplete="name" required />
            <Input label="Company" value={newClient.company || ''} onChange={event => setNewClient({ ...newClient, company: event.target.value })} maxLength={200} autoComplete="organization" optional />
            <Input label="Email address" type="email" value={newClient.email || ''} onChange={event => setNewClient({ ...newClient, email: event.target.value })} autoComplete="email" optional />
            <Input label="Phone number" type="tel" value={newClient.phone || ''} onChange={event => setNewClient({ ...newClient, phone: event.target.value })} maxLength={40} autoComplete="tel" placeholder="+94 71 123 4567" hint="Used for calls, WhatsApp and agreements." optional />
            <Textarea className="form-grid__full" label="Address" value={newClient.address || ''} onChange={event => setNewClient({ ...newClient, address: event.target.value })} maxLength={1000} rows={2} autoComplete="street-address" optional />
          </div> : <><Select label="Client" value={String(form.client_id || '')} onChange={event => setForm({ ...form, client_id: event.target.value })} required><option value="">Select a client…</option>{clients.map(client => <option key={client.id} value={String(client.id)}>{client.company ? `${client.company} — ${client.name}` : client.name}{client.status === 'archived' ? ' (archived)' : ''}</option>)}</Select>{form.client_id && <Link className="text-link" to={`/admin/clients?client=${encodeURIComponent(String(form.client_id))}`}>View client profile</Link>}{!clients.length && <p className="field-hint">No clients yet. Choose “Create a new client” above.</p>}</>}
        </section>
        <div className="form-grid">
          <Input label="Project title" value={form.project_title || ''} onChange={(event) => setForm({ ...form, project_title: event.target.value })} placeholder="Website design & development" required />
          <Input label="Reference" value={form.reference || ''} onChange={(event) => setForm({ ...form, reference: event.target.value })} placeholder="Generated if left blank" optional />
          <Input label="Total project amount" type="number" min="0.01" step="0.01" value={form.amount || ''} onChange={(event) => updateProjectValue(Number(event.target.value))} hint="A 50/50 payment plan is prepared automatically. You can edit it below." required />
          <Select label="Project currency" value={form.currency || 'LKR'} onChange={(event) => setForm({ ...form, currency: event.target.value })}><option value="LKR">LKR — Sri Lankan rupee</option><option value="USD">USD — US dollar</option><option value="GBP">GBP — British pound</option>{form.currency && !['LKR', 'USD', 'GBP'].includes(form.currency) && <option value={form.currency}>{form.currency}</option>}</Select>
          <Input label="Issue date" type="date" value={form.issue_date?.slice(0, 10) || ''} onChange={(event) => setForm({ ...form, issue_date: event.target.value })} />
          <Input label="Due date" type="date" value={form.due_date?.slice(0, 10) || ''} onChange={(event) => setForm({ ...form, due_date: event.target.value })} />
          <Select label="Invoice status" value={form.status || 'draft'} onChange={(event) => setForm({ ...form, status: event.target.value })} hint="Partial, paid and overdue states are calculated from payments and dates."><option value="draft">Draft</option><option value="sent">Sent</option><option value="partial" disabled>Partially paid (automatic)</option><option value="paid" disabled>Paid (automatic)</option><option value="overdue" disabled>Overdue (automatic)</option><option value="void">Void</option></Select>
          <Input label="Payment method" value={form.payment_method || ''} onChange={(event) => setForm({ ...form, payment_method: event.target.value })} />
        </div>

        <section className="milestone-editor">
          <header><div><p className="eyebrow">Payment plan</p><h3>Milestones</h3><p>New invoices start with a balanced 50/50 plan. Marking a phase paid updates the collected balance.</p></div><Button variant="secondary" size="sm" icon={Plus} type="button" onClick={() => { setPaymentPlanTouched(true); setForm({ ...form, payments: [...form.payments, { name: `Payment phase ${form.payments.length + 1}`, amount: Math.max(0, Number(form.amount || 0) - allocated), status: 'Pending', is_paid: false }] }) }}>Add phase</Button></header>
          <div className="milestone-summary"><span>Allocated <strong className={allocated === Number(form.amount) ? 'positive' : allocated > Number(form.amount) ? 'negative' : ''}>{formatCurrency(allocated, form.currency || 'LKR')}</strong></span><span>Unallocated <strong>{formatCurrency(Number(form.amount || 0) - allocated, form.currency || 'LKR')}</strong></span><span>Paid <strong>{formatCurrency(paidInForm, form.currency || 'LKR')}</strong></span></div>
          <div className="milestone-list">{form.payments.map((payment, index) => <div className="milestone-row" key={payment.id || index}><Input label="Phase" value={payment.name} onChange={(event) => updatePayment(index, { name: event.target.value })} /><Input label="Amount" type="number" min="0" step="0.01" value={payment.amount || ''} onChange={(event) => updatePayment(index, { amount: Number(event.target.value) })} /><Input label="Status / paid date" value={payment.status || ''} onChange={(event) => updatePayment(index, { status: event.target.value })} placeholder="Pending" /><label className="paid-toggle"><input type="checkbox" checked={paymentPaid(payment)} onChange={(event) => updatePayment(index, { is_paid: event.target.checked, isPaid: event.target.checked, status: event.target.checked && (!payment.status || payment.status === 'Pending') ? `Paid ${new Date().toISOString().slice(0, 10)}` : payment.status })} /><span><Check size={13} /></span>Paid</label><button type="button" className="icon-button icon-button--danger" onClick={() => { setPaymentPlanTouched(true); setForm({ ...form, payments: form.payments.filter((_, paymentIndex) => paymentIndex !== index) }) }} aria-label={`Remove ${payment.name}`}><Trash2 size={17} /></button></div>)}</div>
        </section>

        <section className="renewal-editor"><div><p className="eyebrow">Optional annual care</p><h3>Annual renewal & service expiry</h3><p>Track hosting, maintenance or domain renewals alongside the project.</p></div><div className="form-grid"><Input label="Renewal amount" type="number" min="0" step="0.01" value={form.renewal_amount || ''} onChange={(event) => setForm({ ...form, renewal_amount: Number(event.target.value) })} optional /><Select label="Renewal currency" value={form.renewal_currency || 'LKR'} onChange={(event) => setForm({ ...form, renewal_currency: event.target.value })}><option value="LKR">LKR</option><option value="USD">USD</option><option value="GBP">GBP</option></Select><Input label="Service expiry / renewal date" type="date" value={form.renewal_due_date?.slice(0, 10) || ''} onChange={(event) => setForm({ ...form, renewal_due_date: event.target.value })} optional /></div></section>
        <Textarea label="Payment instructions (visible to client)" value={form.payment_instructions || ''} onChange={event => setForm({ ...form, payment_instructions: event.target.value })} rows={3} placeholder="Bank name, account name, account number and payment reference" /><Textarea label="Client note" value={form.customer_note || ''} onChange={event => setForm({ ...form, customer_note: event.target.value })} rows={2} optional /><Textarea label="Internal notes (admin only)" value={form.notes || ''} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={3} placeholder="Payment instructions or internal context…" optional />
      </form>
    </Modal>
    <Modal open={Boolean(shared)} onClose={() => setShared(null)} title="Share invoice" description="This link always displays the latest saved invoice. Send it again after making changes.">{shared?.share_url && <><SharePanel url={shared.share_url} title={`${shared.reference || 'Invoice'} - ${shared.project_title}`} phone={shared.phone} email={clientFor(shared, clients)?.email} /><div className="form-grid"><Input label="Link expiry" type="date" value={linkExpiry} onChange={e => setLinkExpiry(e.target.value)} hint="Leave blank for no expiry." /><Button variant="secondary" loading={shareBusy} onClick={() => void share(shared, false, true)}>Save expiry</Button></div><div className="document-toolbar"><Button variant="secondary" loading={shareBusy} onClick={() => void share(shared, true)}>Replace link</Button><Button variant="danger" loading={shareBusy} onClick={() => void revoke()}>Revoke link</Button></div><p className="field-hint">Replacing or revoking a link immediately disables the previous link.</p></>}</Modal>
    <Modal open={history !== null} onClose={() => setHistory(null)} title={`Revision history - ${historyTitle}`} description="Saved snapshots show how this invoice changed over time.">{history?.length ? history.map(item => <details className="revision-item" key={item.version}><summary>Version {item.version} - {formatDate(item.created_at)} - {formatCurrency(item.snapshot.amount || item.snapshot.project_value || 0, item.snapshot.currency || 'LKR')}</summary><dl className="document-summary"><div><dt>Project</dt><dd>{item.snapshot.project_title}</dd></div><div><dt>Status</dt><dd>{item.snapshot.status}</dd></div><div><dt>Paid</dt><dd>{formatCurrency(item.snapshot.paid_amount || item.snapshot.payment_records?.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) || 0, item.snapshot.currency || 'LKR')}</dd></div><div><dt>Due</dt><dd>{formatDate(item.snapshot.due_date)}</dd></div></dl></details>) : <p>No saved revisions yet.</p>}</Modal>
    <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={remove} loading={deleteBusy} title={`Void ${deleting?.reference || 'invoice'}?`} description="The invoice and its payment history remain in the audit record, but it will no longer count as open." confirmLabel="Void invoice" warning="A void invoice remains available for historical accuracy." />
  </div>
}
