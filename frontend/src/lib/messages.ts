import { formatCurrency, formatDate, getClientName } from './format'
import { withDefaultPaymentInstructions } from './paymentInstructions'
import type { Agreement, Invoice, PaymentRecord } from './types'

export type ClientMessage = { subject: string; body: string }
const greeting = (name?: string) => `Hello ${name || 'there'},`
const closing = 'Thank you for choosing Hich Web.\nHich Web | Client Services'
const money = (amount: unknown, currency?: string) => formatCurrency(Number(amount || 0), currency || 'LKR')
const bullet = (label: string, value: string) => `• ${label}: ${value}`

export function receiptMessage(invoice: Invoice, receipt: PaymentRecord): ClientMessage {
  const balance = Math.max(0, Number(invoice.amount) - Number(invoice.paid_amount || 0))
  return {
    subject: `Payment receipt ${receipt.receipt_number || invoice.reference} | Hich Web`,
    body: [greeting(getClientName(invoice.client, invoice.client_name)),
      `Thank you. We have recorded your payment for ${invoice.project_title || 'your invoice'}.`,
      `PAYMENT RECEIPT\nReceipt: ${receipt.receipt_number || receipt.reference || 'Recorded payment'}\nInvoice: ${invoice.reference}\nAmount received: ${money(receipt.amount, receipt.currency)}\nReceived: ${receipt.date_confirmed === false ? 'Date not recorded' : formatDate(receipt.paid_at)}\nMethod: ${receipt.method || 'Payment'}${receipt.reference ? `\nTransfer reference: ${receipt.reference}` : ''}\nRemaining balance: ${money(balance, invoice.currency)}`,
      balance === 0 ? 'This invoice is paid in full. Please retain this receipt for your records.' : '',
      invoice.share_url ? `OPEN SECURE INVOICE\n${invoice.share_url}` : '',
      invoice.invoice_kind === 'renewal' ? 'Renewal completion is confirmed separately after provider processing.' : '', closing,
    ].filter(Boolean).join('\n\n'),
  }
}

