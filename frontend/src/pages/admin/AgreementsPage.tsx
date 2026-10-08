import { Copy, Download, FileCheck2, Link2, MessageCircle, MoreHorizontal, Plus, RefreshCw, Send, Trash2 } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { SharePanel } from '../../components/SharePanel'
import { exportCsv } from '../../lib/sharing'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, ConfirmDialog, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, SearchInput, Select, StatusPill, Textarea } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { api } from '../../lib/api'
import { formatCurrency, formatDate, getClientName } from '../../lib/format'
import type { Agreement, AgreementTemplate, Client } from '../../lib/types'

type AgreementForm = Partial<Agreement> & { termsText?: string }
const blankAgreement: AgreementForm = { title: 'Website & Systems Development Agreement', project_title: '', client_id: '', description: '', termsText: '', amount: 0, currency: 'LKR', expires_at: '', status: 'draft' }

const getClient = (agreement: Agreement, clients: Client[]) => clients.find((client) => String(client.id) === String(agreement.client_id)) || (typeof agreement.client === 'object' ? agreement.client : undefined)

const termsText = (terms: Agreement['terms']) => Array.isArray(terms)
  ? terms.join('\n\n')
  : typeof terms === 'string'
    ? terms
    : terms && typeof terms === 'object'
      ? Object.entries(terms).map(([title, body]) => `${title}: ${typeof body === 'string' ? body : JSON.stringify(body)}`).join('\n\n')
      : ''

