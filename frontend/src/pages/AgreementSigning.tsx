import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Check,
  CheckCircle2,
  FileCheck2,
  FileText,
  Download,
  Printer,
  LockKeyhole,
  PenLine,
  ShieldCheck,
  Type,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Brand } from '../components/Brand'
import { SignaturePad, type SignaturePadHandle } from '../components/SignaturePad'
import { Button, ErrorState, Input, LoadingState, Modal, StatusPill } from '../components/ui'
import { useToast } from '../context/ToastContext'
import { api, ApiError } from '../lib/api'
import { formatCurrency, formatDate, getClientName } from '../lib/format'
import type { PublicAgreement } from '../lib/types'

export function AgreementSigning() {
  const { token = '' } = useParams()
  const { toast } = useToast()
  const signatureRef = useRef<SignaturePadHandle>(null)
  const [agreement, setAgreement] = useState<PublicAgreement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'draw' | 'type'>('draw')
  const [signerName, setSignerName] = useState('')
  const [jobRole, setJobRole] = useState('')
  const [clauseQuery, setClauseQuery] = useState('')
  const [showFullAgreement, setShowFullAgreement] = useState(false)
  const [showSignedDocument, setShowSignedDocument] = useState(false)
  const [signerEmail, setSignerEmail] = useState('')
  const [typedSignature, setTypedSignature] = useState('')
  const [hasDrawing, setHasDrawing] = useState(false)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const result = await api.publicAgreement(token)
      setAgreement(result)
      setSignerName(result.signer_name || result.client_name || (typeof result.client === 'object' ? result.client.name : '') || '')
      setSignerEmail(result.client_email || (typeof result.client === 'object' ? result.client.email : '') || '')
      setSubmitted(Boolean(result.signed || result.status === 'signed'))
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 404) setError('This agreement link is invalid or no longer available.')
      else setError(requestError instanceof Error ? requestError.message : 'The agreement could not be opened.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void load() }, [load])

  const submit = async () => {
    if (!jobRole.trim()) return toast('Enter your job role or title.', 'error')
    if (!signerName.trim()) return toast('Enter your full legal name before signing.', 'error')
    if (mode === 'draw' && !hasDrawing) return toast('Draw your signature in the signature box.', 'error')
    if (mode === 'type' && typedSignature.trim().length < 2) return toast('Type your signature before continuing.', 'error')
    if (!consent) return toast('Please confirm the electronic signature consent.', 'error')
    setSubmitting(true)
    try {
      const result = await api.signAgreement(token, {
        signer_name: signerName.trim(),
        signer_job_role: jobRole.trim(),
        expected_version: agreement?.version,
        expected_content_sha256: agreement?.content_sha256,
        signer_email: signerEmail.trim() || undefined,
        typed_signature: mode === 'type' ? typedSignature.trim() : undefined,
        signature_data_url: mode === 'draw' ? signatureRef.current?.toDataURL() : undefined,
        consent: true,
      })
      setAgreement((current) => ({ ...(current || {} as PublicAgreement), ...result, status: 'signed', signed: true }))
      setSubmitted(true)
      window.scrollTo({ top: 0, behavior: 'smooth' })
      toast('Agreement signed successfully.', 'success')
    } catch (requestError) {
      toast(requestError instanceof Error ? requestError.message : 'The signature could not be submitted.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="sign-page sign-page--center"><Brand /><LoadingState label="Opening your secure agreement…" /></div>
  if (error || !agreement) return <div className="sign-page sign-page--center"><Brand /><ErrorState title="Agreement unavailable" message={error} onRetry={load} /><Link className="text-link" to="/"><ArrowLeft size={15} /> Return to Hich Studio</Link></div>

  const clientName = getClientName(agreement.client, agreement.client_name)
  const isExpired = agreement.status === 'expired' || Boolean(agreement.expires_at && new Date(agreement.expires_at) < new Date() && agreement.status !== 'signed')
  const terms = Array.isArray(agreement.terms)
    ? agreement.terms
    : typeof agreement.terms === 'string'
      ? agreement.terms.split(/\n{2,}/).filter(Boolean)
      : agreement.terms && typeof agreement.terms === 'object'
        ? Object.entries(agreement.terms).map(([title, body]) => `${title}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
        : []

  const isSigned = submitted || agreement.signed || agreement.status === 'signed'
  const descriptionSections = (agreement.description || '').split(/\n\n(?=\d{1,2}\. )/)
  const longDescription = descriptionSections.length > 1 && /^\d{1,2}\. /.test(descriptionSections[0])
  const clauses = agreement.clauses?.length ? agreement.clauses : [
    ...(longDescription ? descriptionSections.map(section => { const split = section.indexOf('\n'); return split < 0 ? { title: section, body: '' } : { title: section.slice(0, split), body: section.slice(split + 1).trim() } }) : []),
    ...terms.map((term, index) => { const split = term.indexOf(':'); return split > 0 && split < 140 ? { title: term.slice(0, split), body: term.slice(split + 1).trim() } : { title: `${index + 1}. Agreement term`, body: term } }),
  ]
  const visibleClauses = clauses.map((clause, index) => ({ ...clause, index })).filter(clause => !clauseQuery.trim() || `${clause.title} ${clause.body}`.toLowerCase().includes(clauseQuery.trim().toLowerCase()))
  const openFullAgreement = () => { setClauseQuery(''); setShowFullAgreement(true) }
  const showCommercial = agreement.commercial_details_visible !== false
  const agreementDetails = <div className="agreement-meta">
    <div><span>Prepared for</span><strong>{clientName}</strong>{agreement.client_email && <small>{agreement.client_email}</small>}</div>
    <div><span>Client phone</span><strong>{agreement.client_phone || 'Not provided'}</strong></div>
    {showCommercial && <div><span>Project budget</span><strong>{formatCurrency(agreement.amount || 0, agreement.currency || 'LKR')}</strong></div>}
    <div><span>Project</span><strong>{agreement.project_title || agreement.title}</strong></div>
    <div><span>Reference</span><strong>{agreement.reference || `#${agreement.id}`}</strong></div>
    <div><span>Valid until</span><strong>{formatDate(agreement.expires_at)}</strong></div>
  </div>
  const agreementValue = <>
    {showCommercial ? <>
      <section className="agreement-value"><span>Agreed project value</span><strong>{formatCurrency(agreement.amount || 0, agreement.currency || 'LKR')}</strong></section>
      {Number(agreement.renewal_amount) > 0 && <section className="agreement-section"><h2>Annual renewal & service expiry</h2><p>Annual hosting, domain and maintenance renewal: <strong>{formatCurrency(agreement.renewal_amount, agreement.renewal_currency || 'LKR')}</strong>.</p><p>Service expiry / renewal due: <strong>{formatDate(agreement.renewal_due_date)}</strong>. Renewal is separate from the project development budget and is subject to the renewal terms in the full agreement.</p></section>}
    </> : <section className="agreement-section agreement-section--muted"><h2>Scope-only agreement</h2><p>This agreement does not include project prices, payment milestones, visiting fees or renewal figures. Any applicable commercial details are issued separately.</p></section>}
  </>
  const fullAgreementText = <>
    {agreement.description && !longDescription && <section className="agreement-section"><h2>Project overview</h2><p>{agreement.description}</p></section>}
    {clauses.length ? clauses.map((clause, index) => <section className="agreement-section" key={index}><h2>{clause.title}</h2><p>{clause.body}</p></section>) : <section className="agreement-section agreement-section--muted"><FileText size={20} /><p>No additional terms are included.</p></section>}
  </>

  if (isSigned && !showSignedDocument) {
    return (
      <div className="sign-page sign-page--complete">
        <header className="sign-header"><Brand /><span><LockKeyhole size={14} /> Secure document</span></header>
        <main className="sign-complete">
          <span className="sign-complete__icon"><CheckCircle2 size={38} /></span>
          <p className="eyebrow">Signature complete</p>
          <h1>Thank you, {agreement.signer_name || signerName || clientName}.</h1>
          <p>Your signature has been recorded and the agreement is now complete. Keep this page as confirmation; Hich Studio will also retain the signed record.</p>
          <div className="sign-complete__receipt">
            <div><span>Agreement</span><strong>{agreement.title}</strong></div>
            <div><span>Reference</span><strong>{agreement.reference || `#${agreement.id}`}</strong></div>
            <div><span>Signed</span><strong>{formatDate(agreement.signed_at || new Date().toISOString(), { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong></div>
            <div><span>Status</span><StatusPill status="signed" /></div>
          </div>
          <div className="document-toolbar"><Button icon={Download} onClick={() => void api.publicAgreementPdf(token).catch(e => toast(e.message, 'error'))}>Download signed PDF</Button><Button variant="secondary" onClick={() => setShowSignedDocument(true)}>View signed agreement</Button></div>
          <Link className="button button--secondary" to="/"><ArrowLeft size={17} /><span>Visit Hich Studio</span></Link>
          {agreement.signed_record_sha256 && <p className="evidence-hash">Record fingerprint: {agreement.signed_record_sha256}</p>}
          <small><ShieldCheck size={14} /> A secure signing record has been created.</small>
        </main>
      </div>
    )
  }

  return (
    <div className="sign-page">
      <header className="sign-header"><Brand /><span><LockKeyhole size={14} /> Secure document</span></header>
      <div className="sign-progress" aria-label="Agreement progress"><span className="complete"><Check size={13} /> Opened</span><i /><span className={isSigned ? 'complete' : 'active'}>{isSigned ? <><Check size={13} /> Signed</> : '2 Sign'}</span><i /><span className={isSigned ? 'complete' : undefined}>{isSigned ? <><Check size={13} /> Complete</> : '3 Complete'}</span></div>
      <div className="document-toolbar sign-document-tools"><a className="button button--primary" href="#signature">{isSigned ? 'View signature' : 'Go to signature'}</a><Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print agreement</Button><span>Version {agreement.version || 1} - {clauses.length} clauses</span></div>
      <main className="sign-layout">
        <article className="agreement-document">
          <header className="agreement-document__header">
            <div><span className="document-icon"><FileCheck2 size={23} /></span><p className="eyebrow">Service agreement</p><h1>{agreement.title}</h1></div>
            <StatusPill status={agreement.status} />
          </header>
          {agreementDetails}
          <div className="agreement-terms-preview no-print">
            {agreement.description && !longDescription && <section className="agreement-section"><h2>Project overview</h2><p className="agreement-scope-preview">{agreement.description}</p></section>}
            <section className="agreement-section"><h2>Agreement terms</h2><p>{clauses.length ? `${clauses.length} sections cover the complete scope, fees, responsibilities and service terms. Review the full agreement before signing.` : 'Review the complete project details and agreement before signing.'}</p></section>
            <Button variant="secondary" icon={FileText} onClick={openFullAgreement} aria-haspopup="dialog">See more — full agreement</Button>
          </div>
          <div className="agreement-terms-full">{fullAgreementText}</div>
          {agreementValue}
        </article>

        <aside className="sign-panel" id="signature">
          <div className="sign-panel__sticky">
            <div className="sign-panel__heading"><span><PenLine size={20} /></span><div><p className="eyebrow">Your signature</p><h2>Review and accept</h2></div></div>
            {isSigned ? <><StatusPill status="signed" /><p>Accepted by {agreement.signer_name || signerName}{agreement.signer_job_role ? `, ${agreement.signer_job_role}` : ''} on {formatDate(agreement.signed_at)}.</p><Button icon={Download} onClick={() => void api.publicAgreementPdf(token).catch(e => toast(e.message, 'error'))}>Signed PDF</Button></> : isExpired ? <div className="inline-alert inline-alert--error"><AlertTriangle size={18} /><div><strong>This agreement has expired.</strong><p>Ask Hich Studio for a new signing link.</p></div></div> : <>
              <Input label="Full legal name" value={signerName} onChange={(event) => setSignerName(event.target.value)} autoComplete="name" placeholder="Your full name" />
              <Input label="Job role / title" value={jobRole} onChange={event => setJobRole(event.target.value)} autoComplete="organization-title" placeholder="Owner, director, project manager..." required />
              <Input label="Email address" type="email" value={signerEmail} onChange={(event) => setSignerEmail(event.target.value)} autoComplete="email" placeholder="you@example.com" optional />
              <div className="signature-tabs" role="tablist" aria-label="Signature method">
                <button className={mode === 'draw' ? 'active' : ''} type="button" onClick={() => setMode('draw')} role="tab" aria-selected={mode === 'draw'}><PenLine size={16} /> Draw</button>
                <button className={mode === 'type' ? 'active' : ''} type="button" onClick={() => setMode('type')} role="tab" aria-selected={mode === 'type'}><Type size={16} /> Type</button>
              </div>
              {mode === 'draw' ? <SignaturePad ref={signatureRef} onChange={setHasDrawing} /> : <div className="typed-signature"><Input label="Type your signature" value={typedSignature} onChange={(event) => setTypedSignature(event.target.value)} placeholder="Type your full name" /><div aria-hidden="true">{typedSignature || 'Your signature'}</div></div>}
              <Button variant="ghost" icon={FileText} onClick={openFullAgreement} aria-haspopup="dialog">Read the full agreement</Button>
              <label className="consent-check"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span><i><Check size={13} /></i>{agreement.consent_text || 'I agree to the complete agreement, including the stated scope, budget and additional charges policy. I confirm that I am authorised to accept it and intend this electronic signature to record my acceptance.'}</span></label>
              <Button className="sign-submit" size="lg" icon={BadgeCheck} loading={submitting} onClick={submit}>Sign agreement</Button>
              <p className="sign-panel__security"><ShieldCheck size={15} /> Your signature and signing time are securely recorded.</p>
            </>}
          </div>
        </aside>
      </main>
      <Modal open={showFullAgreement} onClose={() => setShowFullAgreement(false)} title={agreement.title} description={`${agreement.reference || agreement.id} · Version ${agreement.version || 1} · Complete agreement`} size="lg" footer={<Button onClick={() => { setShowFullAgreement(false); if (!isSigned) window.requestAnimationFrame(() => document.getElementById('signature')?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }}>{isSigned ? 'Close agreement' : 'Return to signature'}</Button>}>
        <div className="agreement-terms-dialog">
          {agreementDetails}
          {agreement.description && !longDescription && <section className="agreement-section"><h2>Project overview</h2><p>{agreement.description}</p></section>}
          {clauses.length > 0 && <div className="agreement-terms-dialog__nav"><Input label="Find an agreement clause" placeholder="Search scope, renewal, fees…" value={clauseQuery} onChange={event => setClauseQuery(event.target.value)} /><p className="field-hint" aria-live="polite">{visibleClauses.length} of {clauses.length} sections{clauseQuery.trim() ? ' match your search.' : '.'}</p>{clauseQuery.trim() && <Button variant="ghost" size="sm" onClick={() => setClauseQuery('')}>Show all sections</Button>}</div>}
          {visibleClauses.map(clause => <section className="agreement-section" key={clause.index}><h2>{clause.title}</h2><p>{clause.body}</p></section>)}
          {clauses.length > 0 && !visibleClauses.length && <p className="field-hint">No clauses match. Clear the search to read all sections.</p>}
          {agreementValue}
        </div>
      </Modal>
      <footer className="sign-footer"><span>Powered by Hich Studio</span><span>Secure agreement · {agreement.reference || agreement.id}</span></footer>
    </div>
  )
}