export function invoiceMessage(invoice: Invoice): ClientMessage {
  const paid = Number(invoice.paid_amount || 0), total = Number(invoice.amount || 0)
  const balance = Math.max(0, total - paid)
  const paymentInstructions = withDefaultPaymentInstructions(invoice.payment_instructions)
  if (invoice.invoice_kind === 'renewal') {
    const services = (invoice.renewal_items || []).map(item => bullet(item.description, money(item.amount, invoice.currency))).join('\n')
    const lateFee = Number(invoice.renewal_late_fee || 0)
    const receipts = (invoice.payment_records || []).map(receipt => bullet(
      receipt.date_confirmed === false ? 'Date not recorded' : formatDate(receipt.paid_at),
      `${money(receipt.amount, invoice.currency)}${receipt.method ? ` — ${receipt.method}` : ''}`,
    )).join('\n')
    return { subject: `Renewal invoice ${invoice.reference || ''} · ${money(balance > 0 ? balance : total, invoice.currency)} · ${balance > 0 ? 'Payment due' : 'Paid'}`.replace(/\s+/g, ' ').trim(), body: [
      greeting(getClientName(invoice.client, invoice.client_name)),
      balance > 0
        ? 'Your domain and hosting renewal invoice is ready.'
        : 'Thank you—your domain and hosting renewal invoice is now paid in full.',
      `RENEWAL INVOICE\nReference: ${invoice.reference || 'Renewal invoice'}\nService: ${invoice.project_title || 'Domain & hosting renewal'}${invoice.renewal_period_date ? `\nService period / expiry: ${formatDate(invoice.renewal_period_date)}` : ''}${invoice.issue_date ? `\nIssued: ${formatDate(invoice.issue_date)}` : ''}${balance > 0 && invoice.due_date ? `\nDue: ${formatDate(invoice.due_date)}` : ''}\nInvoice total: ${money(total, invoice.currency)}\nPaid: ${money(paid, invoice.currency)}\nBalance due: ${money(balance, invoice.currency)}`,
      services || lateFee > 0 ? `SERVICE CHARGES\n${[services, lateFee > 0 ? bullet('Agreed late-payment surcharge (18%, once) — itemized late fee', money(lateFee, invoice.currency)) : ''].filter(Boolean).join('\n')}` : '',
      receipts ? `PAYMENTS RECEIVED\n${receipts}` : '',
      balance > 0 ? `PAYMENT DETAILS\n${paymentInstructions}` : '',
      invoice.share_url ? `OPEN SECURE INVOICE\n${invoice.share_url}` : '',
      balance > 0
        ? `Please include reference ${invoice.reference || 'shown above'} with payment and reply with the receipt so we can confirm cleared funds.`
        : 'No balance remains. Service completion is confirmed separately after the registrar or hosting provider finishes processing.',
      invoice.customer_note ? `NOTE\n${invoice.customer_note}` : '',
      closing,
    ].filter(Boolean).join('\n\n') }
  }
  const phases = (invoice.payments || []).map(p => bullet(
    p.name,
    `${money(p.amount, invoice.currency)} — ${p.is_paid ?? p.isPaid ? 'Received' : Number(p.paid_amount) > 0 ? `Part received (${money(p.paid_amount, invoice.currency)})` : 'Pending'}${p.paid_at ? ` (${formatDate(p.paid_at)})` : ''}`,
  )).join('\n')
  return { subject: `Invoice ${invoice.reference || ''} · ${money(balance > 0 ? balance : total, invoice.currency)} · ${balance > 0 ? 'Payment due' : 'Paid'}`.replace(/\s+/g, ' ').trim(), body: [
    greeting(getClientName(invoice.client, invoice.client_name)),
    balance > 0
      ? `Your invoice for ${invoice.project_title || 'your project'} is ready.`
      : `Thank you—your invoice for ${invoice.project_title || 'your project'} is now paid in full.`,
    `INVOICE SUMMARY\nReference: ${invoice.reference || 'Project invoice'}\nProject: ${invoice.project_title || 'Your project'}${invoice.issue_date ? `\nIssued: ${formatDate(invoice.issue_date)}` : ''}${balance > 0 && invoice.due_date ? `\nDue: ${formatDate(invoice.due_date)}` : ''}\nInvoice total: ${money(total, invoice.currency)}\nPaid: ${money(paid, invoice.currency)}\nBalance due: ${money(balance, invoice.currency)}`,
    phases ? `PAYMENT BREAKDOWN\n${phases}` : '',
    balance > 0 ? `PAYMENT DETAILS\n${paymentInstructions}` : '',
    invoice.share_url ? `OPEN SECURE INVOICE\n${invoice.share_url}` : '',
    balance > 0
      ? `Please include reference ${invoice.reference || 'shown above'} with payment and reply with the receipt. If you have already paid, send the payment details and we will update the invoice.`
      : 'No balance remains. You can open the secure invoice and save a PDF copy for your records.',
    invoice.customer_note ? `NOTE\n${invoice.customer_note}` : '',
    closing,
  ].filter(Boolean).join('\n\n') }
}

export type RenewalDetails = { client_name?: string; reference?: string; amount?: number; currency?: string; due_date?: string; project_title?: string; share_url?: string; payment_instructions?: string }
export function renewalMessage(renewal: RenewalDetails, lateChargeAccepted = false): ClientMessage {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })
  const expired = Boolean(renewal.due_date && renewal.due_date.slice(0, 10) < today)
  const base = Number(renewal.amount || 0)
  const late = expired && lateChargeAccepted ? Math.round(base * 18) / 100 : 0
  const chargeText = lateChargeAccepted
    ? expired
      ? `Agreed late-payment surcharge (18%, once) — itemized late fee: ${money(late, renewal.currency)}\nTotal renewal payment: ${money(base + late, renewal.currency)}`
      : `No late fee is due today. Under the accepted renewal terms, an 18% late-payment surcharge (${money(Math.round(base * 18) / 100, renewal.currency)}) applies once to the unpaid renewal amount only if payment is received after the due date.`
    : 'No late fee has been added to this reminder. If the accepted renewal terms include an 18% late-payment surcharge, we will confirm any applicable itemized late fee before collection.'
  const paymentInstructions = withDefaultPaymentInstructions(renewal.payment_instructions)
  return { subject: `Hich Web | ${renewal.reference ? `${renewal.reference} | ` : ''}${expired ? 'Action required: service renewal overdue' : 'Upcoming domain & hosting renewal'}`, body: [
    greeting(renewal.client_name),
    expired
      ? 'Our records show that your domain / hosting renewal payment is overdue. Please contact us promptly so we can confirm service availability and the available renewal options.'
      : 'Your domain / hosting renewal is approaching. Please arrange payment by the date below so we can process it and help keep your services active.',
    `RENEWAL DETAILS${renewal.reference ? `\nReference: ${renewal.reference}` : ''}${renewal.project_title ? `\nProject: ${renewal.project_title}` : ''}\nRenewal amount: ${money(base, renewal.currency)}\nDue / service expiry date: ${formatDate(renewal.due_date)}`,
    `LATE-PAYMENT TERMS\n${chargeText}\nAny legally applicable VAT is shown separately on the invoice; a late-payment surcharge is not VAT.`,
    `PAYMENT DETAILS\n${paymentInstructions}`,
    renewal.share_url ? `VIEW DETAILS\n${renewal.share_url}` : '',
    `Next step: Please include ${renewal.reference ? `reference ${renewal.reference}` : 'your project or invoice reference'} with the payment, then reply with the transfer receipt. Renewal is confirmed after cleared payment and provider confirmation.`,
    expired ? 'After expiry, provider suspension, redemption fees or domain loss may apply. We will quote any recovery cost for approval before proceeding.' : '',
    'If you have already renewed or would like to discuss the amount, please reply and we will check your record.',
    closing,
  ].filter(Boolean).join('\n\n') }
}

