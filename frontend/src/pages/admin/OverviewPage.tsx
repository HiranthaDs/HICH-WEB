import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  MessageCircle,
  Lightbulb,
  RefreshCw,
  TrendingUp,
  ShieldCheck,
  Users,
  WalletCards,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button, EmptyState, ErrorState, LoadingState, PageHeader, StatusPill } from '../../components/ui'
import { ContactActions } from '../../components/ContactActions'
import { api } from '../../lib/api'
import { formatCurrency, formatDate, formatRelative, getClientName, titleCase } from '../../lib/format'
import type { DashboardData, Invoice } from '../../lib/types'

function MetricCard({ label, value, note, icon: Icon, tone = 'green' }: { label: string; value: string; note: string; icon: typeof Users; tone?: string }) {
  return <article className="metric-card"><div className={`metric-card__icon metric-card__icon--${tone}`}><Icon size={20} /></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>
}

const phoneForInvoice = (invoice: Invoice) => invoice.phone || (typeof invoice.client === 'object' ? invoice.client.phone : '')

const insightIcon = (severity: string) => severity === 'critical' || severity === 'warning' ? AlertTriangle : severity === 'opportunity' ? Lightbulb : severity === 'success' ? ShieldCheck : BrainCircuit

function openWhatsApp(phone: string | undefined, message: string) {
  if (!phone) return
  const clean = phone.replace(/\D/g, '')
  window.open(`https://wa.me/${clean}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer')
}

export function OverviewPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setData(await api.dashboard()) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Dashboard data is unavailable.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const metrics = data?.metrics || {}
  const revenue = data?.revenue || []
  const chartData = useMemo(() => revenue.map((point) => ({
    label: point.label || point.month || (point.date ? formatDate(point.date, { month: 'short' }) : ''),
    value: Number(point.value ?? point.revenue ?? point.paid ?? 0),
    pending: Number(point.pending ?? 0),
  })), [revenue])
  const totalRevenue = Number(metrics.total_revenue ?? data?.total_revenue ?? 0)
  const pendingRevenue = Number(metrics.pending_revenue ?? data?.pending_revenue ?? 0)
  const activeClients = Number(metrics.active_clients ?? data?.active_clients ?? 0)
  const awaiting = Number(metrics.awaiting_signatures ?? data?.awaiting_signatures ?? 0)
  const invoices = data?.upcoming_invoices || []
  const renewals = data?.upcoming_renewals || []
  const intelligence = data?.intelligence

  return (
    <div className="admin-page">
      <PageHeader eyebrow="Workspace overview" title="Good to see you." description="A clear view of revenue, signatures and the follow-ups that need attention." action={<><ContactActions /><Button variant="secondary" icon={RefreshCw} loading={loading} onClick={load}>Refresh</Button></>} />
      {loading && !data ? <LoadingState /> : error && !data ? <ErrorState message={error} onRetry={load} /> : <>
        {error && <div className="inline-alert inline-alert--error"><Clock3 size={18} /><span>{error}</span></div>}
        <section className="metric-grid" aria-label="Business summary">
          <MetricCard label="Collected revenue" value={formatCurrency(totalRevenue)} note={metrics.revenue_change ? `${metrics.revenue_change > 0 ? '+' : ''}${metrics.revenue_change}% from last period` : 'Confirmed payments'} icon={CircleDollarSign} tone="green" />
          <MetricCard label="Pending revenue" value={formatCurrency(pendingRevenue)} note={`${invoices.filter((invoice) => invoice.status !== 'paid').length} open invoice${invoices.length === 1 ? '' : 's'}`} icon={WalletCards} tone="amber" />
          <MetricCard label="Active clients" value={String(activeClients)} note={metrics.clients_change ? `${metrics.clients_change > 0 ? '+' : ''}${metrics.clients_change}% this period` : 'Current relationships'} icon={Users} tone="blue" />
          <MetricCard label="Awaiting signatures" value={String(awaiting)} note="Agreements to follow up" icon={FileCheck2} tone="violet" />
        </section>

        {intelligence && <section className="intelligence-panel panel" aria-labelledby="intelligence-heading">
          <header className="intelligence-panel__header">
            <div className="intelligence-panel__title"><span><BrainCircuit size={21} /></span><div><p className="eyebrow">Hich Intelligence</p><h2 id="intelligence-heading">Your operational brain</h2><p>{intelligence.narrative}</p></div></div>
            <div className={`health-score health-score--${intelligence.risk_level}`} aria-label={`Business health score ${intelligence.health_score} out of 100`}><strong>{intelligence.health_score}</strong><span>Health score</span></div>
          </header>
          <div className="intelligence-stats"><div><span>30-day cash forecast</span><strong>{formatCurrency(intelligence.cash_forecast_30d)}</strong></div><div><span>Overdue balance</span><strong>{formatCurrency(intelligence.overdue_balance)}</strong></div><div><span>Revenue momentum</span><strong>{intelligence.revenue_momentum_percent == null ? 'Learning' : `${intelligence.revenue_momentum_percent > 0 ? '+' : ''}${intelligence.revenue_momentum_percent}%`}</strong></div></div>
          <div className="insight-grid">{intelligence.insights.slice(0, 4).map((insight) => { const Icon = insightIcon(insight.severity); return <article className={`insight-card insight-card--${insight.severity}`} key={insight.id}><span className="insight-card__icon"><Icon size={18} /></span><div><small>{insight.category}</small><h3>{insight.title}</h3><p>{insight.summary}</p><em>{insight.recommendation}</em>{insight.action_path && <Link to={insight.action_path} className="text-link">{insight.action_label || 'Take action'} <ArrowRight size={14} /></Link>}</div></article> })}</div>
        </section>}

        <div className="overview-grid">
          <section className="panel panel--chart">
            <header className="panel__header"><div><p className="eyebrow">Income analytics</p><h2>Revenue movement</h2></div><span className="panel-chip"><TrendingUp size={15} /> Live overview</span></header>
            {chartData.length ? <div className="revenue-chart" aria-label="Revenue chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 12, right: 10, left: -18, bottom: 0 }}><defs><linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#5263ff" stopOpacity={0.32} /><stop offset="100%" stopColor="#5263ff" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid vertical={false} stroke="#edf0fa" strokeDasharray="3 5" /><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#858ca8', fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: '#858ca8', fontSize: 11 }} tickFormatter={(value) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)} /><Tooltip formatter={(value) => formatCurrency(Number(value))} contentStyle={{ borderRadius: 14, border: '1px solid #e7eafa', boxShadow: '0 14px 40px rgba(18,38,29,.12)' }} /><Area type="monotone" dataKey="value" stroke="#2233ff" strokeWidth={2.6} fill="url(#revenueFill)" /></AreaChart></ResponsiveContainer></div> : <EmptyState icon={TrendingUp} title="No revenue history yet" description="Paid invoice activity will appear here as data becomes available." />}
          </section>

          <section className="panel panel--status">
            <header className="panel__header"><div><p className="eyebrow">Agreements</p><h2>Signature pipeline</h2></div><Link to="/admin/agreements" className="icon-button" aria-label="View agreements"><ArrowRight size={18} /></Link></header>
            <div className="status-breakdown">
              {(data?.agreement_statuses || []).length ? data!.agreement_statuses!.map((item, index) => {
                const count = Number(item.value ?? item.count ?? 0)
                const total = data!.agreement_statuses!.reduce((sum, next) => sum + Number(next.value ?? next.count ?? 0), 0) || 1
                return <div key={`${item.status}-${index}`}><div><span><i className={`status-dot status-dot--${item.status || item.name}`} />{titleCase(item.name || item.status)}</span><strong>{count}</strong></div><progress max={total} value={count} aria-label={`${item.name || item.status}: ${count}`} /></div>
              }) : <EmptyState icon={FileCheck2} title="No agreement activity" description="Create an agreement to begin the signature pipeline." action={<Link className="button button--secondary button--sm" to="/admin/agreements">Create agreement</Link>} />}
            </div>
          </section>
        </div>

        <div className="overview-lower-grid">
          <section className="panel">
            <header className="panel__header"><div><p className="eyebrow">Payment watch</p><h2>Upcoming invoices</h2></div><Link to="/admin/invoices" className="text-link">View all <ArrowRight size={15} /></Link></header>
            {invoices.length ? <div className="watch-list">{invoices.slice(0, 5).map((invoice) => {
              const paid = Number(invoice.paid_amount || 0)
              const balance = Math.max(0, Number(invoice.amount || 0) - paid)
              const phone = phoneForInvoice(invoice)
              return <article key={invoice.id} className="watch-row"><span className="watch-row__icon"><CalendarClock size={19} /></span><div className="watch-row__main"><strong>{getClientName(invoice.client, invoice.client_name)}</strong><small>{invoice.reference || `Invoice #${invoice.id}`} · Due {formatDate(invoice.due_date)}</small><progress max={Math.max(invoice.amount, 1)} value={paid} /></div><div className="watch-row__value"><strong>{formatCurrency(balance, invoice.currency || 'LKR')}</strong><StatusPill status={invoice.status} /></div>{phone && <button className="icon-button icon-button--whatsapp" type="button" aria-label="Send WhatsApp invoice reminder" onClick={() => openWhatsApp(phone, `Hello ${getClientName(invoice.client, invoice.client_name)}, this is a friendly reminder from Hich Studio regarding ${invoice.reference || 'your invoice'}. The current balance is ${formatCurrency(balance, invoice.currency || 'LKR')}.${invoice.share_url ? `\n\nView invoice: ${invoice.share_url}` : ''}`)}><MessageCircle size={18} /></button>}</article>
            })}</div> : <EmptyState icon={CheckCircle2} title="No payments need attention" description="Upcoming and overdue invoices will be listed here." />}
          </section>

          <section className="panel">
            <header className="panel__header"><div><p className="eyebrow">Annual care</p><h2>Renewal reminders</h2></div><span className="panel-chip panel-chip--warm">{renewals.length} due</span></header>
            {renewals.length ? <div className="renewal-list">{renewals.slice(0, 5).map((renewal, index) => {
              const name = getClientName(renewal.client, renewal.client_name)
              return <article key={renewal.id || `${name}-${index}`}><div className="renewal-list__date"><strong>{formatDate(renewal.due_date, { day: '2-digit' })}</strong><small>{formatDate(renewal.due_date, { month: 'short' })}</small></div><div><strong>{name}</strong><small>{formatCurrency(renewal.amount || 0, renewal.currency || 'LKR')} · {formatDate(renewal.due_date)}</small></div>{renewal.phone && <button className="icon-button icon-button--whatsapp" type="button" onClick={() => openWhatsApp(renewal.phone, `Hello ${name}, this is a friendly reminder that your annual Hich Studio renewal of ${formatCurrency(renewal.amount || 0, renewal.currency || 'LKR')} is due on ${formatDate(renewal.due_date)}.${renewal.share_url ? `\n\nView details: ${renewal.share_url}` : ''}`)} aria-label={`Send renewal reminder to ${name}`}><MessageCircle size={17} /></button>}</article>
            })}</div> : <EmptyState icon={CalendarClock} title="No renewals approaching" description="Renewals due soon will appear here automatically." />}
          </section>
        </div>

        <section className="panel activity-preview">
          <header className="panel__header"><div><p className="eyebrow">Workspace activity</p><h2>Recent updates</h2></div><Link to="/admin/activity" className="text-link">Full activity <ArrowRight size={15} /></Link></header>
          {(data?.recent_activity || []).length ? <div className="activity-preview__list">{data!.recent_activity!.slice(0, 6).map((event) => <article key={event.id}><span><CheckCircle2 size={16} /></span><div><strong>{event.action}</strong><p>{event.details || event.target}</p></div><time>{formatRelative(event.created_at)}</time></article>)}</div> : <EmptyState title="Nothing recorded yet" description="Important client and document changes will create an audit trail here." />}
        </section>
      </>}
    </div>
  )
}
