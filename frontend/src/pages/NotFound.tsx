import { ArrowLeft, Compass } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Brand } from '../components/Brand'

export function NotFound() {
  return (
    <main className="not-found">
      <Brand />
      <span><Compass size={32} /></span>
      <p className="eyebrow">404 · Page not found</p>
      <h1>This page wandered off.</h1>
      <p>The address may be outdated, or the page may have moved somewhere new.</p>
      <Link className="button button--primary" to="/"><ArrowLeft size={17} /><span>Back to Hich Studio</span></Link>
    </main>
  )
}
