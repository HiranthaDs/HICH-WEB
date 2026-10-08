import { formatCurrency, formatDate, getClientName } from './format'
import type { Agreement, Invoice } from './types'

export type ClientMessage = { subject: string; body: string }
const greeting = (name?: string) => `Hello ${name || 'there'},`
const closing = 'Thank you for choosing Hich Web.\nHich Web | Client Services'
const money = (amount: unknown, currency?: string) => formatCurrency(Number(amount || 0), currency || 'LKR')

export function invoiceMessage(invoice: Invoice): ClientMessage {
  const paid = Number(invoice.paid_amount || 0), total = Number(invoice.amount || 0)
  const balance = Math.max(0, total - paid)
  if (invoice.invoice_kind === 'renewal') {
    const services = (invoice.renewal_items || []).map(item => `• ${item.description}: ${money(item.amount, invoice.currency)}`).join('\n')
    const receipts = (invoice.payment_records || []).map(receipt => `• ${formatDate(receipt.paid_at)}: ${money(receipt.amount, invoice.currency)}${receipt.method ? ` — ${receipt.method}` : ''}`).join('\n')
    return { subject: `Hich Web | ${invoice.reference || 'Renewal invoice'} | ${balance > 0 ? 'Domain & hosting renewal invoice' : 'Paid renewal invoice'}`, body: [
      greeting(getClientName(invoice.client, invoice.client_name)),
      balance > 0 ? 'Your domain / hosting renewal invoice is ready.' : 'Thank you. We have received your renewal payment. Your paid domain / hosting renewal invoice is available below for your records.',
      `RENEWAL INVOICE\nReference: ${invoice.reference || 'Renewal invoice'}\nServices: ${invoice.project_title || 'Domain & hosting renewal'}${invoice.renewal_period_date ? `\nRenewal cycle / service expiry: ${formatDate(invoice.renewal_period_date)}` : ''}\nInvoice total: ${money(total, invoice.currency)}\nPayments received: ${money(paid, invoice.currency)}\nBalance due: ${money(balance, invoice.currency)}${balance > 0 && invoice.due_date ? `\nPayment due: ${formatDate(invoice.due_date)}` : ''}`,
      services ? `SERVICE CHARGES\n${services}${Number(invoice.renewal_late_fee) > 0 ? `\n• Agreed late-payment surcharge (18%, once): ${money(invoice.renewal_late_fee, invoice.currency)}` : ''}` : '',
      receipts ? `PAYMENT RECEIVED\n${receipts}` : '',
      balance > 0 && invoice.payment_instructions ? `PAYMENT DETAILS\n${invoice.payment_instructions}` : '',
      invoice.share_url ? `VIEW ${balance > 0 ? 'RENEWAL' : 'PAID RENEWAL'} INVOICE\n${invoice.share_url}` : '',
      balance > 0 ? 'Please use the renewal invoice reference when paying and send us your transfer receipt.' : 'This invoice confirms cleared payment. Service renewal is confirmed separately after the registrar or hosting provider completes it.',
      invoice.customer_note || '', closing,
    ].filter(Boolean).join('\n\n') }
  }
  const phases = (invoice.payments || []).map(p => `• ${p.name}: ${money(p.amount, invoice.currency)} — ${p.is_paid ?? p.isPaid ? 'Received' : Number(p.paid_amount) > 0 ? `Part received (${money(p.paid_amount, invoice.currency)})` : 'Pending'}${p.paid_at ? ` (${formatDate(p.paid_at)})` : ''}`).join('\n')
  return { subject: `Hich Web | ${invoice.reference || 'Invoice'} | ${balance > 0 ? 'Payment update' : 'Payment complete'}`, body: [
    greeting(getClientName(invoice.client, invoice.client_name)),
    `Your invoice for ${invoice.project_title || 'your project'} has been updated.`,
    `INVOICE SUMMARY\nReference: ${invoice.reference || 'Project invoice'}\nProject total: ${money(total, invoice.currency)}\nPayments received: ${money(paid, invoice.currency)}\nRemaining balance: ${money(balance, invoice.currency)}${invoice.due_date ? `\nPayment due: ${formatDate(invoice.due_date)}` : ''}`,
    phases ? `PAYMENT BREAKDOWN\n${phases}` : '',
    invoice.payment_instructions ? `PAYMENT DETAILS\n${invoice.payment_instructions}` : '',
    invoice.share_url ? `VIEW YOUR LATEST INVOICE\n${invoice.share_url}` : '',
    balance > 0 ? 'Please use your invoice reference when making payment and send us the transfer receipt so we can confirm cleared funds. If you have already paid, please reply with the payment details.' : 'Your project invoice is fully paid. Thank you; we have recorded your payment.',
    invoice.customer_note || '', closing,
  ].filter(Boolean).join('\n\n') }
}

