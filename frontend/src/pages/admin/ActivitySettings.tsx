import { Activity, Check, Clipboard, Cloud, Database, ExternalLink, FileCheck2, Globe2, KeyRound, LogOut, RefreshCw, Search, ShieldCheck, UserRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Avatar, Button, EmptyState, ErrorState, LoadingState, PageHeader, SearchInput, Select, StatusPill } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { api } from '../../lib/api'
import { formatDate, formatRelative, titleCase } from '../../lib/format'
import type { AuditEvent } from '../../lib/types'
import { AccountSettings } from '../../components/AccountSettings'

const eventIcon = (action: string) => action.toLowerCase().includes('sign') ? FileCheck2 : action.toLowerCase().includes('auth') || action.toLowerCase().includes('login') ? KeyRound : action.toLowerCase().includes('portfolio') ? Globe2 : Activity

export function ActivityPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setEvents((await api.audit()).items) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Activity could not be loaded.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const types = useMemo(() => [...new Set(events.map((event) => event.action.split(/[ .:_-]/)[0].toLowerCase()).filter(Boolean))], [events])
  const filtered = useMemo(() => events.filter((event) => (!query || [event.action, event.actor, event.actor_email, event.target, event.details].join(' ').toLowerCase().includes(query.toLowerCase())) && (type === 'all' || event.action.toLowerCase().startsWith(type))), [events, query, type])

  return <div className="admin-page">
    <PageHeader eyebrow="Accountability" title="Activity log" description="A readable audit trail of changes across clients, documents and the public portfolio." action={<Button variant="secondary" icon={RefreshCw} loading={loading} onClick={load}>Refresh</Button>} />
    <section className="toolbar panel panel--flat"><SearchInput value={query} onChange={setQuery} placeholder="Search action, person or record…" label="Search activity" /><div className="toolbar__right"><Select aria-label="Filter activity type" value={type} onChange={(event) => setType(event.target.value)}><option value="all">All activity</option>{types.map((item) => <option value={item} key={item}>{titleCase(item)}</option>)}</Select></div></section>
    {loading && !events.length ? <LoadingState label="Loading activity…" /> : error ? <ErrorState message={error} onRetry={load} /> : filtered.length === 0 ? <EmptyState icon={Search} title={query || type !== 'all' ? 'No activity matches' : 'The audit trail is empty'} description={query || type !== 'all' ? 'Try a different search or event type.' : 'Important workspace actions will be recorded here.'} /> : <section className="activity-timeline panel">{filtered.map((event, index) => { const Icon = eventIcon(event.action); return <article key={event.id}><div className="activity-timeline__rail"><span><Icon size={17} /></span>{index < filtered.length - 1 && <i />}</div><div className="activity-timeline__body"><header><div><strong>{titleCase(event.action)}</strong><span>{event.details || event.target}</span></div><time title={formatDate(event.created_at, { dateStyle: 'full', timeStyle: 'short' })}>{formatRelative(event.created_at)}</time></header><footer><span><UserRound size={13} />{event.actor || event.actor_email || 'System'}</span>{event.target && <span>Record · {event.target}</span>}</footer></div></article>})}</section>}
  </div>
}

export function SettingsPage() {
  const { user, logout } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const publicUrl = window.location.origin
  const [copied, setCopied] = useState(false)

  const copyUrl = async () => {
    await navigator.clipboard.writeText(publicUrl)
    setCopied(true); toast('Public website address copied.', 'success'); window.setTimeout(() => setCopied(false), 1800)
  }

  const signOut = async () => { await logout(); navigate('/admin/login', { replace: true }) }

  return <div className="admin-page settings-page">
    <PageHeader eyebrow="Workspace" title="Settings" description="Account, deployment and integration details for this Hich Studio workspace." />
    <AccountSettings />
    <div className="settings-grid">
      <section className="panel settings-profile"><header><span><UserRound size={19} /></span><div><h2>Administrator profile</h2><p>Your identity comes from the secure backend session.</p></div></header><div className="settings-profile__person"><Avatar name={user?.name || user?.email} image={user?.avatar_url} size="lg" /><div><strong>{user?.name || 'Hich administrator'}</strong><span>{user?.email}</span><StatusPill status={user?.role || 'admin'} /></div></div><dl><div><dt>User ID</dt><dd>{String(user?.id || '—')}</dd></div><div><dt>Access level</dt><dd>{titleCase(user?.role || 'administrator')}</dd></div><div><dt>Authentication</dt><dd>Secure cookie session</dd></div></dl></section>
      <section className="panel settings-public"><header><span><Globe2 size={19} /></span><div><h2>Public website</h2><p>Your portfolio and secure client routes share this origin.</p></div></header><div className="settings-url"><span>{publicUrl}</span><button className="icon-button" type="button" onClick={copyUrl} aria-label="Copy public website address">{copied ? <Check size={17} /> : <Clipboard size={17} />}</button><a className="icon-button" href="/" target="_blank" aria-label="Open public website"><ExternalLink size={17} /></a></div><div className="settings-route"><span>/</span><p><strong>Portfolio</strong><small>Published work and studio information</small></p></div><div className="settings-route"><span>/sign/…</span><p><strong>Agreement signing</strong><small>Token-protected client experience</small></p></div></section>
      <section className="panel settings-integrations"><header><span><Cloud size={19} /></span><div><h2>System connections</h2><p>Frontend readiness for the Python and Supabase stack.</p></div></header><div className="integration-row"><span className="integration-row__icon"><Database size={18} /></span><div><strong>Backend API</strong><small>Same-origin /api routes</small></div><span className="connection-state"><i /> Configured</span></div><div className="integration-row"><span className="integration-row__icon"><ShieldCheck size={18} /></span><div><strong>Authentication</strong><small>HTTP-only cookie transport</small></div><span className="connection-state"><i /> Protected</span></div><div className="integration-row"><span className="integration-row__icon"><Globe2 size={18} /></span><div><strong>Media storage</strong><small>Portfolio image upload endpoint</small></div><span className="connection-state"><i /> Ready</span></div></section>
      <section className="panel settings-security"><header><span><ShieldCheck size={19} /></span><div><h2>Security & access</h2><p>Keep administrative access private and auditable.</p></div></header><ul><li><Check size={15} /> No credentials are stored in frontend code</li><li><Check size={15} /> Admin pages require a verified backend session</li><li><Check size={15} /> Public signing uses individual secure tokens</li><li><Check size={15} /> Sensitive changes are represented in the audit trail</li></ul><Button variant="danger" icon={LogOut} onClick={signOut}>Sign out of this device</Button></section>
    </div>
  </div>
}
