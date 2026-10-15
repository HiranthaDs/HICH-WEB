import { ArrowUpRight, CalendarDays, Check, CircleDollarSign, Download, FileText, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatCurrency, formatDate, getClientName } from '../lib/format'
import { exportCsv } from '../lib/sharing'
import type { Client, Invoice } from '../lib/types'
import { Button, EmptyState, StatusPill } from './ui'
import './renewal-invoices.css'

export function renewalSources(invoices: Invoice[]) {
  return invoices.filter(invoice => invoice.invoice_kind !== 'renewal' && invoice.status !== 'void' && (Number(invoice.renewal_amount) > 0 || invoice.renewal_due_date))
}

export function RenewalsWorkspace({ invoices, clients, query, busyId, busyAction, onOpen, onShare, onPayment, onEdit }: {
  invoices: Invoice[]
  clients: Client[]
  query: string
  busyId?: string
  busyAction?: string
  onOpen: (source: Invoice) => void
  onShare: (invoice: Invoice) => void
  onPayment: (invoice: Invoice) => void
  onEdit: (source: Invoice) => void
}) {
  const [filter, setFilter] = useState<'all' | 'action' | 'upcoming' | 'paid'>('all')
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })
  const upcomingAfter = new Date(new Date(`${today}T12:00:00+05:30`).getTime() + 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })
  const rows = useMemo(() => {
    const sources = renewalSources(invoices)
    const sourcesById = new Map(sources.map(source => [String(source.id), source]))
    const renewals = invoices.filter(invoice => invoice.invoice_kind === 'renewal' && invoice.status !== 'void')
    const cycleKey = (sourceId: Invoice['id'] | undefined, date?: string) => `${sourceId}:${date?.slice(0, 10) || ''}`
    const invoicesByCycle = new Map(renewals.map(invoice => [cycleKey(invoice.renewal_source_invoice_id, invoice.renewal_period_date), invoice]))
    const result: Array<{ source: Invoice; invoice?: Invoice }> = sources.map(source => ({ source, invoice: invoicesByCycle.get(cycleKey(source.id, source.renewal_due_date)) }))
    const included = new Set(result.map(row => row.invoice?.id))
    // Keep completed cycles accessible after payment advances the project's next expiry.
    for (const invoice of renewals) {
      if (included.has(invoice.id)) continue
      const source = sourcesById.get(String(invoice.renewal_source_invoice_id)) || invoice
      result.push({ source: { ...source, renewal_due_date: invoice.renewal_period_date }, invoice })
    }
    return result.sort((a, b) => Number(a.invoice?.status === 'paid') - Number(b.invoice?.status === 'paid') || (a.source.renewal_due_date || '9999').localeCompare(b.source.renewal_due_date || '9999'))
  }, [invoices])
  const clientsById = useMemo(() => new Map(clients.map(client => [String(client.id), client])), [clients])
  const isUpcoming = ({ source, invoice }: typeof rows[number]) => !invoice && Number(source.renewal_amount) > 0 && Boolean(source.renewal_due_date && source.renewal_due_date.slice(0, 10) > upcomingAfter)
  const awaiting = rows.filter(row => row.invoice && !['paid', 'void'].includes(row.invoice.status)).length
  const paid = rows.filter(row => row.invoice?.status === 'paid').length
  const search = query.trim().toLowerCase()
  const visible = rows.filter(row => {
    const { source, invoice } = row
    const matchesFilter = filter === 'all' || (filter === 'paid' ? invoice?.status === 'paid' : filter === 'upcoming' ? isUpcoming(row) : invoice?.status !== 'paid' && !isUpcoming(row))
    const client = clientsById.get(String(source.client_id))
    return matchesFilter && [source.reference, source.project_title, getClientName(source.client, source.client_name || client?.name), client?.company, invoice?.reference].join(' ').toLowerCase().includes(search)
  })

  return <section className="renewals-workspace" aria-label="Annual renewals">
    <header className="renewals-workspace__intro"><div><p className="eyebrow">Domain & hosting</p><h2>Keep each renewal moving</h2><p>Prepare an invoice for the service cycle, send it to your client, then record the payment.</p></div><span className="renewals-workspace__mark"><RefreshCw size={28} /></span></header>
    <div className="renewal-metrics"><div><FileText size={19} /><span>To prepare soon<strong>{rows.filter(row => !row.invoice && !isUpcoming(row)).length}</strong></span></div><div><CircleDollarSign size={19} /><span>Awaiting payment<strong>{awaiting}</strong></span></div><div><Check size={19} /><span>Paid cycles<strong>{paid}</strong></span></div></div>
    <div className="renewal-controls"><div className="renewal-filters" aria-label="Filter renewal cycles">{([['all', 'All cycles'], ['action', 'Needs action'], ['upcoming', 'Upcoming'], ['paid', 'Paid']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><Button variant="ghost" size="sm" icon={Download} disabled={!visible.length} onClick={() => exportCsv('hich-renewal-cycles.csv', visible.map(({ source, invoice }) => ({ Client: getClientName(source.client, source.client_name || clientsById.get(String(source.client_id))?.name), Project: source.project_title, 'Project reference': source.reference, 'Invoice reference': invoice?.reference || '', 'Service expiry': source.renewal_due_date || '', 'Payment due': invoice?.due_date || '', Amount: invoice?.amount ?? source.renewal_amount ?? 0, Paid: invoice?.paid_amount || 0, Currency: invoice?.currency || source.renewal_currency || source.currency || 'LKR', Status: invoice?.status || (isUpcoming({ source, invoice }) ? 'upcoming' : 'to prepare') })))}>Export shown</Button></div>
    <p className="renewal-filter-hint">Needs action includes unpaid invoices and renewals due within 30 days. Later cycles stay in Upcoming.</p>
    {!visible.length ? <EmptyState icon={RefreshCw} title={rows.length ? 'No renewal cycles match' : 'Set up your first renewal'} description={rows.length ? 'Try a different search or renewal filter.' : 'Edit a project invoice and add its annual renewal amount and service expiry date. It will appear here.'} /> : <div className="renewal-cycle-list">{visible.map(({ source, invoice }) => {
      const client = clientsById.get(String(source.client_id))
      const complete = invoice?.status === 'paid'
      const overdue = Boolean(!complete && source.renewal_due_date && source.renewal_due_date.slice(0, 10) < today)
      const configured = Number(source.renewal_amount) > 0 && Boolean(source.renewal_due_date)
      const upcoming = isUpcoming({ source, invoice })
      const amount = invoice ? Number(invoice.amount) : Number(source.renewal_amount || 0)
      const currency = invoice?.currency || source.renewal_currency || source.currency || 'LKR'
      const balance = invoice ? Math.max(0, amount - Number(invoice.paid_amount || 0)) : amount
      return <article className={`renewal-cycle${complete ? ' renewal-cycle--paid' : ''}`} key={invoice ? `invoice-${invoice.id}` : `source-${source.id}`}>
        <header><span className="renewal-cycle__icon">{complete ? <Check size={20} /> : <RefreshCw size={20} />}</span><div><p>{getClientName(source.client, source.client_name || client?.name)}</p><h3>{source.project_title || 'Domain & hosting services'}</h3><small>{source.reference}{invoice?.reference ? ` · ${invoice.reference}` : ''}</small></div>{invoice ? <StatusPill status={invoice.status} /> : <span className={`status status--${overdue ? 'warning' : 'muted'}`}>{upcoming ? 'Upcoming' : configured ? 'Invoice needed' : 'Setup needed'}</span>}</header>
        <div className="renewal-cycle__details"><div><span><CalendarDays size={14} /> Service expiry</span><strong>{formatDate(source.renewal_due_date)}</strong>{overdue && <small className="renewal-cycle__overdue">Past service expiry</small>}</div><div><span>{invoice ? 'Invoice total' : 'Annual renewal'}</span><strong>{formatCurrency(amount, currency)}</strong>{invoice && <small>{complete ? 'Payment received' : `${formatCurrency(balance, currency)} outstanding`}</small>}</div></div>
        <footer><p>{complete ? 'Payment complete. Confirm service renewal with the provider.' : invoice?.status === 'draft' ? 'Invoice prepared. Your client message is ready to review.' : invoice ? 'Send the invoice or record cleared funds when received.' : configured ? upcoming ? 'This cycle is more than 30 days away. Prepare early if needed.' : 'Review service charges before preparing the client message.' : 'Add the renewal amount and expiry date to continue.'}</p><div className="renewal-cycle__actions">{invoice && <Button size="sm" variant="secondary" disabled={Boolean(busyId)} loading={busyId === String(invoice.id) && busyAction === 'share'} onClick={() => onShare(invoice)}>{complete ? 'Send paid invoice' : 'Send invoice'}</Button>}{invoice && !complete && <Button size="sm" variant="secondary" disabled={Boolean(busyId)} loading={busyId === String(invoice.id) && busyAction === 'payment'} onClick={() => onPayment(invoice)}>Record payment</Button>}<Button size="sm" variant={invoice ? 'ghost' : 'primary'} icon={ArrowUpRight} loading={busyId === String(invoice?.id || source.id) && busyAction === 'renewal'} disabled={Boolean(busyId)} onClick={() => invoice ? onOpen(invoice) : configured ? onOpen(source) : onEdit(source)}>{invoice ? 'Review' : configured ? 'Prepare invoice' : 'Set up renewal'}</Button></div></footer>
      </article>
    })}</div>}
  </section>
}
