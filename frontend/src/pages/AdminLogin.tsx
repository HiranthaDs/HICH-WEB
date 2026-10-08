import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Brand } from '../components/Brand'
import { Button, Input } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'

export function AdminLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [recoveryMessage, setRecoveryMessage] = useState('')
  const { user, checking, login } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const destination = (location.state as { from?: string } | null)?.from || '/admin'

  useEffect(() => {
    if (!checking && user) navigate('/admin', { replace: true })
  }, [checking, user, navigate])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!email.trim() || !password) return setError('Enter your email and password.')
    setLoading(true)
    try {
      await login(email.trim(), password)
      toast('Welcome back to Hich.', 'success')
      navigate(destination, { replace: true })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The email or password is incorrect.')
    } finally {
      setLoading(false)
    }
  }

  const recover = async () => {
    if (!email.trim()) return setError('Enter your administrator email above, then request a reset link.')
    setLoading(true); setError(''); setRecoveryMessage('')
    try { setRecoveryMessage((await api.auth.recover(email.trim())).message) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not request a reset link.') }
    finally { setLoading(false) }
  }

  return (
    <div className="login-page">
      <aside className="login-story">
        <div className="login-story__header"><Brand inverse /><span>Private workspace</span></div>
        <div className="login-story__copy">
          <p className="eyebrow"><Sparkles size={14} /> Hich operations</p>
          <h1>Better projects.<br /><em>Stronger partnerships.</em></h1>
          <p>Your connected workspace for agreements, client signatures, invoices and the work you are proud to share.</p>
          <ul>
            <li><CheckCircle2 size={18} /> Secure agreement signatures</li>
            <li><CheckCircle2 size={18} /> Clear payment and renewal visibility</li>
            <li><CheckCircle2 size={18} /> One polished public portfolio</li>
          </ul>
        </div>
        <div className="login-story__art" aria-hidden="true"><i /><i /><i /><span>Built for focused work.</span></div>
      </aside>
      <main className="login-main">
        <Link className="login-back" to="/"><ArrowLeft size={16} /> Back to website</Link>
        <form className="login-card" onSubmit={submit}>
          <span className="login-card__icon"><LockKeyhole size={25} /></span>
          <p className="eyebrow">Administrator access</p>
          <h2>Welcome back</h2>
          <p className="login-card__lead">Your projects, people and next steps are waiting.</p>
          {error && <div className="form-alert" role="alert">{error}</div>}
          {recoveryMessage && <div className="inline-alert" role="status">{recoveryMessage}</div>}
          <Input label="Email address" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" autoComplete="email" autoFocus />
          <div className="password-field">
            <Input label="Password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" autoComplete="current-password" />
            <button type="button" onClick={() => setShowPassword((shown) => !shown)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
          </div>
          <Button className="login-submit" size="lg" loading={loading} type="submit">Sign in securely <ArrowRight size={18} /></Button>
          <Button variant="ghost" type="button" loading={loading} onClick={() => void recover()}>Forgot password? Send reset link</Button>
          <p className="login-security"><ShieldCheck size={15} /> Secure access to your Hich Web workspace.</p>
        </form>
        <small className="login-help">Need access? Contact your Hich Studio workspace owner.</small>
      </main>
    </div>
  )
}
