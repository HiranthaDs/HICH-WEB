import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ErrorState, LoadingState } from '../components/ui'
import { api } from '../lib/api'
import { prepareProposalHtml } from '../lib/proposals'
import type { Proposal } from '../lib/types'

const PROPOSAL_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'

export function PublicProposal() {
  const { token = '' } = useParams()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const previousTitle = document.title
    setProposal(null)
    setError('')
    void api.publicProposal(token)
      .then((result) => {
        if (!cancelled) {
          setProposal(result)
          document.title = `${result.title} | Hich Web`
        }
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'This proposal could not be opened.') })
    return () => { cancelled = true; document.title = previousTitle }
  }, [token])

  if (error) return <main className="proposal-public-state"><ErrorState title="Proposal unavailable" message={error} /></main>
  if (!proposal) return <main className="proposal-public-state"><LoadingState label="Opening your proposal…" /></main>
  return (
    <main className="proposal-public-viewer">
      <iframe
        title={`${proposal.title} proposal and quotation`}
        sandbox={PROPOSAL_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={prepareProposalHtml(proposal.html_content || '')}
      />
    </main>
  )
}
