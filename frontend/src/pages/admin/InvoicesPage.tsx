import { Check, CircleDollarSign, Link2, History, Download, FileText, MessageCircle, MoreHorizontal, Plus, ReceiptText, RefreshCw, Trash2, WalletCards } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { InvoicePayments } from '../../components/InvoicePayments'
import { RenewalInvoiceForm, RenewalItemsEditor } from '../../components/RenewalInvoiceForm'
import { SharePanel } from '../../components/SharePanel'
import { exportCsv } from '../../lib/sharing'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Button, ConfirmDialog, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, SearchInput, Select, StatusPill, Textarea } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { api, deletionPin } from '../../lib/api'
import { invoiceMessage, renewalMessage } from '../../lib/messages'
import { addPaymentPhase } from '../../lib/paymentPlan'
import { formatCurrency, formatDate, getClientName } from '../../lib/format'
import type { Client, Invoice, InvoiceVersion } from '../../lib/types'

type Payment = NonNullable<Invoice['payments']>[number]
type InvoiceForm = Partial<Invoice> & { payments: Payment[] }
type InvoiceSection = 'pending' | 'completed' | 'void'
type InvoiceAction = 'share' | 'payment' | 'history' | 'revoke'
const blankInvoice: InvoiceForm = { client_id: '', project_title: '', amount: 0, paid_amount: 0, currency: 'LKR', status: 'draft', issue_date: new Date().toISOString().slice(0, 10), due_date: '', payment_method: 'Bank transfer', notes: '', renewal_amount: 0, renewal_currency: 'LKR', renewal_due_date: '', payments: [{ name: 'Advance payment', amount: 0, status: 'Pending', is_paid: false }, { name: 'Final balance', amount: 0, status: 'Pending', is_paid: false }] }
const blankClient: Partial<Client> = { name: '', company: '', email: '', phone: '', address: '', notes: '', status: 'active' }

const clientFor = (invoice: Invoice, clients: Client[]) => clients.find((client) => String(client.id) === String(invoice.client_id)) || (typeof invoice.client === 'object' ? invoice.client : undefined)
const paymentPaid = (payment: Payment) => Boolean(payment.is_paid ?? payment.isPaid)
const sectionFor = (invoice: Invoice): InvoiceSection => invoice.status === 'paid' ? 'completed' : invoice.status === 'void' ? 'void' : 'pending'

