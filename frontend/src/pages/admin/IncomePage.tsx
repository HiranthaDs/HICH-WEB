import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, RefreshCw } from 'lucide-react'
import { Button, EmptyState, ErrorState, Input, LoadingState, PageHeader, SearchInput, Select } from '../../components/ui'
import { api } from '../../lib/api'
import { formatCurrency, formatDate } from '../../lib/format'
import { exportCsv } from '../../lib/sharing'
import type { IncomeReport } from '../../lib/types'

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })
const agingLabels: Record<string, string> = { not_due: 'Not yet overdue', '1_30': '1–30 days overdue', '31_60': '31–60 days overdue', '61_90': '61–90 days overdue', over_90: 'Over 90 days overdue', no_due_date: 'No due date' }

export function IncomePage() {
  const [start, setStart] = useState(() => today().slice(0, 8) + '01')
  const [end, setEnd] = useState(today)
  const [currency, setCurrency] = useState('LKR')
  const [query, setQuery] = useState('')
  const [report, setReport] = useState<IncomeReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const load = useCallback(async () => {
    const attempt = ++generation.current
    if (!start || !end || end < start) { setError('Choose a valid start and end date.'); return }
    setBusy(true); setError('')
    try { const result = await api.income(start, end); if (attempt === generation.current) setReport(result) }
    catch (e) { if (attempt === generation.current) setError(e instanceof Error ? e.message : 'Income report could not be loaded.') }
    finally { if (attempt === generation.current) setBusy(false) }
  }, [start, end])
  useEffect(() => { void load() }, [load])
  const totals = report?.currencies.find(item => item.currency === currency)
  const money = (amount?: number) => formatCurrency(Number(amount || 0), currency)
  const matches = (parts: unknown[]) => parts.join(' ').toLowerCase().includes(query.trim().toLowerCase())
  const receipts = report?.ledger.filter(item => item.currency === currency && matches([item.client_name, item.reference, item.project_title, item.method, item.payment_reference])) || []
  const receivables = report?.receivables.filter(item => item.currency === currency && matches([item.client_name, item.reference, item.project_title])) || []
  return <div className="admin-page"><PageHeader eyebrow="Financial view" title="Income summary" description="Payment receipts, billed value, collection methods and current receivables, with each currency kept separate." action={<Button variant="secondary" icon={RefreshCw} loading={busy} onClick={() => void load()}>Refresh</Button>} />
    <section className="panel income-controls"><Input label="From" type="date" value={start} onChange={e => setStart(e.target.value)} /><Input label="To" type="date" value={end} onChange={e => setEnd(e.target.value)} /><Select label="Currency" value={currency} onChange={e => setCurrency(e.target.value)}>{[...new Set(['LKR', ...(report?.currencies.map(item => item.currency) || [])])].map(code => <option key={code}>{code}</option>)}</Select><Button variant="secondary" icon={Download} disabled={!receipts.length || busy} onClick={() => exportCsv(`hich-income-${report?.start}-${report?.end}-${currency}.csv`, receipts.map(item => ({ Date: item.paid_at, Client: item.client_name, Invoice: item.reference, Project: item.project_title, Amount: item.amount, Currency: item.currency, Method: item.method, 'Payment reference': item.payment_reference, 'Invoice status': item.invoice_status })))}>Export receipts</Button></section>
    {busy ? <LoadingState label="Calculating income and receivables…" /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : report && <>
      <p className="field-hint">Receipts: {formatDate(report.start)} – {formatDate(report.end)}. Current balances as of {formatDate(report.as_of)} (Asia/Colombo).</p>
      <section className="income-metrics">{[['Collected in period', totals?.collected], ['Invoiced in period', totals?.invoiced], ['Current outstanding', totals?.outstanding], ['Overdue balance', totals?.overdue], ['Lifetime receipts', totals?.lifetime_collected], ['Draft project value', totals?.draft_value]].map(([label, value]) => <article className="panel" key={String(label)}><small>{label}</small><strong>{money(Number(value || 0))}</strong></article>)}</section>
      <p className="field-hint">{totals?.receipts || 0} receipts in this period · {totals?.invoices || 0} current issued invoices · Retained receipts on void invoices in period: {money(totals?.collected_on_void)} · Overpayments: {money(totals?.overpayments)}</p>
      <div className="income-breakdowns"><section className="panel account-panel"><h2>Receivable aging</h2><dl className="document-summary">{Object.entries(totals?.aging || {}).map(([bucket, amount]) => <div key={bucket}><dt>{agingLabels[bucket] || bucket}</dt><dd>{money(amount)}</dd></div>)}</dl></section><section className="panel account-panel"><h2>Collections by month</h2>{report.monthly.filter(item => item.currency === currency).map(item => <div className="income-line" key={item.month}><span>{item.month}</span><strong>{money(item.collected)}</strong></div>)}{!receipts.length && <p>No receipts for this currency and period.</p>}<h3>By payment method</h3>{report.methods.filter(item => item.currency === currency).map(item => <div className="income-line" key={item.method}><span>{item.method}</span><strong>{money(item.collected)}</strong></div>)}</section><section className="panel account-panel"><h2>Client collections</h2>{report.clients.filter(item => item.currency === currency).map(item => <div className="income-line" key={item.client_id}><Link className="text-link" to={`/admin/clients?client=${item.client_id}`}>{item.name}</Link><span>{item.receipts} receipts · {money(item.collected)}</span></div>)}</section></div>
      {!!report.undated_receipts?.length && <section className="panel account-panel"><h2>Imported receipts needing a payment date</h2><p>These payments are included in lifetime receipts and invoice balances. Confirm their dates through Add payment ? Edit receipt to include them in period and monthly totals.</p>{report.undated_receipts.filter(item => item.currency === currency).map((item, index) => <div className="income-line" key={index}><Link className="text-link" to={`/admin/invoices?invoice=${item.invoice_id}`}>{item.client_name} ? {item.reference}</Link><strong>{money(item.amount)}</strong></div>)}</section>}
      <SearchInput label="Search income records" value={query} onChange={setQuery} placeholder="Search client, invoice, project or payment reference…" />
      <section className="panel"><header className="panel__header"><h2>Payment ledger</h2><span>{receipts.length} receipts</span></header>{receipts.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Received</th><th>Client / project</th><th>Invoice</th><th>Amount</th><th>Method / reference</th><th>Invoice status</th></tr></thead><tbody>{receipts.map((item, index) => <tr key={item.id || index}><td>{formatDate(item.paid_at)}</td><td>{item.client_name}<br /><small>{item.project_title}</small></td><td><Link className="text-link" to={`/admin/invoices?invoice=${item.invoice_id}`}>{item.reference}</Link></td><td>{money(item.amount)}</td><td>{item.method}<br /><small>{item.payment_reference || '—'}</small></td><td>{item.invoice_status}</td></tr>)}</tbody></table></div> : <EmptyState title="No matching receipts" description="Record cleared payments on an invoice to include them here." />}</section>
      <section className="panel"><header className="panel__header"><h2>Current outstanding invoices</h2><Button variant="ghost" icon={Download} disabled={!receivables.length} onClick={() => exportCsv(`hich-receivables-${currency}.csv`, receivables.map(item => ({ Invoice: item.reference, Client: item.client_name, Total: item.total, Paid: item.paid, Balance: item.balance, Currency: item.currency, Due: item.due_date, 'Days overdue': item.days_overdue })))}>Export balances</Button></header><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Client / invoice</th><th>Total</th><th>Paid</th><th>Balance</th><th>Due</th><th>Days overdue</th></tr></thead><tbody>{receivables.map(item => <tr key={item.invoice_id}><td><Link className="text-link" to={`/admin/invoices?invoice=${item.invoice_id}`}>{item.client_name} · {item.reference}</Link></td><td>{money(item.total)}</td><td>{money(item.paid)}</td><td>{money(item.balance)}</td><td>{formatDate(item.due_date)}</td><td>{item.days_overdue}</td></tr>)}</tbody></table></div></section><p className="field-hint">{report.note}</p>
    </>}
  </div>
}
