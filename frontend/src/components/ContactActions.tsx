import { MessageCircle, Phone } from 'lucide-react'

export function ContactActions({ light = false }: { light?: boolean }) {
  return <div className={`contact-actions${light ? ' contact-actions--light' : ''}`} aria-label="Contact Hich">
    <a className="button button--secondary" href="tel:+94714112113" aria-label="Call Hich on 0714112113"><Phone size={18} aria-hidden="true" /><span>Call 071 411 2113</span></a>
    <a className="button button--secondary contact-actions__whatsapp" href="https://wa.me/94714112113" target="_blank" rel="noopener noreferrer" aria-label="WhatsApp Hich on 0714112113"><MessageCircle size={18} aria-hidden="true" /><span>WhatsApp</span></a>
  </div>
}