export function AgreementsPage() {
  const { toast } = useToast()
  const [agreements, setAgreements] = useState<Agreement[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(params.get('search') || '')
  useEffect(() => setQuery(params.get('search') || ''), [params])
  const [template, setTemplate] = useState<AgreementTemplate | null>(null)
  const [shared, setShared] = useState<Agreement | null>(null)
  const [status, setStatus] = useState('all')
  const [editing, setEditing] = useState<Agreement | 'new' | null>(null)
  const [form, setForm] = useState<AgreementForm>(blankAgreement)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Agreement | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [menu, setMenu] = useState<string | number | null>(null)
  const [sharing, setSharing] = useState<string | number | null>(null)
  const [loadingClients, setLoadingClients] = useState(false)
  const clientFilter = params.get('client') || ''

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [agreementResult, clientResult, templateResult] = await Promise.all([api.agreements.list(), api.clients.list(), api.agreements.template()])
      setAgreements(agreementResult.items); setClients(clientResult.items)
      setTemplate(templateResult)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Agreements could not be loaded.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => agreements.filter((agreement) => {
    const name = getClientName(agreement.client, agreement.client_name)
    return (!clientFilter || String(agreement.client_id) === clientFilter) && (!query || [agreement.title, agreement.reference, agreement.project_title, name].join(' ').toLowerCase().includes(query.toLowerCase())) && (status === 'all' || agreement.status === status)
  }), [agreements, query, status, clientFilter])

  const refreshClients = useCallback(async () => {
    setLoadingClients(true)
    try { setClients((await api.clients.list()).items) }
    catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'Client records could not be refreshed.', 'error') }
    finally { setLoadingClients(false) }
  }, [toast])

  const openEditor = useCallback((agreement?: Agreement) => {
    const client = clients.find(item => String(item.id) === clientFilter)
    setEditing(agreement || 'new')
    setForm(agreement ? { ...agreement, termsText: termsText(agreement.terms) } : { ...blankAgreement, title: template?.title || blankAgreement.title, description: template?.description || '', termsText: termsText(template?.terms), client_id: client?.id || '', client_name: client?.name || '', client_phone: client?.phone || '', client_email: client?.email || '' })
    setMenu(null)
    void refreshClients()
  }, [clients, clientFilter, template, refreshClients])

  useEffect(() => {
    if (loading || error || params.get('create') !== '1') return
    openEditor()
    const next = new URLSearchParams(params)
    next.delete('create')
    setParams(next, { replace: true })
  }, [loading, error, params, openEditor, setParams])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    if (!form.title?.trim() || !form.client_name?.trim() || !form.client_phone?.trim() || !form.project_title?.trim() || !Number(form.amount)) return toast('Add the client name, phone, project name and budget.', 'error')
    setSaving(true)
    const payload: Partial<Agreement> = {
      title: form.title, reference: form.reference?.trim() || undefined,
      client_id: form.client_id || undefined, client_name: form.client_name,
      client_phone: form.client_phone, client_email: form.client_email || undefined,
      project_title: form.project_title, amount: Number(form.amount), currency: form.currency,
      description: form.description || undefined,
      terms: form.termsText === termsText(form.terms || template?.terms) ? (form.terms || template?.terms) : (form.termsText?.trim() || template?.terms),
      expected_version: editing === 'new' ? undefined : form.version,
      renewal_amount: Number(form.renewal_amount || 0), renewal_currency: form.renewal_currency || 'LKR', renewal_due_date: form.renewal_due_date || '',
      expires_at: form.expires_at ? new Date(`${form.expires_at.slice(0, 10)}T23:59:59+05:30`).toISOString() : '',
    }
    try {
      // An edited agreement can also be reassigned to a new shared client record.
      if (editing !== 'new' && !form.client_id) {
        const client = await api.clients.create({ name: form.client_name!.trim(), phone: form.client_phone!.trim(), email: form.client_email?.trim() || undefined, status: 'active' })
        payload.client_id = client.id
        setForm(current => ({ ...current, client_id: client.id }))
        setClients(current => [client, ...current])
      }
      const saved = editing === 'new' ? await api.agreements.create(payload) : await api.agreements.update((editing as Agreement).id, payload)
      setAgreements((current) => editing === 'new' ? [saved, ...current] : current.map((agreement) => agreement.id === saved.id ? saved : agreement))
      toast(editing === 'new' ? 'Agreement created as a draft.' : 'Agreement updated.', 'success')
      setEditing(null)
      void refreshClients()
      if (editing === 'new') await share(saved)
    } catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'Agreement could not be saved.', 'error') }
    finally { setSaving(false) }
  }

  const share = async (agreement: Agreement) => {
    setSharing(agreement.id)
    try {
      const response = agreement.share_url && agreement.status !== 'draft' ? { share_url: agreement.share_url } : await api.agreements.share(agreement.id)
      const link = response.share_url || ('url' in response ? response.url : undefined) || ('token' in response && response.token ? `${window.location.origin}/sign/${response.token}` : undefined)
      if (!link) throw new Error('The server did not return a signing link.')
      const updated = { ...agreement, share_url: link, status: agreement.status === 'draft' ? 'sent' : agreement.status }
      setAgreements(current => current.map(item => item.id === agreement.id ? updated : item))
      setShared(updated)
    } catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'A signing link could not be created.', 'error') }
    finally { setSharing(null); setMenu(null) }
  }

  const duplicate = (agreement: Agreement) => {
    setEditing('new')
    setForm({ ...blankAgreement, title: agreement.title, project_title: agreement.project_title, description: agreement.description, amount: agreement.amount, currency: agreement.currency, termsText: termsText(agreement.terms), renewal_amount: agreement.renewal_amount, renewal_currency: agreement.renewal_currency, renewal_due_date: agreement.renewal_due_date })
    setMenu(null)
  }

  const downloadPdf = async (agreement: Agreement) => {
    try { await api.agreements.pdf(agreement.id, agreement.reference || `agreement-${agreement.id}`); toast('PDF download started.', 'success') }
    catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'PDF could not be downloaded.', 'error') }
    setMenu(null)
  }

  const remove = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await api.agreements.remove(deleting.id)
      setAgreements((current) => deleting.status === 'draft' ? current.filter((item) => item.id !== deleting.id) : current.map((item) => item.id === deleting.id ? { ...item, status: 'void' } : item))
      toast(deleting.status === 'draft' ? 'Draft agreement deleted.' : 'Agreement voided.', 'success')
      setDeleting(null)
    }
    catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'Agreement could not be removed.', 'error') }
    finally { setDeleteBusy(false) }
  }

  return <div className="admin-page">
    <PageHeader eyebrow="Documents" title="Agreements" description="Add the project details, create a link and collect your client's signature." action={<Button icon={Plus} onClick={() => openEditor()}>New agreement</Button>} />
    {clientFilter && <div className="document-toolbar"><span>Agreements for {clients.find(client => String(client.id) === clientFilter)?.name || 'this client'}</span><Button variant="ghost" size="sm" onClick={() => { const next = new URLSearchParams(params); next.delete('client'); next.delete('search'); setParams(next) }}>Show all clients</Button></div>}
    <section className="agreement-summary">
      {['draft', 'sent', 'viewed', 'signed'].map((item) => <article key={item}><StatusPill status={item} /><strong>{agreements.filter((agreement) => agreement.status === item).length}</strong><small>{item === 'signed' ? 'Completed' : item === 'viewed' ? 'Awaiting signature' : item === 'sent' ? 'Link generated' : 'In preparation'}</small></article>)}
    </section>
    <section className="toolbar panel panel--flat"><SearchInput value={query} onChange={setQuery} placeholder="Search title, client or reference…" label="Search agreements" /><div className="toolbar__right"><Button variant="ghost" size="sm" icon={Download} disabled={!filtered.length} onClick={() => exportCsv('hich-agreements.csv', filtered.map(a => ({ Reference: a.reference, Client: a.client_name, Phone: a.client_phone, Project: a.project_title, Budget: a.amount, Currency: a.currency, Status: a.status, Signed: a.signed_at })))}>Export</Button><Select aria-label="Filter agreement status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="draft">Draft</option><option value="sent">Sent</option><option value="viewed">Viewed</option><option value="signed">Signed</option><option value="expired">Expired</option><option value="void">Void</option></Select><Button variant="ghost" size="sm" icon={RefreshCw} loading={loading} onClick={load}>Refresh</Button></div></section>
    {loading && !agreements.length ? <LoadingState label="Loading agreements…" /> : error ? <ErrorState message={error} onRetry={load} /> : filtered.length === 0 ? <EmptyState icon={FileCheck2} title={query || status !== 'all' ? 'No agreements match' : 'Create the first agreement'} description={query || status !== 'all' ? 'Adjust the search or filter to see more results.' : 'Prepare a professional agreement and send a secure signature link to your client.'} action={!query && status === 'all' ? <Button icon={Plus} onClick={() => openEditor()}>New agreement</Button> : undefined} /> : <div className="agreement-grid">{filtered.map((agreement) => {
      const client = getClient(agreement, clients)
      const name = getClientName(agreement.client, agreement.client_name)
      const shareable = !['signed', 'void'].includes(agreement.status)
      return <article className="agreement-card" key={agreement.id}>
        <header><span className="agreement-card__icon"><FileCheck2 size={21} /></span><StatusPill status={agreement.status} /><div className="more-menu"><button className="icon-button" type="button" onClick={() => setMenu(menu === agreement.id ? null : agreement.id)} aria-label={`More actions for ${agreement.title}`}><MoreHorizontal size={18} /></button>{menu === agreement.id && <div className="more-menu__popover">{shareable && <button onClick={() => openEditor(agreement)}>Edit agreement</button>}{shareable && <button onClick={() => share(agreement)}><Copy size={15} /> Copy signing link</button>}<button onClick={() => duplicate(agreement)}><Copy size={15} /> Duplicate as new</button><button onClick={() => downloadPdf(agreement)}><Download size={15} /> Download PDF</button>{agreement.status !== 'signed' && agreement.status !== 'void' && <button className="danger" onClick={() => { setDeleting(agreement); setMenu(null) }}><Trash2 size={15} /> {agreement.status === 'draft' ? 'Delete draft' : 'Void agreement'}</button>}</div>}</div></header>
        <div className="agreement-card__copy"><span>{agreement.reference || `AGR-${agreement.id}`}</span><h3>{agreement.title}</h3><p>{name} · {agreement.project_title || 'General engagement'}</p></div>
        <dl><div><dt>Value</dt><dd>{formatCurrency(agreement.amount || 0, agreement.currency || 'LKR')}</dd></div><div><dt>Expires</dt><dd>{formatDate(agreement.expires_at)}</dd></div></dl>
        <footer>{shareable ? <><Button variant="secondary" size="sm" icon={Link2} loading={sharing === agreement.id} onClick={() => share(agreement)}>{agreement.status === 'draft' ? 'Create link' : 'Copy link'}</Button>{client?.phone && <Button variant="ghost" size="sm" icon={MessageCircle} onClick={() => share(agreement)}>WhatsApp</Button>}{!client?.phone && agreement.status === 'draft' && <span className="agreement-card__hint"><Send size={14} /> Ready to share</span>}</> : <span className="agreement-card__hint"><FileCheck2 size={14} /> {agreement.status === 'signed' ? 'Completed and immutable' : 'No longer active'}</span>}</footer>
      </article>
    })}</div>}

    <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing === 'new' ? 'Create an agreement' : 'Edit agreement'} description="The client will review this information before providing a secure signature." size="lg" footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="agreement-form" loading={saving}>{editing === 'new' ? 'Create signing link' : 'Save changes'}</Button></>}>
      <form id="agreement-form" className="form-grid" onSubmit={save}>
        <Select className="form-grid__full" label="Client record" hint={loadingClients ? 'Refreshing client records…' : 'Clients created in invoices are available here. Select a client to fill their details.'} value={String(form.client_id || '')} onChange={event => { const client = clients.find(c => String(c.id) === event.target.value); setForm({ ...form, client_id: event.target.value, client_name: client?.name || '', client_phone: client?.phone || '', client_email: client?.email || '' }) }}><option value="">New client - enter details below</option>{clients.map(client => <option value={String(client.id)} key={client.id}>{client.company ? `${client.company} - ${client.name}` : client.name}</option>)}</Select>
        <Input label="Agreement ID" value={form.reference || ''} onChange={event => setForm({ ...form, reference: event.target.value })} placeholder="Auto-generated, or HICH-AGR-001" optional />
        <Input label="Client name" value={form.client_name || ''} onChange={event => setForm({ ...form, client_name: event.target.value })} required />
        <Input label="Client phone number" type="tel" value={form.client_phone || ''} onChange={event => setForm({ ...form, client_phone: event.target.value })} placeholder="+94 77 123 4567" required />
        <Input label="Client email" type="email" value={form.client_email || ''} onChange={event => setForm({ ...form, client_email: event.target.value })} optional />
        <Input label="Agreement title" value={form.title || ''} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="E-commerce design & development" required />
        <Input label="Project title" value={form.project_title || ''} onChange={(event) => setForm({ ...form, project_title: event.target.value })} placeholder="Project or engagement name" required />
        <Input label="Project budget" type="number" min="0.01" step="0.01" required value={form.amount || ''} onChange={(event) => setForm({ ...form, amount: Number(event.target.value) })} />
        <Select label="Currency" value={form.currency || 'LKR'} onChange={(event) => setForm({ ...form, currency: event.target.value })}><option value="LKR">LKR</option><option value="USD">USD</option><option value="GBP">GBP</option><option value="EUR">EUR</option></Select>
        <Input label="Signing deadline" type="date" value={form.expires_at?.slice(0, 10) || ''} onChange={(event) => setForm({ ...form, expires_at: event.target.value })} optional />
        <Textarea className="form-grid__full" label="Project scope and included deliverables" value={form.description || ''} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={4} placeholder="Describe the engagement, deliverables and intended outcome…" />
        <Input label="Annual renewal amount" type="number" step="0.01" min="0" value={form.renewal_amount ?? ''} onChange={event => setForm({ ...form, renewal_amount: Number(event.target.value) })} placeholder="Hosting, domain and maintenance" optional />
        <Select label="Renewal currency" value={form.renewal_currency || 'LKR'} onChange={event => setForm({ ...form, renewal_currency: event.target.value })}><option value="LKR">LKR - Sri Lankan rupee</option><option value="USD">USD - US dollar</option><option value="GBP">GBP - British pound</option></Select>
        <Input className="form-grid__full" label="Service expiry / renewal date" type="date" value={form.renewal_due_date?.slice(0, 10) || ''} onChange={event => setForm({ ...form, renewal_due_date: event.target.value })} hint="Hosting and domain expiry, separate from the signing deadline." optional />
        <details className="form-grid__full clause-nav"><summary>Review or customise the general agreement</summary><Textarea label="Agreement terms" value={form.termsText || ''} onChange={(event) => setForm({ ...form, termsText: event.target.value })} rows={16} hint="The complete general terms are included automatically. Customise them for your accepted scope and fees." /></details>
        <p className="form-grid__full field-hint">{template?.review_note || 'Review the scope, fees and general terms before sharing. Obtain local legal review before using the template commercially.'}</p>
      </form>
    </Modal>
    <Modal open={Boolean(shared)} onClose={() => setShared(null)} title="Share agreement" description="The link opens the project summary, full terms and signature form.">{shared?.share_url && <SharePanel url={shared.share_url} title={`${shared.reference || shared.title} - ${shared.project_title}`} phone={shared.client_phone} email={shared.client_email} />}</Modal>
    <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={remove} loading={deleteBusy} title={`${deleting?.status === 'draft' ? 'Delete draft' : 'Void agreement'} “${deleting?.title || 'agreement'}”?`} description={deleting?.status === 'draft' ? 'This unused draft will be permanently removed.' : 'The agreement stays in the audit record, but its signing link will stop working.'} confirmLabel={deleting?.status === 'draft' ? 'Delete draft' : 'Void agreement'} warning={deleting?.status === 'draft' ? 'This action cannot be undone.' : 'A void agreement remains available for historical accuracy.'} />
  </div>
}
