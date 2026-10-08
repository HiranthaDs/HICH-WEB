import { FolderHeart, Link2, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Modal, Select, Textarea } from './ui'
import { SharePanel } from './SharePanel'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import type { PortfolioCollection, PortfolioProject } from '../lib/types'

export function PortfolioCollections({ projects }: { projects: PortfolioProject[] }) {
  const { toast } = useToast()
  const [collections, setCollections] = useState<PortfolioCollection[]>([])
  const [error, setError] = useState('')
  const [editor, setEditor] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [shared, setShared] = useState<PortfolioCollection | null>(null)
  const published = projects.filter(p => p.published)
  const categories = [...new Set(published.map(p => p.category || 'Other'))]
  useEffect(() => { void api.collections.list().then(setCollections).catch(e => setError(e.message)) }, [])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected.length) return toast('Select at least one completed project.', 'error')
    setBusy(true)
    try { const saved = await api.collections.create({ title, description, category: category || undefined, project_ids: selected }); setCollections(current => [saved, ...current]); setEditor(false); setShared(saved); setTitle(''); setDescription(''); setSelected([]); setError('') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save collection.', 'error') }
    finally { setBusy(false) }
  }
  const remove = async (collection: PortfolioCollection) => {
    try { await api.collections.remove(collection.id); setCollections(current => current.filter(c => c.id !== collection.id)); toast('Collection link removed. Projects remain available.', 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not remove collection.', 'error') }
  }
  return <section className="panel portfolio-share"><header className="panel__header"><div><p className="eyebrow">The right work for the right client</p><h2><FolderHeart size={21} /> Project collections</h2></div><Button icon={Plus} variant="secondary" onClick={() => setEditor(true)}>Create collection</Button></header><p className="panel-intro">Send a handpicked collection of completed websites. Category links automatically include all published work in that category.</p>{error && <p className="negative" role="alert">{error}</p>}<div className="collection-list">{collections.map(collection => <article key={collection.id}><div><strong>{collection.title}</strong><small>{collection.project_ids.length} selected projects</small></div><Button variant="ghost" size="sm" icon={Link2} onClick={() => setShared(collection)}>Share</Button><button className="icon-button" aria-label={`Remove ${collection.title} collection link`} onClick={() => void remove(collection)}><Trash2 size={16} /></button></article>)}</div><div className="document-toolbar">{categories.map(item => <a key={item} className="button button--secondary button--sm" href={`/?category=${encodeURIComponent(item)}#work`} target="_blank" rel="noreferrer">{item} ↗</a>)}</div>
    <Modal open={editor} onClose={() => setEditor(false)} title="Create a project collection" description="Only published completed work can be shared." footer={<><Button variant="ghost" onClick={() => setEditor(false)}>Cancel</Button><Button type="submit" form="collection-form" loading={busy}>Save & create link</Button></>}><form id="collection-form" className="form-grid" onSubmit={save}><Input className="form-grid__full" label="Collection title" placeholder="E-commerce inspiration for your business" required minLength={2} value={title} onChange={e => setTitle(e.target.value)} /><Textarea className="form-grid__full" label="Introduction" value={description} onChange={e => setDescription(e.target.value)} /><Select className="form-grid__full" label="Select a category" value={category} onChange={e => { const value = e.target.value; setCategory(value); setSelected(published.filter(p => !value || (p.category || 'Other') === value).map(p => String(p.id))) }}><option value="">All categories</option>{categories.map(item => <option key={item}>{item}</option>)}</Select><div className="form-grid__full collection-picker">{published.length ? published.filter(p => !category || (p.category || 'Other') === category).map(project => <label key={project.id}><input type="checkbox" checked={selected.includes(String(project.id))} onChange={e => setSelected(current => e.target.checked ? [...current, String(project.id)] : current.filter(id => id !== String(project.id)))} /><span>{project.title}<small>{project.category}</small></span></label>) : <p>Publish a completed project first.</p>}</div></form></Modal>
    <Modal open={Boolean(shared)} onClose={() => setShared(null)} title="Share project collection">{shared && <SharePanel url={shared.share_url} title={shared.title} />}</Modal>
  </section>
}
