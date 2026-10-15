import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ErrorState, LoadingState } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { prepareProposalHtml } from '../lib/proposals'
import type { Proposal } from '../lib/types'

const PROPOSAL_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'
const PROPOSAL_READY = 'hich:proposal-content-ready'

function newOpeningId(): string {
  // getRandomValues also works on local HTTP previews where randomUUID is not
  // exposed. This ID identifies one visit, never a person or an auth session.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function PublicProposal() {
  const { token = '' } = useParams()
  return <ProposalDocument key={token} token={token} />
}

function ProposalDocument({ token }: { token: string }) {
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [error, setError] = useState('')
  const [rendered, setRendered] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  const opening = useRef<{ token: string; request: Promise<Proposal> } | null>(null)
  const openingId = useRef<string>()
  const tracked = useRef(false)
  const tracking = useRef(false)
  const html = useMemo(() => prepareProposalHtml(proposal?.html_content || '', PROPOSAL_READY), [proposal?.html_content])

  useEffect(() => {
    const contentReady = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.type === PROPOSAL_READY) setRendered(true)
    }
    window.addEventListener('message', contentReady)
    return () => window.removeEventListener('message', contentReady)
  }, [])

  useEffect(() => {
    let cancelled = false
    const previousTitle = document.title
    setProposal(null)
    setRendered(false)
    setError('')
    // StrictMode replays effects in development. Reuse the same opening request
    // so one displayed page does not count as two link opens.
    if (opening.current?.token !== token) opening.current = { token, request: api.publicProposal(token) }
    void opening.current.request
      .then((result) => {
        if (!cancelled) {
          setProposal(result)
          document.title = `${result.title} | Hich Web`
        }
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'This proposal could not be opened.') })
    return () => { cancelled = true; document.title = previousTitle }
  }, [token, attempt])

  useEffect(() => {
    if (!rendered) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const recordOpen = () => {
      if (cancelled || tracked.current || tracking.current || document.visibilityState !== 'visible') return
      openingId.current ||= newOpeningId()
      tracking.current = true
      attempts += 1
      void api.recordProposalOpen(token, openingId.current)
        .then(() => { tracked.current = true })
        .catch((reason: unknown) => {
          // The same ID makes a retry safe even if the first response was lost.
          // Analytics failures must never hide a client's document.
          const retryable = !(reason instanceof ApiError) || reason.status === 0 || reason.status === 408 || reason.status === 429 || reason.status >= 500
          if (!cancelled && retryable && attempts < 3) retry = setTimeout(recordOpen, attempts * 2000)
        })
        .finally(() => { tracking.current = false })
    }
    recordOpen()
    document.addEventListener('visibilitychange', recordOpen)
    window.addEventListener('online', recordOpen)
    return () => { cancelled = true; clearTimeout(retry); document.removeEventListener('visibilitychange', recordOpen); window.removeEventListener('online', recordOpen) }
  }, [rendered, token])

  if (error) return <main className="proposal-public-state"><ErrorState title="Proposal unavailable" message={error} onRetry={() => { opening.current = null; setAttempt(value => value + 1) }} /></main>
  if (!proposal) return <main className="proposal-public-state"><LoadingState label="Opening your proposal…" /></main>
  return (
    <main className="proposal-public-viewer">
      <iframe
        ref={frame}
        title={`${proposal.title} proposal and quotation`}
        sandbox={PROPOSAL_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={html}
        onLoad={() => setRendered(true)}
      />
    </main>
  )
}
