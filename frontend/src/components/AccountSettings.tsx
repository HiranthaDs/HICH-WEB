import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Modal, Select, StatusPill } from './ui'
import { api } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import type { PortalUser } from '../lib/types'

export function AccountSettings() {
  const { user, logout } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [users, setUsers] = useState<PortalUser[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [editing, setEditing] = useState<PortalUser | 'new' | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'staff'>('staff')
  const [active, setActive] = useState(true)
  const load = () => api.auth.users().then(setUsers).catch(e => setError(e.message))
  useEffect(() => { if (user?.role === 'admin') void load() }, [user?.role])
  const open = (account?: PortalUser) => {
    setEditing(account || 'new'); setName(account?.full_name || ''); setEmail(account?.email || '')
    setRole(account?.role || 'staff'); setActive(account?.active ?? true)
  }
  const changePassword = async (event: FormEvent) => {
    event.preventDefault()
    if (password !== confirm) return toast('The new passwords do not match.', 'error')
    setBusy(true)
    try {
      const result = await api.auth.changePassword(current, password)
      toast(result.message, 'success')
      await logout().catch(() => undefined)
      navigate('/admin/login', { replace: true })
    } catch (e) { toast(e instanceof Error ? e.message : 'Password could not be changed.', 'error') }
    finally { setBusy(false) }
  }
  const saveUser = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      if (editing === 'new') {
        const result = await api.auth.inviteUser({ email, full_name: name, role }); toast(result.message, 'success')
      } else if (editing) {
        await api.auth.updateUser(editing.id, { full_name: name, role, active }); toast('User access saved.', 'success')
      }
      setEditing(null); setError(''); await load()
    } catch (e) { toast(e instanceof Error ? e.message : 'User could not be saved.', 'error') }
    finally { setBusy(false) }
  }
  const recover = async (id: string) => {
    setBusy(true)
    try { toast((await api.auth.recoverUser(id)).message, 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Reset email failed.', 'error') }
    finally { setBusy(false) }
  }
  return <>
    <section className="panel account-panel"><h2>Change your password</h2><p>Verify your current password. You will sign in again after changing it.</p><form onSubmit={changePassword} className="form-grid">
      <Input label="Current password" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} />
      <Input label="New password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={password} onChange={e => setPassword(e.target.value)} hint="At least 12 characters; use a unique passphrase." />
      <Input label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} />
      <div><Button type="submit" loading={busy}>Change password</Button></div>
    </form></section>
    {user?.role === 'admin' && <section className="panel account-panel"><header className="panel__header"><div><h2>Portal users</h2><p>Staff manage daily work. Administrators also manage access.</p></div><Button onClick={() => open()}>Invite user</Button></header>{error && <p role="alert" className="negative">{error}</p>}<div className="client-document-list">{users.map(account => <article className="client-document-card" key={account.id}><header><div><strong>{account.full_name || account.email}</strong><small>{account.email}</small></div><StatusPill status={account.active ? account.role : 'archived'} /></header><div className="document-toolbar"><Button size="sm" variant="secondary" disabled={busy} onClick={() => open(account)}>Edit access</Button><Button size="sm" variant="ghost" loading={busy} disabled={!account.active} onClick={() => void recover(account.id)}>Send password reset</Button></div></article>)}</div></section>}
    <Modal open={Boolean(editing)} onClose={() => { if (!busy) setEditing(null) }} title={editing === 'new' ? 'Invite a portal user' : 'Edit user access'} description={editing === 'new' ? 'The user receives an email invitation and chooses their own password.' : 'Disabling access requires the deletion PIN and immediately blocks portal requests.'} footer={<><Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="user-access-form" loading={busy}>{editing === 'new' ? 'Send invitation' : 'Save access'}</Button></>}>
      <form id="user-access-form" className="form-grid" onSubmit={saveUser}><Input label="Full name" required minLength={2} maxLength={160} value={name} onChange={e => setName(e.target.value)} /><Input label="Email" type="email" required readOnly={editing !== 'new'} value={email} onChange={e => setEmail(e.target.value)} /><Select label="Role" value={role} onChange={e => setRole(e.target.value as 'admin' | 'staff')}><option value="staff">Staff</option><option value="admin">Administrator</option></Select>{editing !== 'new' && <Select label="Access" value={active ? 'active' : 'disabled'} onChange={e => setActive(e.target.value === 'active')}><option value="active">Active</option><option value="disabled">Disabled</option></Select>}</form>
    </Modal>
  </>
}
