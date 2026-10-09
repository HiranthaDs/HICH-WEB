import { Archive, Building2, Mail, MessageCircle, MoreHorizontal, Phone, Plus, RefreshCw, UserRound, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SharePanel } from '../../components/SharePanel'
import { Button, ConfirmDialog, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, SearchInput, Select, StatusPill, Textarea } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { api, deletionPin } from '../../lib/api'
import { formatCurrency, formatDate } from '../../lib/format'
import { renewalMessage } from '../../lib/messages'
import { whatsappUrl } from '../../lib/sharing'
import type { Client, ClientProfile, Invoice } from '../../lib/types'

const blankClient: Partial<Client> = { name: '', email: '', company: '', phone: '', address: '', status: 'active', notes: '' }
const clientValue = (client: Client) => Object.entries(client.totals_by_currency || { LKR: client.total_value || 0 }).map(([currency, total]) => formatCurrency(total, currency)).join(' / ') || formatCurrency(0)

export function ClientsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { toast } = useToast()
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState(searchParams.get('search') || '')
  useEffect(() => { setQuery(searchParams.get('search') || ''); setStatus('all') }, [searchParams])
  const [status, setStatus] = useState('all')
  const [editing, setEditing] = useState<Client | 'new' | null>(null)
  const [form, setForm] = useState<Partial<Client>>(blankClient)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Client | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [profile, setProfile] = useState<ClientProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileRevision, setProfileRevision] = useState(0)
  const [renewalInvoice, setRenewalInvoice] = useState<Invoice | null>(null)
  const loadGeneration = useRef(0)
  const profileId = searchParams.get('client')

  const openProfile = (client: Client) => setSearchParams(current => { const next = new URLSearchParams(current); next.set('client', String(client.id)); return next })
  const closeProfile = () => { setRenewalInvoice(null); setSearchParams(current => { const next = new URLSearchParams(current); next.delete('client'); return next }) }

  useEffect(() => {
    setRenewalInvoice(null)
    if (!profileId) { setProfile(null); return }
    let cancelled = false
    setProfile(null); setProfileLoading(true); setProfileError('')
    void api.clients.profile(profileId).then(result => { if (!cancelled) setProfile(result) })
      .catch(requestError => { if (!cancelled) setProfileError(requestError instanceof Error ? requestError.message : 'Client profile could not be loaded.') })
      .finally(() => { if (!cancelled) setProfileLoading(false) })
    return () => { cancelled = true }
  }, [profileId, profileRevision])

  const profileTotals = useMemo(() => Object.entries((profile?.invoices || []).filter(invoice => invoice.status !== 'void' && invoice.invoice_kind !== 'renewal').reduce<Record<string, { total: number; paid: number; balance: number }>>((totals, invoice) => {
    const currency = invoice.currency || 'LKR'
    const current = totals[currency] || { total: 0, paid: 0, balance: 0 }
    const value = Number(invoice.amount || 0), paid = Number(invoice.paid_amount || 0)
    totals[currency] = { total: current.total + value, paid: current.paid + paid, balance: current.balance + Math.max(0, value - paid) }
    return totals
  }, {})), [profile])
  const profileRenewals = useMemo(() => (profile?.invoices || []).filter(invoice => invoice.invoice_kind !== 'renewal' && invoice.status !== 'void' && Number(invoice.renewal_amount) > 0), [profile])
  const renewalCommunication = useMemo(() => {
    if (!profile || !renewalInvoice) return null
    const generated = renewalMessage({
      client_name: profile.client.name,
      reference: renewalInvoice.reference,
      amount: renewalInvoice.renewal_amount,
      currency: renewalInvoice.renewal_currency || renewalInvoice.currency,
      due_date: renewalInvoice.renewal_due_date,
      project_title: renewalInvoice.project_title,
      payment_instructions: renewalInvoice.payment_instructions,
    })
    return generated
  }, [profile, renewalInvoice])

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    setLoading(true); setError('')
    try {
      const result = await api.clients.list()
      if (generation === loadGeneration.current) setClients(result.items)
    }
    catch (requestError) { if (generation === loadGeneration.current) setError(requestError instanceof Error ? requestError.message : 'Clients could not be loaded.') }
    finally { if (generation === loadGeneration.current) setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => clients.filter((client) => {
    const haystack = [client.name, client.company, client.email, client.phone].join(' ').toLowerCase()
    return (!query || haystack.includes(query.toLowerCase())) && (status === 'all' || client.status === status)
  }), [clients, query, status])

  const openEditor = (client?: Client) => {
    setEditing(client || 'new')
    setForm(client ? { ...client } : { ...blankClient })
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    if (!form.name?.trim()) return toast('Client name is required.', 'error')
    setSaving(true)
    try {
      const saved = editing === 'new' ? await api.clients.create(form) : await api.clients.update((editing as Client).id, form, form.status === 'archived' && (editing as Client).status !== 'archived' ? deletionPin() : undefined)
      setClients((current) => editing === 'new' ? [saved, ...current] : current.map((client) => client.id === saved.id ? { ...client, ...saved } : client))
      toast(editing === 'new' ? 'Client added to the workspace.' : 'Client details updated.', 'success')
      setEditing(null)
    } catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'Client could not be saved.', 'error') }
    finally { setSaving(false) }
  }

  const remove = async (pin: string) => {
    if (!deleting) return
    setDeletingBusy(true)
    try {
      await api.clients.remove(deleting.id, pin)
      setClients((current) => current.filter((client) => client.id !== deleting.id))
      toast('Client deleted from the workspace.', 'success')
      setDeleting(null)
    } catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'Client could not be archived.', 'error') }
    finally { setDeletingBusy(false) }
  }

  return (
    <div className="admin-page">
      <PageHeader eyebrow="Relationships" title="Clients" description="Open a client profile to see their contact details, invoices, agreements and renewals." action={<Button icon={Plus} onClick={() => openEditor()}>Add client</Button>} />
      <section className="toolbar panel panel--flat"><SearchInput value={query} onChange={setQuery} placeholder="Search name, company or contact…" label="Search clients" /><div className="toolbar__right"><Select aria-label="Filter client status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="lead">Lead</option><option value="archived">Archived</option></Select><Button variant="ghost" size="sm" icon={RefreshCw} onClick={load} loading={loading}>Refresh</Button></div></section>
      {error && clients.length > 0 && <div className="data-notice" role="status"><span>Refresh failed: {error}. The last successfully loaded clients remain visible.</span><Button variant="ghost" size="sm" onClick={load}>Retry</Button></div>}
      {loading && !clients.length ? <LoadingState label="Loading clients…" /> : error && !clients.length ? <ErrorState title="Clients could not be loaded" message={error} onRetry={load} /> : filtered.length === 0 ? <EmptyState icon={Users} title={query || status !== 'all' ? 'No matching clients' : 'Your client directory is ready'} description={query || status !== 'all' ? 'Try a different search or status filter.' : 'Create a client while making an invoice, or add one here.'} action={!query && status === 'all' ? <Button icon={Plus} onClick={() => openEditor()}>Add first client</Button> : undefined} /> : <>
        <div className="data-table-wrap panel">
          <table className="data-table"><thead><tr><th>Client</th><th>Contact</th><th>Status</th><th>Projects</th><th>Lifetime value</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{filtered.map((client) => <tr key={client.id}><td><div className="person-cell"><div><button type="button" className="client-profile-trigger" onClick={() => openProfile(client)}>{client.name}</button><span><Building2 size={12} /> {client.company || 'Independent'}</span></div></div></td><td><div className="contact-cell">{client.email && <a href={`mailto:${client.email}`}><Mail size={13} />{client.email}</a>}{client.phone && <a href={`tel:${client.phone}`}><Phone size={13} />{client.phone}</a>}{!client.email && !client.phone && <span>—</span>}</div></td><td><StatusPill status={client.status} /></td><td>{client.project_count ?? 0}</td><td>{clientValue(client)}</td><td>{formatDate(client.created_at)}</td><td><div className="row-actions"><button className="icon-button" type="button" onClick={() => openEditor(client)} aria-label={`Edit ${client.name}`}><MoreHorizontal size={18} /></button><button className="icon-button icon-button--danger" type="button" onClick={() => setDeleting(client)} aria-label={`Delete ${client.name}`}><Archive size={17} /></button></div></td></tr>)}</tbody></table>
        </div>
        <div className="mobile-card-list">{filtered.map((client) => <article className="mobile-data-card" key={client.id}><header><div className="person-cell"><div><button type="button" className="client-profile-trigger" onClick={() => openProfile(client)}>{client.name}</button><span>{client.company || 'Independent'}</span></div></div><StatusPill status={client.status} /></header><div className="mobile-data-card__details"><span><Mail size={14} /> {client.email || 'No email'}</span><span><Phone size={14} /> {client.phone || 'No phone'}</span><span><UserRound size={14} /> {client.project_count || 0} projects</span></div><footer><Button variant="secondary" size="sm" onClick={() => openProfile(client)}>View profile</Button><Button variant="ghost" size="sm" onClick={() => openEditor(client)}>Edit details</Button><button className="icon-button icon-button--danger" type="button" onClick={() => setDeleting(client)} aria-label={`Delete ${client.name}`}><Archive size={16} /></button></footer></article>)}</div>
      </>}

      <Modal open={Boolean(profileId)} onClose={closeProfile} size="xl" title={profile?.client.name || 'Client profile'} description={profile?.client.company || 'Contact details and complete project history'} footer={profile ? <><Button variant="ghost" onClick={closeProfile}>Close</Button><Button onClick={() => { closeProfile(); openEditor(profile.client) }}>Edit client details</Button></> : undefined}>
        {profileLoading ? <LoadingState label="Loading client profile…" /> : profileError ? <ErrorState title="Client profile unavailable" message={profileError} onRetry={() => setProfileRevision(value => value + 1)} /> : profile ? <div className="client-profile">
          <div className="client-profile__header"><div><h3>{profile.client.name}</h3><p>{profile.client.company || 'Independent client'}</p></div><StatusPill status={profile.client.status} /></div>
          <dl className="document-summary">
            <div><dt>Email</dt><dd>{profile.client.email ? <a href={`mailto:${profile.client.email}`}>{profile.client.email}</a> : 'Not provided'}</dd></div>
            <div><dt>Phone</dt><dd>{profile.client.phone ? <a href={`tel:${profile.client.phone}`}>{profile.client.phone}</a> : 'Not provided'}</dd></div>
            <div><dt>Address</dt><dd className="preserve-lines">{profile.client.address || 'Not provided'}</dd></div>
            <div><dt>Client since</dt><dd>{formatDate(profile.client.created_at)}</dd></div>
            <div><dt>Profile updated</dt><dd>{formatDate(profile.client.updated_at || profile.client.created_at)}</dd></div>
            <div><dt>Documents</dt><dd>{profile.invoices.length} invoices · {profile.agreements.length} agreements</dd></div>
          </dl>
          <div className="document-toolbar">
            {profile.client.phone && <><a className="button button--secondary button--sm" href={`tel:${profile.client.phone}`}><Phone size={16} />Call client</a><a className="button button--secondary button--sm" href={whatsappUrl(profile.client.phone, `Hello ${profile.client.name},`)} target="_blank" rel="noopener noreferrer"><MessageCircle size={16} />WhatsApp</a></>}
            <Link className="button button--primary button--sm" to={`/admin/invoices?client=${encodeURIComponent(String(profile.client.id))}&create=1`}>Create invoice</Link>
            <Link className="button button--secondary button--sm" to={`/admin/agreements?client=${encodeURIComponent(String(profile.client.id))}&create=1`}>Create agreement</Link>
          </div>
          {profile.client.notes && <section className="agreement-section"><h3>Internal notes</h3><p className="preserve-lines">{profile.client.notes}</p></section>}
          <section className="agreement-section"><h3>Project totals</h3>{profileTotals.length ? <div className="client-profile-summary">{profileTotals.map(([currency, totals]) => <article key={currency}><strong>{currency}</strong><dl><div><dt>Total project amount</dt><dd>{formatCurrency(totals.total, currency)}</dd></div><div><dt>Paid</dt><dd>{formatCurrency(totals.paid, currency)}</dd></div><div><dt>Balance</dt><dd>{formatCurrency(totals.balance, currency)}</dd></div></dl></article>)}</div> : <p>No active invoices yet.</p>}<p className="field-hint">Totals exclude void invoices. Renewals are listed separately below.</p></section>
          <section className="agreement-section"><h3>Renewals ({profileRenewals.length})</h3><div className="client-document-list">{profileRenewals.map(invoice => <article className="client-document-card" key={invoice.id}><header><div><strong>{invoice.project_title || 'Domain & hosting renewal'}</strong><small>{invoice.reference || 'Project invoice'}</small></div></header><dl className="document-summary"><div><dt>Renewal amount</dt><dd>{formatCurrency(Number(invoice.renewal_amount), invoice.renewal_currency || invoice.currency)}</dd></div><div><dt>Renewal / service expiry date</dt><dd>{formatDate(invoice.renewal_due_date)}</dd></div></dl><div className="document-toolbar"><Button variant="secondary" size="sm" icon={MessageCircle} disabled={!invoice.renewal_due_date} onClick={() => setRenewalInvoice(invoice)}>Send renewal message</Button><Link className="text-link" to={`/admin/invoices?client=${encodeURIComponent(String(profile.client.id))}&invoice=${encodeURIComponent(String(invoice.id))}`}>Open invoice</Link></div>{!invoice.renewal_due_date && <p className="field-hint">Add the service expiry / renewal date before sending this reminder.</p>}</article>)}</div>{!profileRenewals.length && <p>No annual renewals are recorded for this client yet.</p>}</section>
          <section className="agreement-section"><h3>Invoices ({profile.invoices.length})</h3><div className="client-document-list">{profile.invoices.map(invoice => <article className="client-document-card" key={invoice.id}><header><div><strong>{invoice.project_title || 'Project invoice'}</strong><small>{invoice.reference}</small></div><StatusPill status={invoice.status} /></header><dl className="document-summary"><div><dt>Total project amount</dt><dd>{formatCurrency(Number(invoice.amount), invoice.currency)}</dd></div><div><dt>Paid</dt><dd>{formatCurrency(Number(invoice.paid_amount || 0), invoice.currency)}</dd></div><div><dt>Balance</dt><dd>{formatCurrency(Math.max(0, Number(invoice.amount) - Number(invoice.paid_amount || 0)), invoice.currency)}</dd></div><div><dt>Due</dt><dd>{formatDate(invoice.due_date)}</dd></div>{Number(invoice.renewal_amount) > 0 && <><div><dt>Annual renewal</dt><dd>{formatCurrency(Number(invoice.renewal_amount), invoice.renewal_currency || invoice.currency)}</dd></div><div><dt>Renewal date</dt><dd>{formatDate(invoice.renewal_due_date)}</dd></div></>}</dl><Link className="text-link" to={`/admin/invoices?client=${encodeURIComponent(String(profile.client.id))}&invoice=${encodeURIComponent(String(invoice.id))}`}>Open invoice</Link></article>)}</div>{!profile.invoices.length && <p>No invoices yet. Create the first invoice for this client above.</p>}</section>
          <section className="agreement-section"><h3>Payment history</h3><div className="client-document-list">{profile.invoices.flatMap(invoice => (invoice.payment_records || []).map(payment => <article key={payment.id} className="client-document-card"><header><div><strong>{formatCurrency(Number(payment.amount), payment.currency)}</strong><small>{invoice.reference} ? {invoice.project_title}</small></div><span>{formatDate(payment.paid_at)}</span></header><p>{payment.method || 'Payment'} ? {payment.reference || 'No transfer reference'}{invoice.status === 'void' ? ' ? Invoice voided; payment retained' : ''}</p></article>))}</div>{!profile.invoices.some(invoice => invoice.payment_records?.length) && <p>No cleared payment records yet.</p>}</section>
          <section className="agreement-section"><h3>Agreements ({profile.agreements.length})</h3><div className="client-document-list">{profile.agreements.map(agreement => <article className="client-document-card" key={agreement.id}><header><div><strong>{agreement.project_title || agreement.title}</strong><small>{agreement.reference || agreement.title}</small></div><StatusPill status={agreement.status} /></header><dl className="document-summary"><div><dt>Project amount</dt><dd>{agreement.amount != null ? formatCurrency(Number(agreement.amount), agreement.currency) : 'Not specified'}</dd></div><div><dt>Created</dt><dd>{formatDate(agreement.created_at)}</dd></div>{Number(agreement.renewal_amount) > 0 && <><div><dt>Annual renewal</dt><dd>{formatCurrency(Number(agreement.renewal_amount), agreement.renewal_currency || agreement.currency)}</dd></div><div><dt>Renewal date</dt><dd>{formatDate(agreement.renewal_due_date)}</dd></div></>}{agreement.signed_at && <><div><dt>Signed</dt><dd>{formatDate(agreement.signed_at)}</dd></div><div><dt>Signed by</dt><dd>{agreement.signer_name}{agreement.signer_job_role ? ` · ${agreement.signer_job_role}` : ''}</dd></div></>}</dl><Link className="text-link" to={`/admin/agreements?client=${encodeURIComponent(String(profile.client.id))}&search=${encodeURIComponent(agreement.reference || agreement.title)}`}>Open agreement</Link></article>)}</div>{!profile.agreements.length && <p>No agreements yet. Create an agreement using this client record above.</p>}</section>
        </div> : <ErrorState title="Client profile unavailable" message="No profile data was returned for this client. Try loading it again." onRetry={() => setProfileRevision(value => value + 1)} />}
      </Modal>

      <Modal open={Boolean(renewalInvoice)} onClose={() => setRenewalInvoice(null)} size="lg" title="Send renewal message" description="Review the renewal amount, date and client message before sending.">
        {profile && renewalInvoice && renewalCommunication && <><dl className="document-summary"><div><dt>Client</dt><dd>{profile.client.name}</dd></div><div><dt>Project</dt><dd>{renewalInvoice.project_title || 'Domain & hosting renewal'}</dd></div><div><dt>Invoice reference</dt><dd>{renewalInvoice.reference || 'Not assigned'}</dd></div><div><dt>Renewal amount</dt><dd>{formatCurrency(Number(renewalInvoice.renewal_amount), renewalInvoice.renewal_currency || renewalInvoice.currency)}</dd></div><div><dt>Renewal / service expiry date</dt><dd>{formatDate(renewalInvoice.renewal_due_date)}</dd></div></dl><SharePanel title={renewalCommunication.subject} phone={profile.client.phone} email={profile.client.email} message={renewalCommunication.body} /></>}
      </Modal>

      <Modal open={Boolean(editing)} onClose={() => { if (!saving) setEditing(null) }} title={editing === 'new' ? 'Add a client' : 'Edit client'} description="Contact details are used for agreements, invoices and reminders." footer={<><Button variant="ghost" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button><Button loading={saving} type="submit" form="client-form">{editing === 'new' ? 'Add client' : 'Save changes'}</Button></>}>
        <form id="client-form" className="form-grid" onSubmit={save}>
          <Input label="Client name" value={form.name || ''} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Full name" required />
          <Input label="Company" value={form.company || ''} onChange={(event) => setForm({ ...form, company: event.target.value })} placeholder="Company or organisation" optional />
          <Input label="Email address" type="email" value={form.email || ''} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="client@example.com" optional />
          <Input label="Phone number" type="tel" value={form.phone || ''} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="+94 …" hint="Include the country code for WhatsApp reminders." optional />
          <Select label="Relationship status" value={form.status || 'active'} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="active">Active</option><option value="lead">Lead</option><option value="archived">Archived</option></Select>
          <Textarea className="form-grid__full" label="Address" value={form.address || ''} onChange={event => setForm({ ...form, address: event.target.value })} rows={2} maxLength={1000} optional />
          <Textarea className="form-grid__full" label="Internal notes" value={form.notes || ''} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={4} placeholder="Helpful context for the team…" optional />
        </form>
      </Modal>
      <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={remove} loading={deletingBusy} title={`Delete ${deleting?.name || 'client'}?`} description="Remove this client from the directory. Existing financial and agreement records keep their original client details." confirmLabel="Delete client" warning="Use the deletion PIN to confirm removal from the workspace." />
    </div>
  )
}
