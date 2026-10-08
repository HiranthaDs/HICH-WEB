import { CheckCircle2, LockKeyhole } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { Brand } from '../components/Brand'
import { Button, ErrorState, Input, LoadingState, StatusPill } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import { formatCurrency, formatDate } from '../lib/format'
import type { ChangeOrder } from '../lib/types'

export function PublicChange() {
  const { token = '' } = useParams()
  const { toast } = useToast()
  const [change, setChange] = useState<ChangeOrder | null>(null)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void api.publicChange(token).then(setChange).catch(e => setError(e.message)) }, [token])
  const approve = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try { setChange(await api.approveChange(token, { signer_name: name, signer_job_role: role, consent })); toast('Approval recorded.', 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save approval.', 'error') }
    finally { setBusy(false) }
  }
  return <div className="sign-page"><header className="sign-header"><Brand /><span><LockKeyhole size={14} />Scope approval</span></header>{error ? <ErrorState message={error} /> : !change ? <LoadingState /> : <main className="document-layout"><article className="agreement-document"><header className="agreement-document__header"><div><p className="eyebrow">{change.reference} · {change.project_title}</p><h1>{change.title}</h1></div><StatusPill status={change.status} /></header><section className="agreement-section"><h2>The additional work</h2><p>{change.description}</p></section><dl className="document-summary"><div><dt>Additional fee</dt><dd>{formatCurrency(change.amount, change.currency)}</dd></div><div><dt>Schedule extension</dt><dd>{change.extra_days} days</dd></div></dl><section className="agreement-section"><p>This change adds the scope, fee and time shown above to your existing development agreement. Its other terms remain applicable. Hich Web will schedule the additional work after your approval and any agreed advance payment.</p></section></article><aside className="document-sidebar"><section className="share-panel">{change.status === 'approved' ? <><CheckCircle2 size={40} /><h2>Change approved.</h2><p>{change.signer_name}, {change.signer_job_role}</p><p>Recorded {formatDate(change.approved_at)}</p><Button onClick={() => window.print()}>Print confirmation</Button></> : <form onSubmit={approve}><h2>Approve this change</h2><Input label="Full name" autoComplete="name" required minLength={2} value={name} onChange={e => setName(e.target.value)} /><Input label="Job role / title" autoComplete="organization-title" required minLength={2} value={role} onChange={e => setRole(e.target.value)} /><label className="consent-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required /><span>I am authorised to approve this additional scope, fee and schedule extension.</span></label><Button type="submit" loading={busy}>Approve additional work</Button></form>}</section></aside></main>}</div>
}
