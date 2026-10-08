import {
  Activity,
  Bell,
  BriefcaseBusiness,
  ChevronRight,
  ClipboardList,
  Command,
  FileCheck2,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { formatCurrency, formatDate, getClientName } from '../lib/format'
import { api } from '../lib/api'
import { Avatar, LoadingState, Modal } from './ui'
import { Brand } from './Brand'

const navItems = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/clients', label: 'Clients', icon: Users },
  { to: '/admin/agreements', label: 'Agreements', icon: FileCheck2 },
  { to: '/admin/invoices', label: 'Invoices', icon: FileText },
  { to: '/admin/portfolio', label: 'Portfolio', icon: BriefcaseBusiness },
  { to: '/admin/operations', label: 'Operations', icon: ClipboardList },
  { to: '/admin/activity', label: 'Activity', icon: Activity },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
]

type SearchResult = { id: string; title: string; detail: string; category: string; destination: string; icon: typeof Users }

function WorkspaceSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [records, setRecords] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setQuery(''); setActive(0); setLoading(true); setError(''); setRecords([])
    void Promise.allSettled([api.clients.list(), api.agreements.list(), api.invoices.list(), api.portfolio.list()]).then(([clients, agreements, invoices, portfolio]) => {
      if (cancelled) return
      const results: SearchResult[] = []
      if (clients.status === 'fulfilled') clients.value.items.forEach((client) => results.push({ id: `client-${client.id}`, title: client.name, detail: [client.company, client.phone, client.email].filter(Boolean).join(' · '), category: 'Client', destination: `/admin/clients?search=${encodeURIComponent(client.name)}`, icon: Users }))
      if (agreements.status === 'fulfilled') agreements.value.items.forEach((agreement) => results.push({ id: `agreement-${agreement.id}`, title: agreement.reference || agreement.title, detail: [agreement.project_title || agreement.title, getClientName(agreement.client, agreement.client_name), agreement.status].filter(Boolean).join(' · '), category: 'Agreement', destination: `/admin/agreements?search=${encodeURIComponent(agreement.reference || agreement.title)}`, icon: FileCheck2 }))
      if (invoices.status === 'fulfilled') invoices.value.items.forEach((invoice) => results.push({ id: `invoice-${invoice.id}`, title: invoice.reference || `Invoice ${invoice.id}`, detail: [getClientName(invoice.client, invoice.client_name), formatCurrency(invoice.amount, invoice.currency || 'LKR'), invoice.status].join(' · '), category: 'Invoice', destination: `/admin/invoices?search=${encodeURIComponent(invoice.reference || String(invoice.id))}`, icon: FileText }))
      if (portfolio.status === 'fulfilled') portfolio.value.items.forEach((project) => results.push({ id: `project-${project.id}`, title: project.title, detail: [project.category, project.published ? 'Published' : 'Draft'].filter(Boolean).join(' · '), category: 'Project', destination: `/admin/portfolio?search=${encodeURIComponent(project.title)}`, icon: BriefcaseBusiness }))
      setRecords(results)
      const failures = [clients, agreements, invoices, portfolio].filter((result) => result.status === 'rejected').length
      if (failures) setError(failures === 4 ? 'Workspace records could not be loaded. Close search and try again.' : 'Some records could not be loaded. Available results are shown below.')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open])
  const results = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return navItems.map(({ to, label, icon }) => ({ id: to, title: label, detail: `Open ${label.toLowerCase()}`, category: 'Workspace', destination: to, icon }))
    return records.filter((record) => words.every((word) => `${record.title} ${record.detail} ${record.category}`.toLowerCase().includes(word))).slice(0, 30)
  }, [query, records])
  const select = (record: SearchResult) => { onClose(); navigate(record.destination) }
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => { document.getElementById(`workspace-result-${active}`)?.scrollIntoView({ block: 'nearest' }) }, [active])
  return <Modal open={open} onClose={onClose} title="Find it in your workspace" description="Search by client name, phone, project, agreement or invoice ID." size="md">
    <div className="command-search"><Search size={22} /><input data-autofocus role="combobox" aria-label="Search workspace" aria-expanded="true" aria-controls="workspace-search-results" aria-autocomplete="list" aria-activedescendant={results[active] ? `workspace-result-${active}` : undefined} value={query} placeholder="What are you looking for?" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => results.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0) }
      if (event.key === 'Enter' && results[active]) { event.preventDefault(); select(results[active]) }
    }} /><kbd>ESC</kbd></div>
    {error && <p className="command-warning" role="status">{error}</p>}
    <p className="command-label">{query ? `${results.length}${results.length === 30 ? '+' : ''} matching results` : 'Jump to'}</p>
    {loading && query ? <LoadingState compact label="Searching your workspace…" /> : <div id="workspace-search-results" className="command-results" role="listbox" aria-label="Search results">{results.map((record, index) => <button type="button" role="option" id={`workspace-result-${index}`} key={record.id} className={`command-result${active === index ? ' command-result--active' : ''}`} aria-selected={active === index} onMouseEnter={() => setActive(index)} onClick={() => select(record)}><span className="command-result__icon"><record.icon size={19} /></span><span><strong>{record.title}</strong><small>{record.detail}</small></span><em>{record.category}</em><ChevronRight size={16} /></button>)}</div>}
    {!loading && query && !results.length && <div className="command-empty"><Search size={28} /><strong>No matches found</strong><p>Try a different name, phone number or document reference.</p></div>}
    <footer className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd> to open</span><span>Private workspace search</span></footer>
  </Modal>
}