export type RenewalDetails = { client_name?: string; amount?: number; currency?: string; due_date?: string; project_title?: string; share_url?: string; payment_instructions?: string }
export function renewalMessage(renewal: RenewalDetails, lateChargeAccepted = false): ClientMessage {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })
  const expired = Boolean(renewal.due_date && renewal.due_date.slice(0, 10) < today)
  const base = Number(renewal.amount || 0)
  const late = expired && lateChargeAccepted ? Math.round(base * 18) / 100 : 0
  const chargeText = lateChargeAccepted
    ? expired ? `Agreed late-payment surcharge (18%, once): ${money(late, renewal.currency)}\nTotal renewal payment: ${money(base + late, renewal.currency)}` : `Under the accepted renewal terms, an 18% late-payment surcharge (${money(Math.round(base * 18) / 100, renewal.currency)}) will apply once to the unpaid renewal amount if payment is received after the due date.`
    : 'If an 18% late-payment surcharge is included in your accepted renewal terms, it will apply once to the unpaid renewal amount after the due date. We will confirm and itemise any applicable charge before collection.'
  return { subject: `Hich Web | ${expired ? 'Action required: service renewal overdue' : 'Upcoming domain & hosting renewal'}`, body: [
    greeting(renewal.client_name),
    expired ? 'Our records show that your domain / hosting renewal payment is overdue. Please contact us promptly to confirm service availability and renewal options.' : 'Your domain / hosting renewal is approaching. Please arrange payment before the date below so we can process the renewal and help keep your services active.',
    `RENEWAL DETAILS${renewal.project_title ? `\nProject: ${renewal.project_title}` : ''}\nRenewal amount: ${money(base, renewal.currency)}\nDue / service expiry date: ${formatDate(renewal.due_date)}`,
    `LATE-PAYMENT TERMS\n${chargeText}\nAny VAT legally applicable to the service is shown separately on the invoice; a late-payment surcharge is not VAT.`,
    renewal.payment_instructions ? `PAYMENT DETAILS\n${renewal.payment_instructions}` : '',
    renewal.share_url ? `VIEW DETAILS\n${renewal.share_url}` : '',
    'Please include your project or invoice reference and send the transfer receipt after payment. Renewal is confirmed only after cleared payment and provider confirmation. After expiry, provider suspension, redemption fees or domain loss may apply; any recovery cost will be quoted for approval.',
    'If you have already renewed or wish to discuss the amount, please reply and we will check your record.', closing,
  ].filter(Boolean).join('\n\n') }
}

export function agreementMessage(agreement: Agreement): ClientMessage {
  return { subject: `Hich Web | Agreement ready for review | ${agreement.project_title || agreement.title}`, body: [
    greeting(agreement.client_name),
    `Your agreement for ${agreement.project_title || 'your project'} is ready to review and sign.`,
    `AGREEMENT SUMMARY\nReference: ${agreement.reference || agreement.title}\nProject budget: ${money(agreement.amount, agreement.currency)}${Number(agreement.visiting_fee_lkr) > 0 ? `\nVisiting fee: ${money(agreement.visiting_fee_lkr, 'LKR')} (credited to the final project balance once collected)` : ''}${agreement.expires_at ? `\nPlease sign by: ${formatDate(agreement.expires_at)}` : ''}`,
    'Please read the scope, payment schedule, visiting-fee conditions, renewal terms and transfer conditions carefully. Let us know if any detail needs correction before signing.',
    agreement.share_url ? `REVIEW & SIGN SECURELY\n${agreement.share_url}` : '',
    'The link is private; please share it only with the authorised signatory. You can retain a copy after signing.', closing,
  ].filter(Boolean).join('\n\n') }
}

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
export function professionalEmail(subject: string, body: string): string {
  const sections = body.split(/\n\n+/).map(block => {
    const lines = block.split('\n')
    const isHeading = /^[A-Z &/—-]{5,}$/.test(lines[0])
    const content = lines.map((line, i) => {
      const safe = escape(line)
      if (isHeading && i === 0) return `<h2 style="font-size:12px;letter-spacing:1px;color:#5263ff;margin:0 0 12px">${safe}</h2>`
      if (/^https:\/\//.test(line)) return `<a href="${safe}" style="color:#2535dc;word-break:break-all">${safe}</a>`
      return safe
    }).join('<br>')
    return `<div style="margin:0 0 20px;${isHeading ? 'background:#f4f6fc;border:1px solid #e5e9f3;border-radius:10px;padding:20px;' : ''}">${content}</div>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f4fa;font-family:Arial,sans-serif;color:#243149"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:28px 12px"><table role="presentation" width="100%" style="max-width:640px;margin:auto;background:white;border-radius:16px" cellspacing="0" cellpadding="0"><tr><td style="background:#192a46;color:white;padding:28px;border-radius:16px 16px 0 0"><strong style="font-size:25px;letter-spacing:2px">HICH WEB</strong><p style="font-size:12px;color:#c0cee6;margin:8px 0 0">Client Services · Websites & Systems</p></td></tr><tr><td style="padding:30px 28px;font-size:14px;line-height:1.7"><h1 style="font-size:21px;line-height:1.4;margin:0 0 24px">${escape(subject)}</h1>${sections}</td></tr><tr><td style="padding:22px 28px;border-top:1px solid #edf0f6;font-size:12px;color:#68778f">Hich Web | Clear scope. Recorded payments. Reliable service.<br>Please keep private document links secure.</td></tr></table></td></tr></table></body></html>`
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
