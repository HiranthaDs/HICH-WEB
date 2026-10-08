import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Brand } from '../components/Brand'
import { Button, Input } from '../components/ui'
import { api } from '../lib/api'

export function ResetPassword() {
  const [tokens] = useState(() => new URLSearchParams(window.location.hash.replace(/^#/, '')))
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (password !== confirm) return setError('The passwords do not match.')
    setBusy(true)
    try { const result = await api.auth.resetPassword(tokens.get('access_token') || '', tokens.get('refresh_token') || '', password); setMessage(result.message); window.history.replaceState({}, '', '/admin/reset-password') }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update password.') }
    finally { setBusy(false) }
  }
  return <div className="sign-page sign-page--center"><Brand /><form className="login-card" onSubmit={submit}><p className="eyebrow">Administrator access</p><h1>Set your new password</h1>{message ? <p role="status">{message}</p> : !tokens.get('access_token') ? <p role="alert">{tokens.get('error_description') || 'Open the reset link from your email. This page needs a valid password reset link.'}</p> : <>{error && <p className="form-alert" role="alert">{error}</p>}<Input type="password" autoComplete="new-password" label="New password" minLength={12} required value={password} onChange={e => setPassword(e.target.value)} hint="Use at least 12 characters." /><Input type="password" autoComplete="new-password" label="Confirm password" minLength={12} required value={confirm} onChange={e => setConfirm(e.target.value)} /><Button type="submit" loading={busy}>Update password</Button></>}<Link className="text-link" to="/admin/login">Return to sign in</Link></form></div>
}