export function agreementMessage(agreement: Agreement): ClientMessage {
  const showCommercial = agreement.commercial_details_visible !== false
  const schedule = showCommercial
    ? (agreement.payment_schedule || []).map(phase => bullet(
        phase.name,
        `${money(phase.amount, agreement.currency)} — ${phase.is_paid ? 'Recorded as received' : 'Pending'}`,
      )).join('\n')
    : ''
  const commercialLines = [
    Number(agreement.amount) > 0 ? `Project total: ${money(agreement.amount, agreement.currency)}` : '',
    Number(agreement.visiting_fee_lkr) > 0 ? `Visiting fee: ${money(agreement.visiting_fee_lkr, 'LKR')}${Number(agreement.amount) > 0 ? ' (part of the project total and credited once to the final balance after collection)' : ' (the agreed visit charge; any credit against a later project price must be stated in that quotation or invoice)'}` : '',
    Number(agreement.renewal_amount) > 0 ? `Annual renewal: ${money(agreement.renewal_amount, agreement.renewal_currency || agreement.currency)}` : '',
    agreement.renewal_due_date ? `Renewal / service expiry date: ${formatDate(agreement.renewal_due_date)}` : '',
  ].filter(Boolean)
  const commercialSummary = showCommercial
    ? commercialLines.length || schedule
      ? `COMMERCIAL DETAILS\n${commercialLines.join('\n')}${schedule ? `${commercialLines.length ? '\n\n' : ''}PAYMENT MILESTONES\n${schedule}` : ''}`
      : 'COMMERCIAL DETAILS\nNo project price, visiting fee, payment milestone or renewal charge is stated in this agreement. Any charge must be provided and accepted separately in writing.'
    : 'This scope-only agreement intentionally excludes project prices, payment milestones, visiting fees and renewal figures. Those commercial details will be provided separately if applicable.'
  return { subject: `Hich Web | Agreement ready for review | ${agreement.project_title || agreement.title}`, body: [
    greeting(getClientName(agreement.client, agreement.client_name)),
    `Your agreement for ${agreement.project_title || 'your project'} is ready for your review and signature.`,
    `AGREEMENT SUMMARY\nReference: ${agreement.reference || agreement.title}\nProject: ${agreement.project_title || agreement.title}`,
    commercialSummary,
    showCommercial
      ? 'Please review the complete scope and terms, together with any commercial details listed above. Blank optional details are not included as agreed charges. If anything needs correction, reply before signing and we will update it.'
      : 'Please review the complete scope and general terms. If anything needs correction, reply before signing and we will update it.',
    agreement.share_url ? `REVIEW & SIGN SECURELY\n${agreement.share_url}` : '',
    'Next step: Open the private link, confirm the details and sign as the authorised signatory. Please do not forward the link. You can retain a copy after signing.',
    closing,
  ].filter(Boolean).join('\n\n') }
}

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
export function professionalEmail(subject: string, body: string): string {
  const sections = body.split(/\n\n+/).map(block => {
    const lines = block.split('\n')
    const isHeading = /^[A-Z0-9 &/—-]{4,}$/.test(lines[0])
    const title = isHeading ? lines.shift() || '' : ''
    const isSummary = /(?:INVOICE|RENEWAL) (?:SUMMARY|DETAILS)/.test(title)
    const isAction = /^(?:OPEN|VIEW)/.test(title) && lines.some(line => /^https:\/\//.test(line))
    if (isAction) {
      const url = lines.find(line => /^https:\/\//.test(line)) || ''
      return `<div style="margin:4px 0 18px"><a href="${escape(url)}" style="display:inline-block;background:#5263ff;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:12px 18px;border-radius:9px">${escape(title.replace('OPEN', 'View').replace('VIEW', 'View').toLowerCase().replace(/^./, c => c.toUpperCase()))}</a></div>`
    }
    if (isSummary) {
      const rows = lines.map(line => {
        const separator = line.indexOf(':')
        const label = separator > -1 ? line.slice(0, separator) : ''
        const value = separator > -1 ? line.slice(separator + 1).trim() : line
        const highlight = /balance due|invoice total|remaining balance/i.test(label)
        return `<tr><td style="padding:5px 10px 5px 0;color:#738098;font-size:12px">${escape(label)}</td><td style="padding:5px 0;text-align:right;font-size:12px;font-weight:${highlight ? '700' : '600'};color:${highlight ? '#1e2fc5' : '#243149'}">${escape(value)}</td></tr>`
      }).join('')
      return `<div style="margin:0 0 16px;background:#f6f7fb;border:1px solid #e4e8f1;border-radius:11px;padding:15px 17px"><h2 style="font-size:10px;letter-spacing:1.2px;color:#5263ff;margin:0 0 7px">${escape(title)}</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table></div>`
    }
    const content = lines.map(line => /^https:\/\//.test(line)
      ? `<a href="${escape(line)}" style="color:#2535dc;word-break:break-all">${escape(line)}</a>`
      : escape(line)).join('<br>')
    return `<div style="margin:0 0 16px;${isHeading ? 'border-left:3px solid #d8ddff;padding:2px 0 2px 14px;' : ''}">${isHeading ? `<h2 style="font-size:10px;letter-spacing:1.1px;color:#5263ff;margin:0 0 7px">${escape(title)}</h2>` : ''}${content}</div>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head><body style="margin:0;background:#f2f4f8;font-family:Arial,sans-serif;color:#243149"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:20px 10px"><table role="presentation" width="100%" style="max-width:600px;margin:auto;background:#fff;border:1px solid #e4e8f1;border-radius:14px;overflow:hidden" cellspacing="0" cellpadding="0"><tr><td style="background:#192a46;color:#fff;padding:20px 24px"><strong style="font-size:20px;letter-spacing:1.6px">HICH WEB</strong><span style="float:right;font-size:10px;color:#c8d5e8;padding-top:5px">WEBSITES &amp; SYSTEMS</span></td></tr><tr><td style="padding:24px;font-size:13px;line-height:1.6"><h1 style="font-size:18px;line-height:1.35;margin:0 0 20px;color:#17243a">${escape(subject)}</h1>${sections}</td></tr><tr><td style="padding:16px 24px;border-top:1px solid #edf0f6;font-size:10px;line-height:1.6;color:#758198">Hich Web · Clear scope. Recorded payments. Reliable service.<br>Keep private document links secure.</td></tr></table></td></tr></table></body></html>`
}

export function downloadEmailDraft(to: string, subject: string, body: string) {
  const encode = (text: string) => btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join(''))
  const wrap = (text: string) => encode(text).match(/.{1,76}/g)?.join('\r\n') || ''
  const boundary = `hich-${crypto.randomUUID()}`
  const recipient = to.replace(/[\r\n]/g, '')
  const eml = [`X-Unsent: 1`, `To: ${recipient}`, `Subject: =?UTF-8?B?${encode(subject)}?=`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(body), `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(professionalEmail(subject, body)), `--${boundary}--`, ''].join('\r\n')
  const url = URL.createObjectURL(new Blob([eml], { type: 'message/rfc822' }))
  const link = document.createElement('a'); link.href = url; link.download = 'hich-client-email.eml'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