export function AdminLayout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('hich-sidebar-collapsed') === 'true')
  const { user, logout } = useAuth()
  const { toast } = useToast()
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => { setMobileOpen(false) }, [location.pathname])
  useEffect(() => { localStorage.setItem('hich-sidebar-collapsed', String(collapsed)) }, [collapsed])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen((current) => !current) }
    }
    document.addEventListener('keydown', shortcut)
    return () => document.removeEventListener('keydown', shortcut)
  }, [])
  useEffect(() => {
    if (!mobileOpen) return
    const previous = document.activeElement as HTMLElement | null
    drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
      if (event.key !== 'Tab') return
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>('button, a[href]')
      const first = focusable?.[0], last = focusable?.[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.body.classList.add('navigation-open')
    document.addEventListener('keydown', keydown)
    return () => { document.body.classList.remove('navigation-open'); document.removeEventListener('keydown', keydown); previous?.focus({ preventScroll: true }) }
  }, [mobileOpen])

  const onLogout = async () => {
    try {
      await logout()
      navigate('/admin/login', { replace: true })
      toast('You have been signed out.', 'success')
    } catch {
      navigate('/admin/login', { replace: true })
    }
  }

  const nav = (
    <>
      <div className="sidebar__brand"><Brand inverse compact={collapsed} to="/admin" /><span className="sidebar__workspace">CLIENT WORKSPACE</span></div>
      <nav className="sidebar__nav" aria-label="Admin navigation">
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`} title={collapsed ? label : undefined}>
            <Icon size={19} aria-hidden="true" /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar__footer">
        <a className="sidebar-link" href="/" target="_blank" rel="noopener noreferrer"><ChevronRight size={19} /><span>View website</span></a>
        <button className="sidebar-link" type="button" onClick={onLogout}><LogOut size={19} /><span>Sign out</span></button>
        <div className="sidebar-user">
          <Avatar name={user?.name || user?.email} image={user?.avatar_url} size="sm" />
          <div><strong>{user?.name || 'Administrator'}</strong><small>{user?.email}</small></div>
        </div>
      </div>
    </>
  )

  return (
    <div className={`admin-shell${collapsed ? ' admin-shell--collapsed' : ''}`}>
      <a className="skip-link" href="#workspace-content">Skip to workspace content</a>
      <aside className="sidebar">
        {nav}
        <button className="sidebar-collapse" type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronRight size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </aside>

      {mobileOpen && <div className="mobile-drawer__backdrop" onClick={() => setMobileOpen(false)} />}
      {mobileOpen && <aside ref={drawerRef} className="mobile-drawer mobile-drawer--open" role="dialog" aria-modal="true" aria-label="Workspace navigation">
        <button className="mobile-drawer__close icon-button" type="button" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={20} /></button>
        {nav}
      </aside>}

      <div className="admin-main">
        <header className="admin-topbar">
          <button className="icon-button mobile-menu" type="button" onClick={() => setMobileOpen(true)} aria-label="Open navigation" aria-expanded={mobileOpen}><Menu size={20} /></button>
          <div className="admin-topbar__date"><span>Hich Web / Workspace</span><strong>{formatDate(new Date().toISOString(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Colombo' })}</strong></div>
          <div className="admin-topbar__tools">
            <button className="workspace-search-trigger" type="button" onClick={() => setSearchOpen(true)} aria-label="Search workspace, Control or Command K"><Search size={17} /><span>Search anything</span><kbd><Command size={11} /> K</kbd></button>
            <Link className="icon-button notification-button" to="/admin/activity" aria-label="View recent activity"><Bell size={19} /></Link>
            <div className="topbar-user"><Avatar name={user?.name || user?.email} size="sm" /><span>{user?.name || user?.email?.split('@')[0]}</span></div>
          </div>
        </header>
        <main id="workspace-content" className="admin-content" tabIndex={-1}><Outlet /></main>
      </div>

      <nav className="mobile-admin-nav" aria-label="Primary admin navigation">
        {navItems.slice(0, 5).map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : ''}>
            <Icon size={19} /><span>{label === 'Agreements' ? 'Agreements' : label}</span>
          </NavLink>
        ))}
      </nav>
      <WorkspaceSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}
