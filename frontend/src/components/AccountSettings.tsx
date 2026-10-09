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
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [userSaveBusy, setUserSaveBusy] = useState(false)
  const [recoveringUserIds, setRecoveringUserIds] = useState<Set<string>>(() => new Set())
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [editing, setEditing] = useState<PortalUser | 'new' | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'staff'>('staff')
  const [active, setActive] = useState(true)
  const [inviteMode, setInviteMode] = useState('temporary')
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null)
  const generatePassword = () => 'Hw!' + Array.from(crypto.getRandomValues(new Uint8Array(20)), byte => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[byte % 64]).join('')
  const copyCredentials = async (value: string) => {
    try { await navigator.clipboard.writeText(value); toast('Copied. Share these credentials privately.', 'success') }
    catch { toast('Copy is unavailable. Select and copy the password manually.', 'error') }
  }
  const load = () => api.auth.users().then(setUsers).catch(e => setError(e.message))
  useEffect(() => { if (user?.role === 'admin') void load() }, [user?.role])
  const open = (account?: PortalUser) => {
    setEditing(account || 'new'); setName(account?.full_name || ''); setEmail(account?.email || '')
    setRole(account?.role || 'staff'); setActive(account?.active ?? true)
    setInviteMode('temporary'); setTemporaryPassword(account ? '' : generatePassword()); setShowPassword(false)
  }
  const changePassword = async (event: FormEvent) => {
    event.preventDefault()
    if (password !== confirm) return toast('The new passwords do not match.', 'error')
    setPasswordBusy(true)
    try {
      const result = await api.auth.changePassword(current, password)
      toast(result.message, 'success')
      await logout().catch(() => undefined)
      navigate('/admin/login', { replace: true })
    } catch (e) { toast(e instanceof Error ? e.message : 'Password could not be changed.', 'error') }
    finally { setPasswordBusy(false) }
  }
  const saveUser = async (event: FormEvent) => {
    event.preventDefault(); setUserSaveBusy(true)
    try {
      if (editing === 'new') {
        const result = await api.auth.inviteUser({ email, full_name: name, role, ...(inviteMode === 'temporary' ? { temporary_password: temporaryPassword } : {}) }); toast(result.message, 'success')
        if (inviteMode === 'temporary') setCredentials({ email, password: temporaryPassword })
      } else if (editing) {
        await api.auth.updateUser(editing.id, { full_name: name, role, active }); toast('User access saved.', 'success')
      }
      setEditing(null); setTemporaryPassword(''); setError(''); await load()
    } catch (e) { toast(e instanceof Error ? e.message : 'User could not be saved.', 'error') }
    finally { setUserSaveBusy(false) }
  }
  const recover = async (id: string) => {
    setRecoveringUserIds(currentIds => new Set(currentIds).add(id))
    try { toast((await api.auth.recoverUser(id)).message, 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Reset email failed.', 'error') }
    finally {
      setRecoveringUserIds(currentIds => {
        const nextIds = new Set(currentIds)
        nextIds.delete(id)
        return nextIds
      })
    }
  }
  return <>
    <section className="panel account-panel"><h2>Change your password</h2><p>Verify your current password. You will sign in again after changing it.</p><form onSubmit={changePassword} className="form-grid">
      <Input label="Current password" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} />
      <Input label="New password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={password} onChange={e => setPassword(e.target.value)} hint="At least 12 characters; use a unique passphrase." />
      <Input label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} />
      <div><Button type="submit" loading={passwordBusy}>Change password</Button></div>
    </form></section>
    {user?.role === 'admin' && <section className="panel account-panel"><header className="panel__header"><div><h2>Portal users</h2><p>Staff manage daily work. Administrators also manage access.</p></div><Button onClick={() => open()}>Invite user</Button></header>{error && <p role="alert" className="negative">{error}</p>}<div className="client-document-list">{users.map(account => <article className="client-document-card" key={account.id}><header><div><strong>{account.full_name || account.email}</strong><small>{account.email}</small></div><StatusPill status={account.active ? account.role : 'archived'} /></header><div className="document-toolbar"><Button size="sm" variant="secondary" onClick={() => open(account)}>Edit access</Button><Button size="sm" variant="ghost" loading={recoveringUserIds.has(account.id)} disabled={!account.active} onClick={() => void recover(account.id)}>Send password reset</Button></div></article>)}</div></section>}
    <Modal open={Boolean(editing)} onClose={() => { if (!userSaveBusy) setEditing(null) }} title={editing === 'new' ? 'Invite a portal user' : 'Edit user access'} description={editing === 'new' ? 'Create a user with a temporary password, or send a secure email invitation. They can change their password in Settings.' : 'Disabling access requires the deletion PIN and immediately blocks portal requests.'} footer={<><Button variant="ghost" disabled={userSaveBusy} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="user-access-form" loading={userSaveBusy}>{editing === 'new' ? inviteMode === 'temporary' ? 'Create user' : 'Send invitation' : 'Save access'}</Button></>}>
      <form id="user-access-form" className="form-grid" onSubmit={saveUser}><Input label="Full name" required minLength={2} maxLength={160} value={name} onChange={e => setName(e.target.value)} /><Input label="Email" type="email" required readOnly={editing !== 'new'} value={email} onChange={e => setEmail(e.target.value)} /><Select label="Role" value={role} onChange={e => setRole(e.target.value as 'admin' | 'staff')}><option value="staff">Staff</option><option value="admin">Administrator</option></Select>{editing === 'new' && <><Select className="form-grid__full" label="Account setup" value={inviteMode} onChange={e => setInviteMode(e.target.value)}><option value="temporary">Temporary password</option><option value="email">Email invitation</option></Select>{inviteMode === 'temporary' && <><Input className="form-grid__full" label="Temporary password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={12} maxLength={256} required value={temporaryPassword} onChange={e => setTemporaryPassword(e.target.value)} hint="At least 12 characters. The user may keep this password or change it after signing in." /><div className="document-toolbar form-grid__full"><Button type="button" size="sm" variant="secondary" onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide password' : 'Show password'}</Button><Button type="button" size="sm" variant="secondary" onClick={() => setTemporaryPassword(generatePassword())}>Generate password</Button><Button type="button" size="sm" variant="secondary" onClick={() => void copyCredentials(temporaryPassword)}>Copy password</Button></div></>}</>}{editing !== 'new' && <Select label="Access" value={active ? 'active' : 'disabled'} onChange={e => setActive(e.target.value === 'active')}><option value="active">Active</option><option value="disabled">Disabled</option></Select>}</form>
    </Modal>
    <Modal open={Boolean(credentials)} onClose={() => setCredentials(null)} title="Portal user created" description="Share these credentials privately. The user can sign in immediately and either keep this password or change it in Settings." footer={<Button onClick={() => setCredentials(null)}>Done</Button>}>
      {credentials && <><Input label="Login email" readOnly value={credentials.email} /><Input label="Created password" type={showPassword ? 'text' : 'password'} readOnly value={credentials.password} /><div className="document-toolbar"><Button variant="secondary" onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide password' : 'Show password'}</Button><Button onClick={() => void copyCredentials(`Portal: ${window.location.origin}/admin/login\nEmail: ${credentials.email}\nPassword: ${credentials.password}`)}>Copy login details</Button></div><p className="field-hint">The password is shown only in this session and is never stored in the portal profile or audit log.</p></>}
    </Modal>
  </>
}
