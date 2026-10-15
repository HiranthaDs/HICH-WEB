import { ArrowLeft, CheckCircle2, Download, FileText, LockKeyhole, Printer, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Brand } from '../components/Brand'
import { Button, ErrorState, LoadingState, StatusPill } from '../components/ui'
import { api } from '../lib/api'
import { formatCurrency, formatDate } from '../lib/format'
import { withDefaultPaymentInstructions } from '../lib/paymentInstructions'
import type { Invoice } from '../lib/types'

const serviceNames: Record<string, string> = { domain: 'Domain', hosting: 'Hosting', domain_hosting: 'Domain & hosting' }
const serviceName = (value: string) => serviceNames[value] || value

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

  const money = (value: number, currency = invoice?.currency || 'LKR') => {
    try {
      return new Intl.NumberFormat('en-LK', {
        style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(value)
    } catch { return formatCurrency(value, currency) }
  }
  const total = Number(invoice?.amount || 0)
  const paid = Number(invoice?.paid_amount || 0)
  const balance = Number(invoice?.balance_due ?? Math.max(0, total - paid))
  const isPaid = balance <= 0 || invoice?.status === 'paid'
  const isRenewal = invoice?.invoice_kind === 'renewal'
  const paymentInstructions = withDefaultPaymentInstructions(invoice?.payment_instructions)

  return <div className="sign-page public-invoice">
    <header className="sign-header invoice-screen-header"><Brand /><span><LockKeyhole size={14} />Secure invoice</span></header>
    {loading ? <LoadingState label="Opening your invoice…" /> : error || !invoice ? <div className="public-container"><ErrorState title="Invoice unavailable" message={error} onRetry={load} /></div> : <main className="document-layout invoice-layout">
      <article className="agreement-document invoice-paper">
        <header className="invoice-masthead">
          <div className="invoice-masthead__brand"><Brand /><small>Websites & systems</small></div>
          <div className="invoice-masthead__title"><span className="document-icon"><FileText size={22} /></span><div><p className="eyebrow">{isRenewal ? 'Renewal invoice' : 'Invoice'}</p><h1>{invoice.reference || 'Invoice'}</h1></div></div>
        </header>

        <section className="invoice-balance-hero">
          <div><span>{isPaid ? 'Invoice total' : 'Balance due'}</span><strong>{money(isPaid ? total : balance)}</strong>{!isPaid && invoice.due_date && <small>Payment due {formatDate(invoice.due_date)}</small>}</div>
          <StatusPill status={invoice.status} />
        </section>

        <dl className="invoice-meta">
          <div><dt>Billed to</dt><dd>{invoice.client_name || 'Client'}</dd>{invoice.phone && <small>{invoice.phone}</small>}</div>
          <div><dt>For</dt><dd>{invoice.project_title || (isRenewal ? 'Service renewal' : 'Development services')}</dd></div>
          <div><dt>Issue date</dt><dd>{formatDate(invoice.issue_date)}</dd></div>
          <div><dt>Due date</dt><dd>{isPaid ? 'Paid' : formatDate(invoice.due_date)}</dd></div>
        </dl>

        {isRenewal && invoice.renewal_period_date && <p className="invoice-service-period"><span>Service period / expiry</span><strong>{formatDate(invoice.renewal_period_date)}</strong></p>}

        <section className="invoice-lines" aria-labelledby="invoice-items-title">
          <h2 id="invoice-items-title">Invoice details</h2>
          <div className="table-scroll"><table className="document-table"><thead><tr><th>Description</th><th>Status</th><th>Amount</th></tr></thead><tbody>
            {isRenewal ? <>
              {invoice.renewal_items?.map((item, index) => <tr key={index}><td><strong>{item.description}</strong><small>{serviceName(item.service)}</small></td><td>{isPaid ? 'Paid' : 'Due'}</td><td>{money(Number(item.amount))}</td></tr>)}
              {Number(invoice.renewal_late_fee) > 0 && <tr><td><strong>Late fee</strong><small>Agreed one-time surcharge (18%)</small></td><td>{isPaid ? 'Paid' : 'Due'}</td><td>{money(Number(invoice.renewal_late_fee))}</td></tr>}
            </> : invoice.payments?.length ? invoice.payments.map((payment, index) => {
              const paymentReceived = payment.is_paid || payment.isPaid
              const partlyPaid = !paymentReceived && Number(payment.paid_amount) > 0
              return <tr key={String(payment.id || index)}><td><strong>{payment.name}</strong>{payment.paid_at && <small>Received {formatDate(payment.paid_at)}</small>}</td><td>{paymentReceived ? 'Paid' : partlyPaid ? 'Part paid' : 'Due'}</td><td>{money(Number(payment.amount))}</td></tr>
            }) : <tr><td><strong>{invoice.project_title || 'Development services'}</strong></td><td>{isPaid ? 'Paid' : 'Due'}</td><td>{money(total)}</td></tr>}
          </tbody></table></div>
        </section>

        <div className="invoice-totals">
          <div><span>Subtotal</span><strong>{money(total)}</strong></div>
          <div><span>Payments received</span><strong>− {money(paid)}</strong></div>
          <div><span>Balance due</span><strong>{money(balance)}</strong></div>
        </div>

        <div className="invoice-notes-grid">
          {!isPaid && <section><h2>Payment details</h2><p className="preserve-lines">{paymentInstructions}</p><p>Please include <strong>{invoice.reference || 'the invoice reference'}</strong> with your payment.</p></section>}
          {invoice.customer_note && <section><h2>Note</h2><p>{invoice.customer_note}</p></section>}
        </div>

        {!!invoice.payment_records?.length && <section className="invoice-receipts"><h2>Payment receipts</h2><div className="table-scroll"><table className="document-table"><thead><tr><th>Received</th><th>Method</th><th>Amount</th></tr></thead><tbody>{invoice.payment_records.map((receipt, index) => <tr key={receipt.id || index}><td>{receipt.date_confirmed === false ? 'Date not recorded' : formatDate(receipt.paid_at)}<small>{receipt.receipt_number || 'Recorded payment'}</small></td><td>{receipt.method || 'Payment'}</td><td>{money(Number(receipt.amount), receipt.currency || invoice.currency || 'LKR')}</td></tr>)}</tbody></table></div></section>}

        {invoice.renewal_amount && !isRenewal ? <section className="invoice-renewal-note"><span>Annual care / renewal</span><strong>{money(invoice.renewal_amount, invoice.renewal_currency || invoice.currency || 'LKR')}</strong><small>Service expiry / renewal due {formatDate(invoice.renewal_due_date)} · billed separately</small></section> : null}

        <footer className="invoice-footer"><div><strong>Thank you for your business.</strong><span>Hich Web · Websites & systems</span></div><small>Revision {invoice.revision || 1} · Updated {formatDate(invoice.updated_at || invoice.created_at || invoice.issue_date)}<br />This secure link always shows the latest saved invoice.</small></footer>
      </article>

      <aside className="document-sidebar invoice-actions">
        <section className={`share-panel ${isPaid ? 'invoice-actions--paid' : ''}`}>
          {isPaid ? <CheckCircle2 size={36} /> : <p className="eyebrow">Payment</p>}
          <h2>{isPaid ? 'Paid in full' : `${money(balance)} due`}</h2>
          <p>{isPaid ? 'Your cleared payment has been recorded. Keep this invoice for your records.' : invoice.payment_method || 'Please use the payment instructions shown on the invoice.'}</p>
          <a className="button button--primary button--md" href={api.publicInvoicePdfUrl(token)} target="_blank" rel="noopener noreferrer"><Download size={18} aria-hidden="true" /><span>Download PDF</span></a>
          <a className="button button--secondary button--md" href={api.publicInvoicePdfUrl(token, true)} target="_blank" rel="noopener noreferrer"><Printer size={18} aria-hidden="true" /><span>Print / Save PDF</span></a>
          <small className="invoice-pdf-hint">Opens the same A4 invoice for printing or saving on your device.</small>
          <Button variant="secondary" icon={RefreshCw} onClick={() => void load()}>Refresh</Button>
        </section>
        <Link className="text-link" to="/"><ArrowLeft size={15} />Visit Hich Web</Link>
      </aside>
    </main>}
    <footer className="sign-footer invoice-screen-footer"><span>Hich Web · Websites & systems</span><span>Private client document</span></footer>
  </div>
}
