import { Archive, Building2, Check, Code2, Eye, Link2, Mail, Pencil, Phone, Plus, Presentation, RefreshCw, ShieldCheck, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SharePanel } from '../../components/SharePanel'
import { Button, ConfirmDialog, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, SearchInput, Select, StatusPill, Textarea } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { api } from '../../lib/api'
import { formatDate, formatLinkOpens } from '../../lib/format'
import { proposalMessage } from '../../lib/messages'
import { prepareProposalHtml } from '../../lib/proposals'
import type { Client, Proposal } from '../../lib/types'

const PROPOSAL_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'

type ProposalForm = {
  client_id: string
  client_name: string
  client_company: string
  client_email: string
  client_phone: string
  client_address: string
  reference: string
  title: string
  html_content: string
  expected_version?: number
}

const blankForm: ProposalForm = {
  client_id: '', client_name: '', client_company: '', client_email: '', client_phone: '', client_address: '',
  reference: '', title: '', html_content: '',
}

export function ProposalsPage() {
  const { toast } = useToast()
  const [searchParams] = useSearchParams()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [clientError, setClientError] = useState('')
  const [query, setQuery] = useState(searchParams.get('search') || '')
  const [status, setStatus] = useState('all')
  const [editing, setEditing] = useState<Proposal | 'new' | null>(null)
  const [form, setForm] = useState<ProposalForm>(blankForm)
  const [clientQuery, setClientQuery] = useState('')
  const [clientMode, setClientMode] = useState<'existing' | 'new'>('existing')
  const [clientValidationError, setClientValidationError] = useState('')
  const [saving, setSaving] = useState(false)
  const [showEditorPreview, setShowEditorPreview] = useState(false)
  const [previewing, setPreviewing] = useState<Proposal | null>(null)
  const [shared, setShared] = useState<Proposal | null>(null)
  const [sharing, setSharing] = useState<Proposal['id'] | null>(null)
  const [loadingDocument, setLoadingDocument] = useState<Proposal['id'] | null>(null)
  const [deleting, setDeleting] = useState<Proposal | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const loadGeneration = useRef(0)
  const mutationGeneration = useRef(0)
  const refreshInFlight = useRef(false)
  const autoCreateKey = useRef('')
  const autoOpenProposalKey = useRef('')
  const clientPickerRef = useRef<HTMLElement>(null)

  useEffect(() => { setQuery(searchParams.get('search') || '') }, [searchParams])

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    const mutation = mutationGeneration.current
    setLoading(true)
    setError('')
    setClientError('')
    const [proposalResult, clientResult] = await Promise.allSettled([api.proposals.list(), api.clients.list()])
    if (generation !== loadGeneration.current) return
    if (proposalResult.status === 'fulfilled') {
      if (mutation === mutationGeneration.current) setProposals(proposalResult.value.items)
    }
    else setError(proposalResult.reason instanceof Error ? proposalResult.reason.message : 'Proposals could not be loaded.')
    if (clientResult.status === 'fulfilled') setClients(clientResult.value.items)
    else setClientError(clientResult.reason instanceof Error ? clientResult.reason.message : 'Client records could not be loaded.')
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const refreshViews = () => {
      if (document.visibilityState !== 'visible' || refreshInFlight.current) return
      refreshInFlight.current = true
      const generation = loadGeneration.current
      const mutation = mutationGeneration.current
      void api.proposals.list().then(result => {
        if (loadGeneration.current === generation && mutationGeneration.current === mutation) setProposals(result.items)
      }).catch(() => { /* Keep the last loaded cards; manual refresh shows errors. */ })
        .finally(() => { refreshInFlight.current = false })
    }
    window.addEventListener('focus', refreshViews)
    const interval = setInterval(refreshViews, 30000)
    return () => { window.removeEventListener('focus', refreshViews); clearInterval(interval) }
  }, [])

  const filtered = useMemo(() => proposals.filter((proposal) => {
    const matchesQuery = !query || [proposal.reference, proposal.title, proposal.client_name, proposal.client_company, proposal.client_email]
      .join(' ').toLowerCase().includes(query.toLowerCase())
    return matchesQuery && (status === 'all' || proposal.status === status)
  }), [proposals, query, status])

  const availableClients = useMemo(() => clients.filter((client) => {
    if (String(client.id) === form.client_id) return true
    return [client.name, client.company, client.email, client.phone].join(' ').toLowerCase().includes(clientQuery.toLowerCase())
  }), [clients, clientQuery, form.client_id])

  const selectedClient = useMemo<Client | undefined>(() => {
    const current = clients.find((client) => String(client.id) === form.client_id)
    if (current) return current
    if (!form.client_id) return undefined
    // Keep a historical/soft-deleted linked client visible while editing.
    return {
      id: form.client_id,
      name: form.client_name || 'Linked client',
      company: form.client_company || undefined,
      email: form.client_email || undefined,
      phone: form.client_phone || undefined,
      address: form.client_address || undefined,
      status: 'archived',
    }
  }, [clients, form.client_address, form.client_company, form.client_email, form.client_id, form.client_name, form.client_phone])

  const selectClient = (id: string) => {
    if (!id) {
      setForm((current) => ({ ...current, client_id: '', client_name: '', client_company: '', client_email: '', client_phone: '', client_address: '' }))
      return
    }
    const client = clients.find((item) => String(item.id) === id)
    if (!client) return
    setClientValidationError('')
    setClientMode('existing')
    setForm((current) => ({
      ...current,
      client_id: id,
      client_name: client.name || '',
      client_company: client.company || '',
      client_email: client.email || '',
      client_phone: client.phone || '',
      client_address: client.address || '',
    }))
  }

  const fillEditor = (proposal: Proposal) => {
    setEditing(proposal)
    setClientMode('existing')
    setClientValidationError('')
    setClientQuery('')
    setShowEditorPreview(false)
    setForm({
      client_id: String(proposal.client_id),
      client_name: proposal.client_name || '',
      client_company: proposal.client_company || '',
      client_email: proposal.client_email || '',
      client_phone: proposal.client_phone || '',
      client_address: proposal.client_address || '',
      reference: proposal.reference || '',
      title: proposal.title,
      html_content: proposal.html_content || '',
      expected_version: proposal.version,
    })
  }

  const beginCreate = (client?: Client) => {
    setEditing('new')
    setClientQuery('')
    setClientValidationError('')
    setShowEditorPreview(false)
    setClientMode(client ? 'existing' : clients.length ? 'existing' : 'new')
    setForm(client ? {
      ...blankForm,
      client_id: String(client.id),
      client_name: client.name || '',
      client_company: client.company || '',
      client_email: client.email || '',
      client_phone: client.phone || '',
      client_address: client.address || '',
    } : { ...blankForm })
  }

  const openEditor = async (proposal?: Proposal) => {
    if (!proposal) {
      beginCreate()
      return
    }
    setLoadingDocument(proposal.id)
    try { fillEditor(await api.proposals.get(proposal.id)) }
    catch (reason) { toast(reason instanceof Error ? reason.message : 'The proposal could not be opened.', 'error') }
    finally { setLoadingDocument(null) }
  }

  useEffect(() => {
    const clientId = searchParams.get('client') || ''
    const key = searchParams.get('create') === '1' ? clientId : ''
    if (!key || key === autoCreateKey.current || !clients.length) return
    const client = clients.find((item) => String(item.id) === key)
    if (!client) return
    autoCreateKey.current = key
    beginCreate(client)
  }, [clients, searchParams])

  useEffect(() => {
    const proposalId = searchParams.get('proposal') || ''
    if (!proposalId || proposalId === autoOpenProposalKey.current || loading) return
    const proposal = proposals.find((item) => String(item.id) === proposalId)
    if (!proposal) return
    autoOpenProposalKey.current = proposalId
    void openEditor(proposal)
  }, [loading, proposals, searchParams])

  const switchClientMode = (nextMode: 'existing' | 'new') => {
    if (nextMode === clientMode) return
    setClientMode(nextMode)
    setClientValidationError('')
    setForm((current) => ({ ...current, client_id: '', client_name: '', client_company: '', client_email: '', client_phone: '', client_address: '' }))
  }

  const openPreview = async (proposal: Proposal) => {
    setLoadingDocument(proposal.id)
    try { setPreviewing(await api.proposals.get(proposal.id)) }
    catch (reason) { toast(reason instanceof Error ? reason.message : 'The proposal preview could not be opened.', 'error') }
    finally { setLoadingDocument(null) }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    if (clientMode === 'existing' && !form.client_id) {
      const message = 'Select the client record for this proposal.'
      setClientValidationError(message)
      toast(message, 'error')
      window.setTimeout(() => clientPickerRef.current?.querySelector<HTMLElement>('.search-box input')?.focus(), 0)
      return
    }
    if (clientMode === 'new' && !form.client_name.trim()) {
      const message = 'Enter the new client name.'
      setClientValidationError(message)
      toast(message, 'error')
      window.setTimeout(() => clientPickerRef.current?.querySelector<HTMLElement>('.proposal-new-client input')?.focus(), 0)
      return
    }
    if (!form.title.trim()) return toast('Add a proposal title.', 'error')
    if (form.html_content.trim().length < 20) return toast('Paste the complete proposal HTML before saving.', 'error')
    setSaving(true)
    try {
      let clientId = form.client_id
      if (!clientId) {
        const client = await api.clients.create({
          name: form.client_name.trim(),
          company: form.client_company.trim() || undefined,
          email: form.client_email.trim() || undefined,
          phone: form.client_phone.trim() || undefined,
          address: form.client_address.trim() || undefined,
          status: 'active',
        })
        clientId = String(client.id)
        setClients((current) => [client, ...current])
        setClientMode('existing')
        setForm((current) => ({
          ...current,
          client_id: clientId,
          client_name: client.name || '',
          client_company: client.company || '',
          client_email: client.email || '',
          client_phone: client.phone || '',
          client_address: client.address || '',
        }))
      }
      const payload: Partial<Proposal> = {
        client_id: clientId,
        reference: form.reference.trim() || undefined,
        title: form.title.trim(),
        html_content: form.html_content,
        expected_version: form.expected_version,
      }
      const isNew = editing === 'new'
      const saved = isNew ? await api.proposals.create(payload) : await api.proposals.update((editing as Proposal).id, payload)
      // A background count refresh started before this save must not restore
      // stale proposal content or drop a newly created card.
      mutationGeneration.current += 1
      setProposals((current) => isNew ? [saved, ...current] : current.map((item) => item.id === saved.id ? saved : item))
      setEditing(null)
      toast(isNew ? 'Proposal saved. Creating the private client link…' : 'Proposal changes saved.', 'success')
      if (isNew) {
        try {
          const result = await api.proposals.share(saved.id)
          const linked = { ...saved, share_url: result.share_url || result.url, status: 'sent' }
          mutationGeneration.current += 1
          setProposals((current) => current.map((item) => item.id === saved.id ? linked : item))
          setShared(linked)
        } catch (reason) {
          toast(reason instanceof Error ? `Proposal saved, but the link could not be created: ${reason.message}` : 'Proposal saved, but the link could not be created.', 'error')
        }
      }
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Proposal could not be saved.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const share = async (proposal: Proposal, rotate = false) => {
    if (sharing !== null) return
    setSharing(proposal.id)
    try {
      const result = await api.proposals.share(proposal.id, { rotate })
      mutationGeneration.current += 1
      const linked = {
        ...proposal,
        share_url: result.share_url || result.url,
        // Re-opening an existing link must not hide an already recorded view.
        status: rotate || !proposal.share_url ? 'sent' : proposal.status,
        viewed_at: rotate ? undefined : proposal.viewed_at,
      }
      setProposals((current) => current.map((item) => item.id === proposal.id ? linked : item))
      setShared(linked)
      toast(rotate ? 'A new private link replaced the previous link.' : 'Proposal link is ready.', 'success')
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'The proposal link could not be created.', 'error')
    } finally {
      setSharing(null)
    }
  }

  const remove = async (pin: string) => {
    if (!deleting) return
    setDeletingBusy(true)
    try {
      await api.proposals.remove(deleting.id, pin)
      mutationGeneration.current += 1
      setProposals((current) => current.filter((item) => item.id !== deleting.id))
      setDeleting(null)
      toast('Proposal deleted and its public link disabled.', 'success')
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Proposal could not be deleted.', 'error')
    } finally {
      setDeletingBusy(false)
    }
  }

  const sharedMessage = shared ? proposalMessage(shared) : null
  const editingExisting = editing && editing !== 'new' ? editing : null

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Sales documents"
        title="Proposals & quotations"
        description="Paste complete HTML, connect it to a client and send one private link. Link opens count displayed visits, including repeat visits and your own opens of the client link."
        action={<Button icon={Plus} onClick={() => void openEditor()}>New proposal</Button>}
      />
      <section className="toolbar panel panel--flat">
        <SearchInput value={query} onChange={setQuery} placeholder="Search title, reference or client…" label="Search proposals" />
        <div className="toolbar__right">
          <Select aria-label="Filter proposal status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option><option value="draft">Draft</option><option value="sent">Sent</option><option value="viewed">Viewed</option>
          </Select>
          <Button variant="ghost" size="sm" icon={RefreshCw} loading={loading} onClick={load}>Refresh</Button>
        </div>
      </section>

      {proposals.some(proposal => proposal.view_count == null) && <div className="data-notice" role="status">Link-open tracking is unavailable. Ask your administrator to check the database migrations; proposals can still be opened and shared.</div>}

      {error && proposals.length > 0 && <div className="data-notice" role="status"><span>Refresh failed: {error} The last successfully loaded proposals remain visible.</span><Button type="button" variant="ghost" size="sm" onClick={load}>Retry</Button></div>}

      {loading && !proposals.length ? <LoadingState label="Loading proposals…" />
        : error && !proposals.length ? <ErrorState message={error} onRetry={load} />
          : filtered.length === 0 ? <EmptyState icon={Presentation} title={query || status !== 'all' ? 'No proposals match' : 'Create your first proposal'} description={query || status !== 'all' ? 'Adjust the search or filter to see more results.' : 'Paste a complete responsive HTML proposal, select a client and send the private link.'} action={!query && status === 'all' ? <Button icon={Plus} onClick={() => void openEditor()}>New proposal</Button> : undefined} />
            : <div className="agreement-grid proposal-grid">{filtered.map((proposal) => <article className="agreement-card proposal-card" key={proposal.id}>
              <header>
                <span className="agreement-card__icon"><Presentation size={19} /></span>
                <StatusPill status={proposal.status} />
                <button className="icon-button" type="button" disabled={loadingDocument === proposal.id} onClick={() => void openEditor(proposal)} aria-label={`Edit ${proposal.title}`}><Pencil size={16} /></button>
                <button className="icon-button icon-button--danger" type="button" onClick={() => setDeleting(proposal)} aria-label={`Delete ${proposal.title}`}><Archive size={16} /></button>
              </header>
              <div className="agreement-card__copy">
                <span>{proposal.reference || 'PROPOSAL'}</span>
                <h3 title={proposal.title}>{proposal.title}</h3>
                <p><Link className="proposal-client-link" to={`/admin/clients?client=${encodeURIComponent(String(proposal.client_id))}`}>{[proposal.client_company, proposal.client_name].filter(Boolean).join(' · ') || 'Open linked client'}</Link></p>
              </div>
              <dl>
                <div><dt>Link opens</dt><dd>{formatLinkOpens(proposal.view_count)}</dd></div>
                <div><dt>{proposal.last_opened_at ? 'Last open' : 'Created'}</dt><dd>{formatDate(proposal.last_opened_at || proposal.created_at)}</dd></div>
              </dl>
              <footer>
                <Button size="sm" variant="secondary" icon={Link2} loading={sharing === proposal.id} onClick={() => void share(proposal)}>{proposal.share_url ? 'Copy link' : 'Create link'}</Button>
                <Button size="sm" variant="ghost" icon={Eye} loading={loadingDocument === proposal.id} onClick={() => void openPreview(proposal)}>Preview</Button>
              </footer>
            </article>)}</div>}

      <Modal
        open={Boolean(editing)}
        onClose={() => { if (!saving) setEditing(null) }}
        size="xl"
        title={editing === 'new' ? 'Create proposal & quotation' : 'Edit proposal & quotation'}
        description="Paste a complete HTML document. Its original layout, responsive CSS and interactions are preserved in an isolated viewer."
        footer={<><Button variant="ghost" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="proposal-form" loading={saving}>{editing === 'new' ? 'Save & create link' : 'Save changes'}</Button></>}
      >
        <form id="proposal-form" className="form-grid proposal-form" onSubmit={save}>
          <section ref={clientPickerRef} className="proposal-client-picker form-grid__full" aria-labelledby="proposal-client-heading" aria-describedby={clientValidationError && clientMode === 'existing' ? 'proposal-client-error' : undefined} aria-invalid={Boolean(clientValidationError)}>
            <div className="proposal-client-picker__heading">
              <div><span className="field__label" id="proposal-client-heading">Link this proposal to a client</span><small>The selected CRM record remains connected to this quotation.</small></div>
              <div className="proposal-client-mode" role="group" aria-label="Client source">
                <button type="button" aria-pressed={clientMode === 'existing'} className={clientMode === 'existing' ? 'active' : ''} onClick={() => switchClientMode('existing')}><Users size={15} />Existing client</button>
                <button type="button" aria-pressed={clientMode === 'new'} className={clientMode === 'new' ? 'active' : ''} onClick={() => switchClientMode('new')}><UserPlus size={15} />New client</button>
              </div>
            </div>

            {clientMode === 'existing' ? <>
              {clientError && <div className="data-notice" role="alert"><span>{clientError}</span><Button type="button" variant="ghost" size="sm" onClick={load}>Retry</Button></div>}
              <SearchInput label="Search client records" placeholder="Search name, company, email or phone…" value={clientQuery} onChange={setClientQuery} />
              {selectedClient && <div className="proposal-selected-client">
                <span className="proposal-selected-client__check"><Check size={16} /></span>
                <div><strong>{selectedClient.name}</strong><small>{selectedClient.company || 'Independent client'}</small></div>
                <div className="proposal-selected-client__contact">{selectedClient.email && <span><Mail size={13} />{selectedClient.email}</span>}{selectedClient.phone && <span><Phone size={13} />{selectedClient.phone}</span>}</div>
                {clients.some((client) => String(client.id) === String(selectedClient.id))
                  ? <Link className="text-link" to={`/admin/clients?client=${encodeURIComponent(String(selectedClient.id))}`}>View profile</Link>
                  : <span className="field-hint">Historical client record</span>}
              </div>}
              <div className="proposal-client-list" role="group" aria-label="Client records">
                {availableClients.map((client) => {
                  const selected = String(client.id) === form.client_id
                  return <button key={client.id} type="button" aria-pressed={selected} className={`proposal-client-option${selected ? ' selected' : ''}`} onClick={() => selectClient(String(client.id))}>
                    <span className="proposal-client-option__icon"><Building2 size={17} /></span>
                    <span><strong>{client.name}</strong><small>{client.company || 'Independent client'}</small><em>{[client.email, client.phone].filter(Boolean).join(' · ') || 'No contact details'}</em></span>
                    {selected && <Check size={17} />}
                  </button>
                })}
                {!clientError && !availableClients.length && <p className="proposal-client-empty">No client records match this search. Choose <strong>New client</strong> to add one.</p>}
              </div>
            </> : <div className="proposal-new-client form-grid">
              <Input label="Client name" value={form.client_name} required error={clientMode === 'new' ? clientValidationError : ''} onChange={(event) => { setClientValidationError(''); setForm({ ...form, client_name: event.target.value }) }} />
              <Input label="Company" value={form.client_company} optional onChange={(event) => setForm({ ...form, client_company: event.target.value })} />
              <Input label="Client email" type="email" value={form.client_email} optional onChange={(event) => setForm({ ...form, client_email: event.target.value })} />
              <Input label="Client phone" type="tel" value={form.client_phone} optional onChange={(event) => setForm({ ...form, client_phone: event.target.value })} />
              <Input className="form-grid__full" label="Client address" value={form.client_address} optional onChange={(event) => setForm({ ...form, client_address: event.target.value })} />
              <p className="proposal-new-client__note form-grid__full"><UserPlus size={16} />This creates one reusable client record and links this proposal to it automatically.</p>
            </div>}
            {clientValidationError && clientMode === 'existing' && <p id="proposal-client-error" className="field__error proposal-client-error" role="alert">{clientValidationError}</p>}
          </section>
          <Input label="Proposal title" value={form.title} required onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Vehicle Management & ERP Proposal" />
          <Input label="Quotation reference" value={form.reference} optional={editing === 'new'} required={Boolean(editingExisting)} onChange={(event) => setForm({ ...form, reference: event.target.value })} placeholder="Generated automatically if blank" />
          <div className="proposal-code-field form-grid__full">
            <div className="proposal-code-field__head">
              <div><span className="field__label">Complete proposal HTML</span><small>{form.html_content.length.toLocaleString()} characters</small></div>
              <Button type="button" size="sm" variant="secondary" icon={showEditorPreview ? Code2 : Eye} disabled={!form.html_content.trim()} onClick={() => setShowEditorPreview((value) => !value)}>{showEditorPreview ? 'Show code' : 'Preview HTML'}</Button>
            </div>
            {showEditorPreview
              ? <iframe className="proposal-preview-frame" title="Proposal draft preview" sandbox={PROPOSAL_SANDBOX} referrerPolicy="no-referrer" srcDoc={prepareProposalHtml(form.html_content)} />
              : <Textarea aria-label="Complete proposal HTML" className="proposal-html-input" value={form.html_content} onChange={(event) => setForm({ ...form, html_content: event.target.value })} rows={22} spellCheck={false} placeholder={'<!DOCTYPE html>\n<html lang="en">\n  ...\n</html>'} required />}
          </div>
          <div className="proposal-safety-note form-grid__full"><ShieldCheck size={18} /><p><strong>Isolated rendering</strong><span>Scripts and external assets can run inside the proposal, but cannot access this admin portal or its session. Only paste HTML from a source you trust.</span></p></div>
        </form>
      </Modal>

      <Modal open={Boolean(previewing)} onClose={() => setPreviewing(null)} size="xl" title={previewing?.title || 'Proposal preview'} description="This is the same isolated document your client will see." footer={<Button variant="ghost" onClick={() => setPreviewing(null)}>Close preview</Button>}>
        {previewing && <iframe className="proposal-preview-frame proposal-preview-frame--large" title={`${previewing.title} preview`} sandbox={PROPOSAL_SANDBOX} referrerPolicy="no-referrer" srcDoc={prepareProposalHtml(previewing.html_content || '')} />}
      </Modal>

      <Modal open={Boolean(shared)} onClose={() => setShared(null)} title="Send proposal & quotation" description="Copy the private link, send it by WhatsApp or email, or use configured direct email delivery." size="lg">
        {shared && sharedMessage && <><SharePanel url={shared.share_url} title={sharedMessage.subject} phone={shared.client_phone} email={shared.client_email} message={sharedMessage.body} /><div className="document-toolbar"><Button variant="danger" loading={sharing === shared.id} onClick={() => void share(shared, true)}>Replace private link</Button></div><p className="field-hint">The current link stays valid without an expiry date. Replace it only when the previous link must stop working.</p></>}
      </Modal>

      <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={remove} loading={deletingBusy} title={`Delete ${deleting?.title || 'proposal'}?`} description="Remove this proposal from the workspace and immediately disable its public link." confirmLabel="Delete proposal" warning="The client will no longer be able to open this link." />
    </div>
  )
}
