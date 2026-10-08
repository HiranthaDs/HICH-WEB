import { Check, ClipboardList, Download, Link2, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, Select, StatusPill, Textarea } from '../../components/ui'
import { SharePanel } from '../../components/SharePanel'
import { useToast } from '../../context/ToastContext'
import { api } from '../../lib/api'
import { formatCurrency, formatDate } from '../../lib/format'
import { exportCsv } from '../../lib/sharing'
import type { Agreement, ChangeOrder, Client, OperationTask } from '../../lib/types'

export function OperationsPage() {
  const { toast } = useToast()
  const [tasks, setTasks] = useState<OperationTask[]>([])
  const [changes, setChanges] = useState<ChangeOrder[]>([])
  const [agreements, setAgreements] = useState<Agreement[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<'task' | 'change' | null>(null)
  const [taskForm, setTaskForm] = useState<Partial<OperationTask>>({ priority: 'normal' })
  const [changeForm, setChangeForm] = useState<Partial<ChangeOrder>>({ currency: 'LKR', extra_days: 0, amount: 0 })
  const [busy, setBusy] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [shared, setShared] = useState<ChangeOrder | null>(null)
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const [t, c, a, cl] = await Promise.all([api.operations.tasks(), api.operations.changes(), api.agreements.list(), api.clients.list()]); setTasks(t); setChanges(c); setAgreements(a.items); setClients(cl.items) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load operations.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      if (editor === 'task') { const saved = await api.operations.createTask({ ...taskForm, client_id: taskForm.client_id || undefined, due_date: taskForm.due_date || undefined }); setTasks(current => [saved, ...current]); setTaskForm({ priority: 'normal' }) }
      else { const saved = await api.operations.createChange(changeForm); setChanges(current => [saved, ...current]); setChangeForm({ currency: 'LKR', extra_days: 0, amount: 0 }) }
      setEditor(null); toast('Saved to your workspace.', 'success')
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save.', 'error') }
    finally { setBusy(false) }
  }
  const toggleTask = async (task: OperationTask) => {
    try { const saved = await api.operations.updateTask(task.id, { status: task.status === 'done' ? 'open' : 'done' }); setTasks(current => current.map(item => item.id === task.id ? { ...item, ...saved } : item)) }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not update task.', 'error') }
  }
  const share = async (change: ChangeOrder) => {
    setBusy(true)
    try { const result = await api.operations.shareChange(change.id); const updated = { ...change, status: 'sent', share_url: result.share_url }; setShared(updated); setChanges(current => current.map(item => item.id === change.id ? updated : item)) }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not share.', 'error') }
    finally { setBusy(false) }
  }
  const voidChange = async (change: ChangeOrder) => {
    try { await api.operations.voidChange(change.id); setChanges(current => current.map(item => item.id === change.id ? { ...item, status: 'void' } : item)) }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not withdraw change.', 'error') }
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const pendingTasks = tasks.filter(task => showDone || task.status !== 'done').sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'))
  return <div className="admin-page"><PageHeader eyebrow="Keep work moving" title="Operations" description="Follow up on the right day. Agree on extra scope before the work begins." action={<Button icon={Plus} onClick={() => setEditor('task')}>New follow-up</Button>} />
    <div className="document-toolbar"><Button variant="secondary" icon={Plus} onClick={() => setEditor('change')}>New scope change</Button><Button variant="ghost" icon={RefreshCw} onClick={() => void load()}>Refresh</Button><Button variant="ghost" icon={Download} disabled={!tasks.length} onClick={() => exportCsv('hich-follow-ups.csv', tasks.map(t => ({ Task: t.title, Due: t.due_date, Priority: t.priority, Status: t.status, Notes: t.notes })))}>Export follow-ups</Button></div>
    {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={load} /> : <div className="operations-grid"><section className="panel"><header className="panel__header"><div><p className="eyebrow">Your next actions</p><h2>Follow-ups <small>({tasks.filter(t => t.status === 'open').length})</small></h2></div><label><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> Show completed</label></header>{!pendingTasks.length ? <EmptyState icon={ClipboardList} title="Nothing waiting on you" description="Create reminders for client calls, payments, renewals and project reviews." /> : <div className="task-list">{pendingTasks.map(task => <article className={`task-item ${task.status === 'done' ? 'is-complete' : ''}`} key={task.id}><button className="task-check" aria-label={`${task.status === 'done' ? 'Reopen' : 'Complete'} ${task.title}`} onClick={() => void toggleTask(task)}>{task.status === 'done' && <Check size={16} />}</button><div><h3>{task.title}</h3><p>{task.clients?.name || clients.find(c => c.id === task.client_id)?.name || 'Studio task'} · <span className={task.status !== 'done' && task.due_date && task.due_date < today ? 'negative' : ''}>{formatDate(task.due_date)}</span></p>{task.notes && <small>{task.notes}</small>}</div><StatusPill status={task.priority} /></article>)}</div>}</section>
      <section className="panel"><header className="panel__header"><div><p className="eyebrow">Protect your scope</p><h2>Change approvals</h2></div></header><p className="panel-intro">Approved fees are recorded separately. Add the approved change to an invoice when billing your client.</p>{!changes.length ? <EmptyState icon={ClipboardList} title="Clear scope, clear expectations" description="Create a priced change against a signed agreement and send the approval link." /> : changes.map(change => <article className="change-card" key={change.id}><div><StatusPill status={change.status} /><small>{change.reference}</small></div><h3>{change.title}</h3><p>{change.project_title}</p><p>{change.description}</p><strong>{formatCurrency(change.amount, change.currency)} <small>· +{change.extra_days} days</small></strong>{change.status === 'approved' ? <p className="positive">Approved by {change.signer_name}, {change.signer_job_role} · {formatDate(change.approved_at)}</p> : change.status !== 'void' && <div className="document-toolbar"><Button size="sm" icon={Link2} loading={busy} onClick={() => void share(change)}>Approval link</Button><Button size="sm" variant="ghost" onClick={() => void voidChange(change)}>Withdraw</Button></div>}</article>)}</section></div>}
    <Modal open={editor !== null} onClose={() => setEditor(null)} title={editor === 'task' ? 'Create a follow-up' : 'Price a scope change'} description={editor === 'task' ? 'Track the next action in your workspace.' : 'Additional fees and time need explicit client approval.'} footer={<><Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button><Button form="operation-form" type="submit" loading={busy}>Save</Button></>}><form className="form-grid" id="operation-form" onSubmit={save}>{editor === 'task' ? <><Input className="form-grid__full" label="Task" value={taskForm.title || ''} onChange={e => setTaskForm({ ...taskForm, title: e.target.value })} required minLength={2} /><Input label="Due date" type="date" value={taskForm.due_date || ''} onChange={e => setTaskForm({ ...taskForm, due_date: e.target.value })} /><Select label="Priority" value={taskForm.priority} onChange={e => setTaskForm({ ...taskForm, priority: e.target.value })}><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></Select><Select className="form-grid__full" label="Client" value={taskForm.client_id || ''} onChange={e => setTaskForm({ ...taskForm, client_id: e.target.value })}><option value="">Studio task</option>{clients.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}</Select><Textarea className="form-grid__full" label="Notes" value={taskForm.notes || ''} onChange={e => setTaskForm({ ...taskForm, notes: e.target.value })} /></> : <><Select className="form-grid__full" label="Signed agreement" value={changeForm.agreement_id || ''} onChange={e => { const a = agreements.find(a => a.id === e.target.value); setChangeForm({ ...changeForm, agreement_id: e.target.value, currency: a?.currency || 'LKR' }) }} required><option value="">Choose a signed agreement</option>{agreements.filter(a => a.status === 'signed').map(a => <option key={a.id} value={a.id}>{a.reference} · {a.project_title}</option>)}</Select><Input className="form-grid__full" label="Change title" value={changeForm.title || ''} onChange={e => setChangeForm({ ...changeForm, title: e.target.value })} minLength={2} required /><Textarea className="form-grid__full" label="Additional deliverables and exclusions" value={changeForm.description || ''} onChange={e => setChangeForm({ ...changeForm, description: e.target.value })} minLength={20} required rows={5} /><Input label={`Additional fee (${changeForm.currency})`} type="number" min="0" step="0.01" value={changeForm.amount ?? 0} onChange={e => setChangeForm({ ...changeForm, amount: Number(e.target.value) })} required /><Input label="Additional delivery days" type="number" min="0" max="3650" value={changeForm.extra_days || 0} onChange={e => setChangeForm({ ...changeForm, extra_days: Number(e.target.value) })} /></>}</form></Modal>
    <Modal open={Boolean(shared)} onClose={() => setShared(null)} title="Send scope approval">{shared?.share_url && <SharePanel url={shared.share_url} title={`${shared.title} · ${formatCurrency(shared.amount, shared.currency)}`} />}</Modal>
  </div>
}
