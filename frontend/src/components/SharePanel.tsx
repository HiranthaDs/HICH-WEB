import { Copy, Download, ExternalLink, Mail, MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Input, Textarea } from './ui'
import { useToast } from '../context/ToastContext'
import { copyText, whatsappUrl } from '../lib/sharing'
import { downloadEmailDraft, professionalEmail } from '../lib/messages'
import { api } from '../lib/api'

export function SharePanel({ url, title, phone, email, message }: { url?: string; title: string; phone?: string; email?: string; message?: string }) {
  const { toast } = useToast()
  const initial = message || `Hello,\n\n${title}\n\nPlease review your secure Hich Web link: ${url || ''}\n\nPlease reply if any detail needs clarification.\nThank you,\nHich Web | Client Services`
  const trimmedPhone = phone?.trim() || ''
  const phoneDigits = trimmedPhone.replace(/\D/g, '').replace(/^00/, '')
  const canUseWhatsApp = /^\+?[\d\s().-]+$/.test(trimmedPhone) && phoneDigits.length >= 8 && phoneDigits.length <= 15
  const [body, setBody] = useState(initial)
  const [subject, setSubject] = useState(title)
  const [recipient, setRecipient] = useState(email || '')
  const [delivery, setDelivery] = useState<{ available: boolean; sender?: string } | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => { void api.communications.emailStatus().then(setDelivery).catch(() => setDelivery({ available: false })) }, [])
  const sendEmail = async () => {
    if (sending) return
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return toast('Enter a valid recipient email address.', 'error')
    if (!window.confirm(`Send this professional email to ${recipient} from ${delivery?.sender}?`)) return
    setSending(true)
    try { toast((await api.communications.email(recipient, subject, body)).message, 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Email could not be sent.', 'error') }
    finally { setSending(false) }
  }
  useEffect(() => { setBody(initial); setSubject(title); setRecipient(email || '') }, [initial, title, email])
  return <section className="share-panel"><p className="eyebrow">Ready to share</p><h3>{title}</h3>{url && <Input label="Client link" readOnly value={url} onFocus={e => e.target.select()} />}<Textarea label="Client message" rows={12} value={body} onChange={e => setBody(e.target.value)} /><Input label="Email subject" value={subject} onChange={e => setSubject(e.target.value)} /><Input label="Recipient email" type="email" value={recipient} onChange={e => setRecipient(e.target.value)} optional /><div className="document-toolbar">{url && <><Button icon={Copy} onClick={() => void copyText(url).then(() => toast('Link copied.', 'success')).catch(e => toast(e.message, 'error'))}>Copy link</Button><a className="button button--secondary" href={url} target="_blank" rel="noreferrer"><ExternalLink size={16} />Preview</a></>}<Button variant="secondary" icon={Copy} onClick={() => void copyText(body).then(() => toast('Message copied.', 'success')).catch(e => toast(e.message, 'error'))}>Copy message</Button>{canUseWhatsApp ? <a className="button button--secondary" href={whatsappUrl(trimmedPhone, body)} target="_blank" rel="noreferrer"><MessageCircle size={16} />WhatsApp</a> : <Button type="button" variant="secondary" icon={MessageCircle} disabled title="Add a valid client phone number to use WhatsApp." aria-label="WhatsApp unavailable: add a valid client phone number">Add phone for WhatsApp</Button>}<a className="button button--secondary" href={`mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}><Mail size={16} />Email app</a><Button variant="secondary" icon={Download} onClick={() => { downloadEmailDraft(recipient, subject, body); toast('HTML email draft downloaded. Open it in a compatible email app, review and send.', 'success') }}>Professional email draft</Button></div><div className="document-toolbar">{delivery?.available ? <Button icon={Mail} loading={sending} onClick={() => void sendEmail()}>Send professional email</Button> : <small>Direct email delivery needs SMTP configuration. You can use the professional draft now.</small>}</div><details className="email-preview"><summary>Preview professional email layout</summary><iframe title="Professional email preview" sandbox="" srcDoc={professionalEmail(subject, body)} /></details><small>Review before sending. WhatsApp and Email app open your composer. The professional .eml draft includes the HTML layout for compatible email apps.</small></section>
}