export function InvoicesPage() {
  const { toast } = useToast()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [clientQuery, setClientQuery] = useState('')
  const [renewal, setRenewal] = useState<Invoice | null>(null)
  const [renewalSource, setRenewalSource] = useState<Invoice | null>(null)
  const [lateChargeAccepted, setLateChargeAccepted] = useState(false)
  const [visitFee, setVisitFee] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('search') || '')
  useEffect(() => setQuery(params.get('search') || ''), [params])
  const [shared, setShared] = useState<Invoice | null>(null)
  const [paymentInvoice, setPaymentInvoice] = useState<Invoice | null>(null)
  const [busyAction, setBusyAction] = useState<{ invoiceId: string; action: InvoiceAction } | null>(null)
  const [history, setHistory] = useState<InvoiceVersion[] | null>(null)
  const [historyTitle, setHistoryTitle] = useState('')
  const [section, setSection] = useState<InvoiceSection>('pending')
  const [menu, setMenu] = useState<string | null>(null)
  const [loadWarning, setLoadWarning] = useState('')
  const [editing, setEditing] = useState<Invoice | 'new' | null>(null)
  const [form, setForm] = useState<InvoiceForm>({ ...blankInvoice })
  const [clientMode, setClientMode] = useState<'existing' | 'new'>('existing')
  const [newClient, setNewClient] = useState<Partial<Client>>({ ...blankClient })
  const openedRequest = useRef('')
  const loadGeneration = useRef(0)
  const [paymentPlanTouched, setPaymentPlanTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Invoice | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    setLoading(true); setError(''); setLoadWarning('')
    const [invoiceResult, clientResult] = await Promise.allSettled([api.invoices.list(), api.clients.list()])
    if (generation !== loadGeneration.current) return
    if (invoiceResult.status === 'fulfilled') setInvoices(invoiceResult.value.items)
    else setError(invoiceResult.reason instanceof Error ? invoiceResult.reason.message : 'Invoices could not be loaded.')
    if (clientResult.status === 'fulfilled') setClients(clientResult.value.items)
    else if (invoiceResult.status === 'fulfilled') setLoadWarning('Invoices are current, but some client contact details could not be refreshed. Retry before sending a message.')
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!menu) return
    const closeOnClick = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest('.more-menu')) setMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', closeOnClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('mousedown', closeOnClick); document.removeEventListener('keydown', closeOnEscape) }
  }, [menu])

  const clientFilter = params.get('client')
  const scopedInvoices = useMemo(() => invoices.filter((invoice) => !clientFilter || String(invoice.client_id) === clientFilter), [invoices, clientFilter])
  const filtered = useMemo(() => scopedInvoices.filter((invoice) => sectionFor(invoice) === section && (!query || [invoice.reference, invoice.project_title, getClientName(invoice.client, invoice.client_name)].join(' ').toLowerCase().includes(query.toLowerCase()))), [scopedInvoices, query, section])
  const sectionCounts = useMemo(() => scopedInvoices.reduce<Record<InvoiceSection, number>>((counts, invoice) => { counts[sectionFor(invoice)] += 1; return counts }, { pending: 0, completed: 0, void: 0 }), [scopedInvoices])
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
    setClientQuery('')
    setVisitFee(0)
    setPaymentPlanTouched(Boolean(invoice))
  }

  useEffect(() => {
    if (loading || error) return
    const request = params.toString()
    if (openedRequest.current === request) return
    if (params.get('create') === '1') { openedRequest.current = request; openEditor() }
    else if (params.get('invoice')) {
      const invoice = invoices.find(item => String(item.id) === params.get('invoice'))
      if (invoice) { openedRequest.current = request; setSection(sectionFor(invoice)); openEditor(invoice) }
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
  const paidInForm = form.payments.reduce((sum, payment) => sum + Number(paymentPaid(payment) ? payment.amount || 0 : payment.paid_amount || 0), 0)
  const projectTotal = Number(form.amount || 0)
  const allocationDifference = Number((projectTotal - allocated).toFixed(2))
  const outstandingInForm = Math.max(0, Number((projectTotal - paidInForm).toFixed(2)))

  const addPhase = (mid = false) => {
    try {
      let number = mid ? form.payments.filter(p => /^Mid-project payment/.test(p.name)).length + 1 : form.payments.length + 1
      let name = mid ? number === 1 ? 'Mid-project payment' : `Mid-project payment ${number}` : `Payment phase ${number}`
      while (form.payments.some(p => p.name === name)) { number++; name = mid ? `Mid-project payment ${number}` : `Payment phase ${number}` }
      const payments = addPaymentPhase(form.payments, Number(form.amount || 0), name)
      setPaymentPlanTouched(true); setForm({ ...form, payments })
    } catch (e) { toast(e instanceof Error ? e.message : 'Payment phase could not be added.', 'error') }
  }

  const addVisitFee = () => {
    if (form.currency !== 'LKR') return toast('Agree the LKR conversion rate before recording a visiting fee on a foreign-currency invoice.', 'error')
    if (visitFee < 5000 || visitFee > 15000) return toast('The visiting fee must be between LKR 5,000 and LKR 15,000.', 'error')
    if (form.payments.some(payment => /visiting fee/i.test(payment.name))) return toast('Edit the existing visiting fee phase instead of adding it twice.', 'error')
    const index = form.payments.map((payment, index) => ({ payment, index })).reverse().find(({ payment }) => /final|balance/i.test(payment.name) && !paymentPaid(payment) && Number(payment.amount) - Number(payment.paid_amount || 0) >= visitFee)?.index
    if (index === undefined) return toast('The pending final balance must cover the visiting fee. Adjust the payment schedule first.', 'error')
    const payments = form.payments.map(payment => ({ ...payment }))
    payments[index].amount = Number((Number(payments[index].amount) - visitFee).toFixed(2))
    payments.splice(index, 0, { name: 'Visiting fee (credited to project balance)', amount: visitFee, is_paid: false, status: 'Pending' })
    setPaymentPlanTouched(true); setForm({ ...form, payments })
    toast('Visiting fee included in the project total. Mark it paid only after receiving cleared funds.', 'success')
  }

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
      const payload: Partial<Invoice> = { client_id: selectedClient?.id || form.client_id, reference: form.reference || undefined, project_title: form.project_title, amount: form.amount, currency: form.currency, issue_date: form.issue_date, due_date: form.due_date || '', payment_method: form.payment_method, notes: form.notes, payment_instructions: form.payment_instructions, customer_note: form.customer_note, status: form.status, payments: normalizedPayments, ...(form.invoice_kind === 'renewal' ? { renewal_items: form.renewal_items, renewal_late_fee: form.renewal_late_fee, renewal_late_fee_accepted: form.renewal_late_fee_accepted } : {}), renewal_amount: form.renewal_amount, renewal_currency: form.renewal_currency, renewal_due_date: form.renewal_due_date || '', client_name: selectedClient?.name, phone: selectedClient?.phone, paid_amount: paidAmount, expected_revision: editing === 'new' ? undefined : form.revision }
      const original = editing !== 'new' && editing ? editing : undefined
      const removesData = original?.payments?.some(phase => phase.id && !normalizedPayments.some(p => String(p.id) === String(phase.id))) || original?.payments?.some(phase => paymentPaid(phase) && !normalizedPayments.some(p => String(p.id) === String(phase.id) && paymentPaid(p) && Number(p.amount) === Number(phase.amount))) || payload.status === 'void'
      const saved = editing === 'new' ? await api.invoices.create(payload) : await api.invoices.update((editing as Invoice).id, payload, removesData ? deletionPin() : undefined)
      setInvoices((current) => editing === 'new' ? [saved, ...current] : current.map((invoice) => invoice.id === saved.id ? saved : invoice))
      toast(editing === 'new' ? clientCreated ? 'Client and invoice created.' : 'Invoice created.' : 'Invoice updated.', 'success'); setEditing(null)
      if (saved.status !== 'void') await share(saved)
    } catch (requestError) { toast(`${clientCreated ? 'Client saved. Retry the invoice with this selected client. ' : ''}${requestError instanceof Error ? requestError.message : 'Invoice could not be saved.'}`, 'error') }
    finally { setSaving(false) }
  }

  const remove = async (pin: string) => {
    if (!deleting) return
    setDeleteBusy(true)
    try { await api.invoices.remove(deleting.id, pin); setInvoices((current) => current.filter((invoice) => invoice.id !== deleting.id)); setDeleting(null); toast('Invoice deleted from the workspace.', 'success') }
    catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'Invoice could not be voided.', 'error') }
    finally { setDeleteBusy(false) }
  }

  const share = async (invoice: Invoice, rotate = false) => {
    const invoiceId = String(invoice.id)
    setBusyAction({ invoiceId, action: 'share' })
    try {
      // Invoice links are intentionally non-expiring. Sending null also clears any expiry saved by an older version.
      const result = await api.invoices.share(invoice.id, { rotate, expires_at: null })
      const updated = { ...invoice, ...result.invoice, share_url: result.share_url, share_expires_at: undefined }
      setShared(updated)
      setInvoices(current => current.map(item => item.id === invoice.id ? updated : item))
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not create link.', 'error') }
    finally { setBusyAction(current => current?.invoiceId === invoiceId && current.action === 'share' ? null : current) }
  }
  const revoke = async () => {
    if (!shared) return
    const invoiceId = String(shared.id)
    setBusyAction({ invoiceId, action: 'revoke' })
    try { await api.invoices.revoke(shared.id); setInvoices(current => current.map(item => item.id === shared.id ? { ...item, share_url: undefined } : item)); setShared(null); toast('Invoice link revoked.', 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not revoke link.', 'error') }
    finally { setBusyAction(current => current?.invoiceId === invoiceId && current.action === 'revoke' ? null : current) }
  }
  const showHistory = async (invoice: Invoice) => {
    const invoiceId = String(invoice.id)
    setBusyAction({ invoiceId, action: 'history' })
    try { setHistory(await api.invoices.versions(invoice.id)); setHistoryTitle(invoice.reference || invoice.project_title || 'Invoice') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not load history.', 'error') }
    finally { setBusyAction(current => current?.invoiceId === invoiceId && current.action === 'history' ? null : current) }
  }
  const openPayment = async (invoice: Invoice) => {
    const invoiceId = String(invoice.id)
    setBusyAction({ invoiceId, action: 'payment' })
    try { setPaymentInvoice(await api.invoices.get(invoice.id)) }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not load payment details.', 'error') }
    finally { setBusyAction(current => current?.invoiceId === invoiceId && current.action === 'payment' ? null : current) }
  }
  const openRenewal = (invoice: Invoice) => {
    setMenu(null)
    if (Number(invoice.renewal_amount || 0) <= 0 || !invoice.renewal_due_date) {
      toast('Add the renewal amount and service expiry date under Edit payments first.', 'error')
      openEditor(invoice)
      return
    }
    setLateChargeAccepted(false)
    setRenewal(invoice)
  }

  const prepareRenewal = async (source: Invoice) => {
    if (!source.renewal_due_date) return toast('Save the service expiry / renewal date under Edit payments first.', 'error')
    const existing = invoices.find(invoice => invoice.invoice_kind === 'renewal' && String(invoice.renewal_source_invoice_id) === String(source.id) && invoice.renewal_period_date?.slice(0, 10) === source.renewal_due_date?.slice(0, 10) && invoice.status !== 'void')
    setRenewal(null)
    if (existing) return share(existing)
    setRenewalSource(source)
  }

  const updateRenewalItems = (items: NonNullable<Invoice['renewal_items']>) => {
    const base = Math.round(items.reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100
    const fee = Number(form.renewal_late_fee) > 0 ? Math.round(base * 18) / 100 : 0
    const amount = Number((base + fee).toFixed(2))
    setForm({ ...form, renewal_items: items, renewal_late_fee: fee, amount, payments: form.payments.length === 1 && !paymentPaid(form.payments[0]) ? [{ ...form.payments[0], amount }] : form.payments })
  }

  return <div className="admin-page">
    <PageHeader eyebrow="Payments" title="Invoices" description="Track payment milestones, balances and annual renewals without losing context." action={<Button icon={Plus} onClick={() => openEditor()}>New invoice</Button>} />
    {clientFilter && <div className="document-toolbar"><span>Invoices for {clients.find(client => String(client.id) === clientFilter)?.name || 'this client'}</span><Link className="text-link" to="/admin/invoices">Show all clients</Link></div>}
    <section className="invoice-summary"><article><span><CircleDollarSign size={21} /></span><div><small>Collected</small><strong>{totalPaid}</strong></div></article><article><span><WalletCards size={21} /></span><div><small>Outstanding</small><strong>{totalOutstanding}</strong></div></article><article><span><FileText size={21} /></span><div><small>Open invoices</small><strong>{invoices.filter((invoice) => !['paid', 'void'].includes(invoice.status)).length}</strong></div></article></section>
    <nav className="invoice-sections" aria-label="Invoice sections">
      <button type="button" className={section === 'pending' ? 'active' : ''} aria-current={section === 'pending' ? 'page' : undefined} onClick={() => setSection('pending')}>Pending <span>{sectionCounts.pending}</span></button>
      <button type="button" className={section === 'completed' ? 'active' : ''} aria-current={section === 'completed' ? 'page' : undefined} onClick={() => setSection('completed')}>Completed <span>{sectionCounts.completed}</span></button>
      <button type="button" className={section === 'void' ? 'active' : ''} aria-current={section === 'void' ? 'page' : undefined} onClick={() => setSection('void')}>Voided <span>{sectionCounts.void}</span></button>
    </nav>
    <section className="toolbar panel panel--flat"><SearchInput value={query} onChange={setQuery} placeholder={`Search ${section} invoices…`} label={`Search ${section} invoices`} /><div className="toolbar__right"><Button variant="ghost" size="sm" icon={Download} disabled={!filtered.length} onClick={() => exportCsv(`hich-${section}-invoices.csv`, filtered.map(i => ({ Reference: i.reference, Client: i.client_name, Project: i.project_title, Total: i.amount, Paid: i.paid_amount, Currency: i.currency, Status: i.status, Due: i.due_date, Renewal: i.renewal_amount, 'Renewal currency': i.renewal_currency, 'Renewal due': i.renewal_due_date })))}>Export shown</Button><Button variant="ghost" size="sm" icon={RefreshCw} loading={loading} onClick={load}>Refresh</Button></div></section>
    {(loadWarning || (error && invoices.length > 0)) && <div className="data-notice" role="status"><span>{loadWarning || `Refresh failed: ${error}. The last successfully loaded invoices remain visible.`}</span><Button variant="ghost" size="sm" onClick={load}>Retry</Button></div>}
    {loading && !invoices.length ? <LoadingState label="Loading invoices…" /> : error && !invoices.length ? <ErrorState title="Invoices could not be loaded" message={error} onRetry={load} /> : filtered.length === 0 ? <EmptyState icon={section === 'completed' ? Check : section === 'void' ? Trash2 : FileText} title={query ? `No ${section} invoices match` : section === 'pending' ? 'No pending invoices' : section === 'completed' ? 'No completed invoices yet' : 'No voided invoices'} description={query ? 'Try a different search.' : section === 'pending' ? 'You are caught up. Create a new invoice when the next project is ready.' : section === 'completed' ? 'Fully paid invoices move here automatically.' : 'Voided invoices are kept separate from active work.'} action={!query && section === 'pending' ? <Button icon={Plus} onClick={() => openEditor()}>Create invoice</Button> : undefined} /> : <div className="invoice-list">{filtered.map((invoice) => {
      const client = clientFor(invoice, clients)
      const paid = Number(invoice.paid_amount ?? invoice.payments?.filter(paymentPaid).reduce((sum, payment) => sum + Number(payment.amount || 0), 0) ?? 0)
      const balance = Math.max(0, invoice.amount - paid)
      const percentage = invoice.amount ? Math.min(100, paid / invoice.amount * 100) : 0
      const invoiceId = String(invoice.id)
      const rowBusy = busyAction?.invoiceId === invoiceId
      return <article className="invoice-row" key={invoice.id}>
        <div className="invoice-row__main"><span className="invoice-row__icon"><FileText size={20} /></span><div><span>{invoice.reference || `INV-${invoice.id}`}</span><h3>{invoice.project_title || 'Project invoice'}</h3><p>{invoice.client_id ? <Link className="text-link" to={`/admin/clients?client=${encodeURIComponent(String(invoice.client_id))}`}>{getClientName(invoice.client, invoice.client_name || client?.name)}</Link> : getClientName(invoice.client, invoice.client_name || client?.name)} · Due {formatDate(invoice.due_date)}</p></div></div>
        <div className="invoice-row__progress"><div><span>Paid {formatCurrency(paid, invoice.currency || 'LKR')}</span><span>{Math.round(percentage)}%</span></div><progress max="100" value={percentage} /></div>
        <div className="invoice-row__amount"><small>Total {formatCurrency(Number(invoice.amount), invoice.currency || 'LKR')}</small><small>Balance</small><strong>{formatCurrency(balance, invoice.currency || 'LKR')}</strong><StatusPill status={invoice.status} /></div>
        <div className="invoice-row__actions"><div className="more-menu"><Button variant="secondary" size="sm" icon={MoreHorizontal} loading={rowBusy} aria-haspopup="menu" aria-expanded={menu === invoiceId} onClick={() => setMenu(current => current === invoiceId ? null : invoiceId)}>Actions</Button>{menu === invoiceId && <div className="more-menu__popover invoice-actions-menu" role="menu">
          {invoice.status !== 'void' && <button role="menuitem" type="button" onClick={() => { setMenu(null); void share(invoice) }}><Link2 size={15} /> Share & send message</button>}
          <button role="menuitem" type="button" onClick={() => { setMenu(null); void showHistory(invoice) }}><History size={15} /> Revision history</button>
          {invoice.status !== 'void' && <button role="menuitem" type="button" onClick={() => { setMenu(null); void openPayment(invoice) }}><CircleDollarSign size={15} /> Add payment</button>}
          {invoice.invoice_kind !== 'renewal' && invoice.status !== 'void' && <button role="menuitem" type="button" onClick={() => openRenewal(invoice)}><RefreshCw size={15} /> Renewal invoice</button>}
          {invoice.invoice_kind !== 'renewal' && invoice.status !== 'void' && <Link role="menuitem" onClick={() => setMenu(null)} to={`/admin/agreements?create=1&client=${invoice.client_id}&invoice=${invoice.id}`}><ReceiptText size={15} /> Create agreement</Link>}
          {invoice.status !== 'void' && <button role="menuitem" type="button" onClick={() => { setMenu(null); openEditor(invoice) }}><WalletCards size={15} /> Edit payments</button>}
          <button role="menuitem" className="danger" type="button" onClick={() => { setMenu(null); setDeleting(invoice) }}><Trash2 size={15} /> Delete invoice</button>
        </div>}</div></div>
        {invoice.invoice_kind !== 'renewal' && Number(invoice.renewal_amount || 0) > 0 ? <button type="button" className="invoice-row__renewal" onClick={() => openRenewal(invoice)}><RefreshCw size={14} /> Renewal {formatCurrency(Number(invoice.renewal_amount), invoice.renewal_currency || 'LKR')} · {formatDate(invoice.renewal_due_date)}{(invoice.phone || client?.phone) && <MessageCircle size={14} />}</button> : null}
      </article>
    })}</div>}

    <Modal open={Boolean(editing)} onClose={() => { if (!saving) setEditing(null) }} title={editing === 'new' ? 'Create an invoice' : 'Edit invoice'} description="Add your client, project amount, payment phases and annual renewal in one place." size="xl" footer={<><Button variant="ghost" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="invoice-form" loading={saving}>{editing === 'new' ? 'Create invoice' : 'Save changes'}</Button></>}>
      <form id="invoice-form" className={`invoice-form${editing !== 'new' ? ' invoice-form--payments-first' : ''}`} onSubmit={save}>
        <section className="invoice-client-editor">
          <div><p className="eyebrow">Client details</p><h3>Who is this invoice for?</h3><p>New clients are saved to Clients and can be selected when creating an agreement.</p></div>
          <Select label="Client option" value={clientMode} disabled={saving} onChange={event => setClientMode(event.target.value as 'existing' | 'new')}><option value="existing">Select an existing client</option><option value="new">Create a new client</option></Select>
          {clientMode === 'new' ? <div className="form-grid">
            <Input label="Client name" value={newClient.name || ''} onChange={event => setNewClient({ ...newClient, name: event.target.value })} maxLength={160} autoComplete="name" required />
            <Input label="Company" value={newClient.company || ''} onChange={event => setNewClient({ ...newClient, company: event.target.value })} maxLength={200} autoComplete="organization" optional />
            <Input label="Email address" type="email" value={newClient.email || ''} onChange={event => setNewClient({ ...newClient, email: event.target.value })} autoComplete="email" optional />
            <Input label="Phone number" type="tel" value={newClient.phone || ''} onChange={event => setNewClient({ ...newClient, phone: event.target.value })} maxLength={40} autoComplete="tel" placeholder="+94 71 123 4567" hint="Used for calls, WhatsApp and agreements." optional />
            <Textarea className="form-grid__full" label="Address" value={newClient.address || ''} onChange={event => setNewClient({ ...newClient, address: event.target.value })} maxLength={1000} rows={2} autoComplete="street-address" optional />
          </div> : <><SearchInput label="Search invoice client records" value={clientQuery} onChange={setClientQuery} placeholder="Search name, company, email or phone?" /><Select label="Client" value={String(form.client_id || '')} onChange={event => setForm({ ...form, client_id: event.target.value })} required><option value="">Select a client…</option>{clients.filter(client => String(client.id) === String(form.client_id) || [client.name, client.company, client.email, client.phone].join(' ').toLowerCase().includes(clientQuery.toLowerCase())).map(client => <option key={client.id} value={String(client.id)}>{client.company ? `${client.company} — ${client.name}` : client.name}{client.status === 'archived' ? ' (archived)' : ''}</option>)}</Select>{form.client_id && <Link className="text-link" to={`/admin/clients?client=${encodeURIComponent(String(form.client_id))}`}>View client profile</Link>}{!clients.length && <p className="field-hint">No clients yet. Choose “Create a new client” above.</p>}</>}
        </section>
        <div className="form-grid">
          <Input label="Project title" value={form.project_title || ''} onChange={(event) => setForm({ ...form, project_title: event.target.value })} placeholder="Website design & development" required />
          <Input label="Reference" value={form.reference || ''} onChange={(event) => setForm({ ...form, reference: event.target.value })} placeholder="Generated if left blank" optional />
          <Input label={form.invoice_kind === 'renewal' ? 'Total renewal invoice amount' : 'Total project amount'} readOnly={form.invoice_kind === 'renewal'} type="number" min="0.01" step="0.01" value={form.amount || ''} onChange={(event) => updateProjectValue(Number(event.target.value))} hint={form.invoice_kind === 'renewal' ? 'Calculated from the renewal service charges and any accepted surcharge.' : 'Start with 50/50, then add and adjust any number of instalments below.'} required />
          <Select label="Project currency" value={form.currency || 'LKR'} onChange={(event) => setForm({ ...form, currency: event.target.value })}><option value="LKR">LKR — Sri Lankan rupee</option><option value="USD">USD — US dollar</option><option value="GBP">GBP — British pound</option>{form.currency && !['LKR', 'USD', 'GBP'].includes(form.currency) && <option value={form.currency}>{form.currency}</option>}</Select>
          <Input label="Issue date" type="date" value={form.issue_date?.slice(0, 10) || ''} onChange={(event) => setForm({ ...form, issue_date: event.target.value })} />
          <Input label="Due date" type="date" value={form.due_date?.slice(0, 10) || ''} onChange={(event) => setForm({ ...form, due_date: event.target.value })} />
          <Select label="Invoice status" value={form.status || 'draft'} onChange={(event) => setForm({ ...form, status: event.target.value })} hint="Partial, paid and overdue states are calculated from payments and dates."><option value="draft">Draft</option><option value="sent">Sent</option><option value="partial" disabled>Partially paid (automatic)</option><option value="paid" disabled>Paid (automatic)</option><option value="overdue" disabled>Overdue (automatic)</option><option value="void">Void (PIN required)</option></Select>
          <Input label="Payment method" value={form.payment_method || ''} onChange={(event) => setForm({ ...form, payment_method: event.target.value })} />
        </div>

        <section className="milestone-editor">{form.invoice_kind !== 'renewal' && <div className="visiting-fee-editor"><Input label="Optional visiting fee (LKR)" type="number" min="5000" max="15000" step="0.01" value={visitFee || ''} onChange={event => setVisitFee(Number(event.target.value))} placeholder="Leave blank when no visit applies" hint="Only add this milestone when a visit and fee have been agreed." optional /><Button variant="secondary" size="sm" type="button" disabled={!visitFee} onClick={addVisitFee}>Add visiting fee</Button></div>}<div className="document-toolbar"><Button variant="secondary" size="sm" type="button" onClick={() => addPhase(true)}>Add mid payment</Button><Button variant="secondary" size="sm" type="button" onClick={() => { const index = form.payments.map((payment, index) => ({ payment, index })).reverse().find(({ payment }) => /final|balance/i.test(payment.name) && !paymentPaid(payment))?.index ?? form.payments.map((payment, index) => ({ payment, index })).reverse().find(({ payment }) => !paymentPaid(payment))?.index; if (index === undefined) return toast('No pending final payment.', 'error'); updatePayment(index, { is_paid: true, isPaid: true, paid_at: new Date().toISOString(), status: 'Paid' }) }}>Record final payment</Button></div>
          <header><div><p className="eyebrow">Payment plan</p><h3>Milestones</h3><p>Add as many payment phases as needed (up to 100). New phases split the unpaid balance; edit their names and amounts to match your agreement. Use Add payment for partial receipts.</p></div><Button variant="secondary" size="sm" icon={Plus} type="button" onClick={() => addPhase()}>Add phase</Button></header>
          <div className="milestone-summary" aria-live="polite"><span>Project total <strong>{formatCurrency(projectTotal, form.currency || 'LKR')}</strong></span><span>Allocated <strong className={Math.abs(allocationDifference) <= 0.01 ? 'positive' : allocationDifference < 0 ? 'negative' : ''}>{formatCurrency(allocated, form.currency || 'LKR')}</strong></span><span>{allocationDifference < 0 ? 'Over allocated' : 'Still to allocate'} <strong className={allocationDifference < 0 ? 'negative' : ''}>{formatCurrency(Math.abs(allocationDifference), form.currency || 'LKR')}</strong></span><span>Paid <strong>{formatCurrency(paidInForm, form.currency || 'LKR')}</strong></span><span>Outstanding <strong>{formatCurrency(outstandingInForm, form.currency || 'LKR')}</strong></span></div>
          <div className="milestone-list">{form.payments.map((payment, index) => {
            const amount = Number(payment.amount || 0)
            const percentage = projectTotal > 0 ? amount / projectTotal * 100 : 0
            const allocatedThroughPhase = form.payments.slice(0, index + 1).reduce((sum, phase) => sum + Number(phase.amount || 0), 0)
            return <div className="milestone-row" key={payment.id || index}><Input label="Phase" value={payment.name} onChange={(event) => updatePayment(index, { name: event.target.value })} /><Input label="Amount" type="number" min="0" step="0.01" value={payment.amount || ''} onChange={(event) => updatePayment(index, { amount: Number(event.target.value) })} /><Input label="Payment date" type="date" disabled={!paymentPaid(payment)} value={payment.paid_at?.slice(0, 10) || ''} onChange={event => updatePayment(index, { paid_at: event.target.value ? new Date(`${event.target.value}T12:00:00+05:30`).toISOString() : undefined })} /><label className="paid-toggle"><input type="checkbox" checked={paymentPaid(payment)} onChange={(event) => updatePayment(index, { is_paid: event.target.checked, isPaid: event.target.checked, paid_at: event.target.checked ? (payment.paid_at || new Date().toISOString()) : undefined, status: event.target.checked && (!payment.status || payment.status === 'Pending') ? `Paid ${new Date().toISOString().slice(0, 10)}` : payment.status })} /><span><Check size={13} /></span>Paid</label><button type="button" className="icon-button icon-button--danger" onClick={() => { setPaymentPlanTouched(true); setForm({ ...form, payments: form.payments.filter((_, paymentIndex) => paymentIndex !== index) }) }} aria-label={`Remove ${payment.name}`}><Trash2 size={17} /></button><div className="milestone-row__calculation"><span>{percentage.toFixed(1)}% of project total</span><span>{formatCurrency(Math.max(0, projectTotal - allocatedThroughPhase), form.currency || 'LKR')} remaining after this milestone</span></div></div>
          })}</div>
        </section>

        {form.invoice_kind === 'renewal' ? <RenewalItemsEditor items={form.renewal_items || []} onChange={updateRenewalItems} /> : <section className="renewal-editor"><div><p className="eyebrow">Optional annual care</p><h3>Annual renewal & service expiry</h3><p>Track hosting, maintenance or domain renewals alongside the project.</p></div><div className="form-grid"><Input label="Renewal amount" type="number" min="0" step="0.01" value={form.renewal_amount || ''} onChange={(event) => setForm({ ...form, renewal_amount: Number(event.target.value) })} optional /><Select label="Renewal currency" value={form.renewal_currency || 'LKR'} onChange={(event) => setForm({ ...form, renewal_currency: event.target.value })}><option value="LKR">LKR</option><option value="USD">USD</option><option value="GBP">GBP</option></Select><Input label="Service expiry / renewal date" type="date" value={form.renewal_due_date?.slice(0, 10) || ''} onChange={(event) => setForm({ ...form, renewal_due_date: event.target.value })} optional /></div></section>}
        <Textarea label="Payment instructions (visible to client)" value={form.payment_instructions || ''} onChange={event => setForm({ ...form, payment_instructions: event.target.value })} rows={3} placeholder="Bank name, account name, account number and payment reference" /><Textarea label="Client note" value={form.customer_note || ''} onChange={event => setForm({ ...form, customer_note: event.target.value })} rows={2} optional /><Textarea label="Internal notes (admin only)" value={form.notes || ''} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={3} placeholder="Payment instructions or internal context…" optional />
      </form>
    </Modal>
    <RenewalInvoiceForm source={renewalSource} onClose={() => setRenewalSource(null)} onSaved={(saved, record) => { setInvoices(current => current.some(invoice => invoice.id === saved.id) ? current.map(invoice => invoice.id === saved.id ? saved : invoice) : [saved, ...current]); if (record) setPaymentInvoice(saved); else void share(saved) }} />
    <InvoicePayments invoice={paymentInvoice} onClose={() => setPaymentInvoice(null)} onSaved={saved => { setInvoices(current => current.map(invoice => invoice.id === saved.id ? saved : invoice)); void share(saved) }} />
    <Modal open={Boolean(shared)} onClose={() => setShared(null)} title={shared?.invoice_kind === 'renewal' ? shared.status === 'paid' ? 'Send paid renewal invoice' : 'Send renewal invoice' : 'Share invoice'} description={shared?.invoice_kind === 'renewal' ? 'This invoice includes only the renewal services and their payments.' : 'The non-expiring client link always displays the latest saved invoice.'}>{shared?.share_url && <><SharePanel url={shared.share_url} title={invoiceMessage(shared).subject} phone={shared.phone || clientFor(shared, clients)?.phone} email={shared.client_email || clientFor(shared, clients)?.email} message={invoiceMessage(shared).body} /><div className="document-toolbar"><Button variant="secondary" loading={busyAction?.invoiceId === String(shared.id) && busyAction.action === 'share'} onClick={() => void share(shared, true)}>Replace link</Button><Button variant="danger" loading={busyAction?.invoiceId === String(shared.id) && busyAction.action === 'revoke'} onClick={() => void revoke()}>Revoke link</Button></div><p className="field-hint">Invoice links do not expire. Replacing or revoking a link immediately disables the previous link.</p></>}</Modal>
    <Modal open={Boolean(renewal)} onClose={() => setRenewal(null)} title="Renewal invoice & client message" description="Review the saved renewal amount, prepare the invoice, and contact the client from one place." size="lg">{renewal && <>
      <dl className="document-summary renewal-summary"><div><dt>Client</dt><dd>{getClientName(renewal.client, renewal.client_name || clientFor(renewal, clients)?.name)}</dd></div><div><dt>Project</dt><dd>{renewal.project_title || 'Domain & hosting services'}</dd></div><div><dt>Renewal amount</dt><dd>{formatCurrency(Number(renewal.renewal_amount || 0), renewal.renewal_currency || 'LKR')}</dd></div><div><dt>Service expiry / renewal date</dt><dd>{formatDate(renewal.renewal_due_date)}</dd></div></dl>
      <div className="document-toolbar"><Button onClick={() => void prepareRenewal(renewal)}>Create / open renewal invoice</Button><Link className="button button--secondary" to={`/admin/clients?client=${encodeURIComponent(String(renewal.client_id || ''))}`}>Open client profile</Link></div>
      <label className="renewal-charge-consent"><input type="checkbox" checked={lateChargeAccepted} onChange={event => setLateChargeAccepted(event.target.checked)} /> This client expressly accepted the 18% late-payment surcharge in their renewal terms.</label>
      <div className="renewal-message-heading"><p className="eyebrow">Send message to client</p><h3>Professional renewal reminder</h3></div>
      <SharePanel title={renewalMessage({ client_name: getClientName(renewal.client, renewal.client_name || clientFor(renewal, clients)?.name), reference: renewal.reference, amount: renewal.renewal_amount, currency: renewal.renewal_currency, due_date: renewal.renewal_due_date, project_title: renewal.project_title }, lateChargeAccepted).subject} phone={renewal.phone || clientFor(renewal, clients)?.phone} email={renewal.client_email || clientFor(renewal, clients)?.email} message={renewalMessage({ client_name: getClientName(renewal.client, renewal.client_name || clientFor(renewal, clients)?.name), reference: renewal.reference, amount: renewal.renewal_amount, currency: renewal.renewal_currency, due_date: renewal.renewal_due_date, project_title: renewal.project_title, payment_instructions: renewal.payment_instructions }, lateChargeAccepted).body} />
    </>}</Modal>
    <Modal open={history !== null} onClose={() => setHistory(null)} title={`Revision history - ${historyTitle}`} description="Saved snapshots show how this invoice changed over time.">{history?.length ? history.map(item => <details className="revision-item" key={item.version}><summary>Version {item.version} - {formatDate(item.created_at)} - {formatCurrency(item.snapshot.amount || item.snapshot.project_value || 0, item.snapshot.currency || 'LKR')}</summary><dl className="document-summary"><div><dt>Project</dt><dd>{item.snapshot.project_title}</dd></div><div><dt>Status</dt><dd>{item.snapshot.status}</dd></div><div><dt>Paid</dt><dd>{formatCurrency(item.snapshot.paid_amount || item.snapshot.payment_records?.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) || 0, item.snapshot.currency || 'LKR')}</dd></div><div><dt>Due</dt><dd>{formatDate(item.snapshot.due_date)}</dd></div></dl></details>) : <p>No saved revisions yet.</p>}</Modal>
    <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={remove} loading={deleteBusy} title={`Delete ${deleting?.reference || 'invoice'}?`} description="Remove the invoice from the workspace and disable its public link. It will no longer count as open." confirmLabel="Delete invoice" warning="Recorded payments and invoice history remain in the audit record." />
  </div>
}
