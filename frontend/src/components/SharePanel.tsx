import { Copy, ExternalLink, Mail, MessageCircle } from 'lucide-react'
import { Button, Input } from './ui'
import { useToast } from '../context/ToastContext'
import { copyText, whatsappUrl } from '../lib/sharing'

export function SharePanel({ url, title, phone, email, message }: { url: string; title: string; phone?: string; email?: string; message?: string }) {
  const { toast } = useToast()
  const body = message || `${title}\n\nPlease open your Hich Web link: ${url}`
  return <section className="share-panel"><p className="eyebrow">Ready to share</p><h3>{title}</h3><Input label="Client link" readOnly value={url} onFocus={e => e.target.select()} /><div className="document-toolbar"><Button icon={Copy} onClick={() => void copyText(url).then(() => toast('Link copied.', 'success')).catch(e => toast(e.message, 'error'))}>Copy link</Button><a className="button button--secondary" href={url} target="_blank" rel="noreferrer"><ExternalLink size={16} />Preview</a><a className="button button--secondary" href={whatsappUrl(phone || '', body)} target="_blank" rel="noreferrer"><MessageCircle size={16} />WhatsApp</a><a className="button button--secondary" href={`mailto:${email || ''}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`}><Mail size={16} />Email</a></div><small>Choose WhatsApp or email to review the message and send it to your client.</small></section>
}
