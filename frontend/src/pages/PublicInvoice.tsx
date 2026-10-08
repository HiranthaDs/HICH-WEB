import { ArrowLeft, CheckCircle2, FileText, LockKeyhole, Printer } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Brand } from '../components/Brand'
import { Button, ErrorState, LoadingState, StatusPill } from '../components/ui'
import { api } from '../lib/api'
import { formatCurrency, formatDate } from '../lib/format'
import type { Invoice } from '../lib/types'

export function PublicInvoice() {
  const { token = '' } = useParams()
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setInvoice(await api.publicInvoice(token)) }
    catch (e) { setError(e instanceof Error ? e.message : 'This invoice is unavailable.') }
    finally { setLoading(false) }
  }, [token])
  useEffect(() => { void load() }, [load])
  const money = (value: number) => formatCurrency(value, invoice?.currency || 'LKR')
  return <div className="sign-page public-invoice"><header className="sign-header"><Brand /><span><LockKeyhole size={14} />Private invoice</span></header>
    {loading ? <LoadingState label="Opening your invoice…" /> : error || !invoice ? <div className="public-container"><ErrorState title="Invoice unavailable" message={error} onRetry={load} /></div> : <main className="document-layout">
      <article className="agreement-document"><header className="agreement-document__header"><div><span className="document-icon"><FileText size={24} /></span><p className="eyebrow">{invoice.reference}</p><h1>{invoice.project_title || 'Project invoice'}</h1></div><StatusPill status={invoice.status} /></header>
        <dl className="document-summary"><div><dt>Billed to</dt><dd>{invoice.client_name}</dd></div><div><dt>Phone</dt><dd>{invoice.phone || '—'}</dd></div><div><dt>Issued</dt><dd>{formatDate(invoice.issue_date)}</dd></div><div><dt>Due date</dt><dd>{formatDate(invoice.due_date)}</dd></div></dl>
        <section className="agreement-section"><h2>Payment schedule</h2><div className="table-scroll"><table className="document-table"><thead><tr><th>Milestone / description</th><th>Status</th><th>Amount</th></tr></thead><tbody>{invoice.payments?.length ? invoice.payments.map((payment, i) => <tr key={payment.id || i}><td>{payment.name}</td><td>{payment.is_paid || payment.isPaid ? 'Paid' : 'Pending'}</td><td>{money(Number(payment.amount))}</td></tr>) : <tr><td>{invoice.project_title || 'Development services'}</td><td>{invoice.status}</td><td>{money(Number(invoice.amount))}</td></tr>}</tbody></table></div></section>
        <div className="invoice-totals"><div><span>Total project amount</span><strong>{money(Number(invoice.amount))}</strong></div><div><span>Payments received</span><strong>{money(Number(invoice.paid_amount || 0))}</strong></div><div><span>Balance due</span><strong>{money(Number(invoice.balance_due ?? Math.max(0, Number(invoice.amount) - Number(invoice.paid_amount || 0))))}</strong></div></div>
        {invoice.customer_note && <section className="agreement-section"><h2>A note from Hich Web</h2><p>{invoice.customer_note}</p></section>}
        {invoice.renewal_amount ? <section className="agreement-section"><h2>Annual care / renewal</h2><p>Renewal amount: <strong>{formatCurrency(invoice.renewal_amount, invoice.renewal_currency || invoice.currency || 'LKR')}</strong></p><p>Service expiry / renewal due: <strong>{formatDate(invoice.renewal_due_date)}</strong></p><p>Renewal is billed separately from the project development total.</p></section> : null}
        <footer className="document-version">Revision {invoice.revision || 1} · Updated {formatDate(invoice.updated_at || invoice.created_at)}<br />This link reflects the latest saved invoice.</footer>
      </article>
      <aside className="document-sidebar"><section className="share-panel"><p className="eyebrow">Payment details</p><h2>{invoice.status === 'paid' ? 'All settled. Thank you.' : 'Your next step.'}</h2>{invoice.status === 'paid' && <CheckCircle2 size={36} />}<p>{invoice.payment_method || 'Contact Hich Web to arrange payment.'}</p>{invoice.payment_instructions ? <p className="preserve-lines">{invoice.payment_instructions}</p> : <p>Please ask your Hich Web contact for payment instructions.</p>}<p>Include <strong>{invoice.reference}</strong> with your payment.</p><Button icon={Printer} onClick={() => window.print()}>Print / Save PDF</Button><Button variant="secondary" onClick={() => void load()}>Refresh invoice</Button></section><Link className="text-link" to="/"><ArrowLeft size={15} />Explore Hich Web</Link></aside>
    </main>}
    <footer className="sign-footer"><span>Hich Web · Websites & systems</span><span>Invoices made clear.</span></footer>
  </div>
}
