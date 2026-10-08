import { ExternalLink, Eye, EyeOff, GripVertical, ImagePlus, Images, MoreHorizontal, Plus, RefreshCw, Star, Trash2, UploadCloud } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { PortfolioCollections } from '../../components/PortfolioCollections'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Button, ConfirmDialog, EmptyState, ErrorState, Input, LoadingState, Modal, PageHeader, SearchInput, Select, StatusPill, Textarea } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { api } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { normalizeProjectSlug, preparePortfolioImage } from '../../lib/portfolio'
import type { PortfolioProject } from '../../lib/types'

const blankProject: Partial<PortfolioProject> = { title: '', slug: '', url: '', category: 'Web experience', main_description: '', sub_description: '', published: false, featured: false, sort_order: 0, images: [] }
const imagesFor = (project: Partial<PortfolioProject>) => project.images?.length ? project.images : project.image_urls || []

export function PortfolioPage() {
  const { toast } = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [projects, setProjects] = useState<PortfolioProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('search') || '')
  useEffect(() => setQuery(params.get('search') || ''), [params])
  const [visibility, setVisibility] = useState('all')
  const [editing, setEditing] = useState<PortfolioProject | 'new' | null>(null)
  const [form, setForm] = useState<Partial<PortfolioProject>>(blankProject)
  const [files, setFiles] = useState<File[]>([])
  const [removedImageIds, setRemovedImageIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [processingImages, setProcessingImages] = useState(false)
  const [deleting, setDeleting] = useState<PortfolioProject | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [menu, setMenu] = useState<string | number | null>(null)

  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files])
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setProjects((await api.portfolio.list()).items) }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Portfolio projects could not be loaded.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => projects.filter((project) => (!query || [project.title, project.category, project.main_description].join(' ').toLowerCase().includes(query.toLowerCase())) && (visibility === 'all' || (visibility === 'published' ? project.published : !project.published))), [projects, query, visibility])

  const openEditor = (project?: PortfolioProject) => {
    setEditing(project || 'new'); setForm(project ? { ...project } : { ...blankProject }); setFiles([]); setRemovedImageIds([]); setMenu(null)
  }

  const chooseFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || [])
    event.target.value = ''
    const room = Math.max(0, 3 - imagesFor(form).length - files.length)
    if (selected.length > room) toast(`A project can show up to 3 images. ${room} slot${room === 1 ? '' : 's'} remaining.`, 'error')
    setProcessingImages(true)
    try {
      const prepared = await Promise.allSettled(selected.slice(0, room).map(preparePortfolioImage))
      const valid: File[] = []
      for (const result of prepared) {
        if (result.status === 'fulfilled') valid.push(result.value)
        else toast(result.reason instanceof Error ? result.reason.message : 'Image could not be prepared.', 'error')
      }
      setFiles((current) => [...current, ...valid].filter((file, index, all) => all.findIndex((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified) === index))
    } finally { setProcessingImages(false) }
  }

  const removeExisting = (url: string) => {
    const remaining = imagesFor(form).filter((image) => image !== url)
    const record = form.image_records?.find((image) => image.public_url === url)
    if (record?.id) setRemovedImageIds((current) => current.includes(record.id) ? current : [...current, record.id])
    setForm({ ...form, images: remaining, image_urls: remaining, image_records: form.image_records?.filter((image) => image.public_url !== url) })
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (processingImages || saving) return
    if (!form.title?.trim() || !form.main_description?.trim()) return toast('Add a title and main description.', 'error')
    const totalImages = imagesFor(form).length + files.length
    if (totalImages > 3) return toast('A project can have up to 3 images.', 'error')
    setSaving(true)
    let createdId: PortfolioProject['id'] | null = null
    try {
      const payload = { ...form, title: form.title.trim(), slug: normalizeProjectSlug(form.slug || '') || undefined }
      let saved = editing === 'new' ? await api.portfolio.create({ ...payload, published: false }) : await api.portfolio.update((editing as PortfolioProject).id, payload)
      if (editing === 'new') createdId = saved.id
      if (removedImageIds.length) {
        await Promise.all(removedImageIds.map((imageId) => api.portfolio.removeImage(saved.id, imageId)))
        saved = await api.portfolio.get(saved.id)
      }
      if (files.length) saved = await api.portfolio.uploadImages(saved.id, files)
      if (form.published && !saved.published) saved = await api.portfolio.update(saved.id, { published: true })
      setProjects((current) => editing === 'new' ? [saved, ...current] : current.map((project) => project.id === saved.id ? saved : project))
      toast(editing === 'new' ? 'Portfolio project created.' : 'Portfolio project updated.', 'success'); setEditing(null); setFiles([]); setRemovedImageIds([])
    } catch (requestError) {
      if (createdId) await api.portfolio.remove(createdId).catch(() => undefined)
      toast(requestError instanceof Error ? requestError.message : 'Project could not be saved.', 'error')
    }
    finally { setSaving(false) }
  }

  const togglePublished = async (project: PortfolioProject) => {
    setMenu(null)
    try { const saved = await api.portfolio.update(project.id, { published: !project.published }); setProjects((current) => current.map((item) => item.id === project.id ? saved : item)); toast(saved.published ? 'Project published.' : 'Project moved to drafts.', 'success') }
    catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'Visibility could not be updated.', 'error') }
  }

  const remove = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try { await api.portfolio.remove(deleting.id); setProjects((current) => current.filter((project) => project.id !== deleting.id)); setDeleting(null); toast('Portfolio project deleted.', 'success') }
    catch (requestError) { toast(requestError instanceof Error ? requestError.message : 'Project could not be deleted.', 'error') }
    finally { setDeleteBusy(false) }
  }

  return <div className="admin-page">
    <PageHeader eyebrow="Public website" title="Completed projects" description="Publish your completed websites and systems, then share relevant work with each client." action={<Button icon={Plus} onClick={() => openEditor()}>Add project</Button>} />
    <PortfolioCollections projects={projects} />
    <section className="toolbar panel panel--flat"><SearchInput value={query} onChange={setQuery} placeholder="Search title or category…" label="Search portfolio" /><div className="toolbar__right"><Select aria-label="Filter portfolio visibility" value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="all">All projects</option><option value="published">Published</option><option value="draft">Drafts</option></Select><Button variant="ghost" size="sm" icon={RefreshCw} loading={loading} onClick={load}>Refresh</Button></div></section>
    {loading && !projects.length ? <LoadingState label="Loading portfolio…" /> : error ? <ErrorState message={error} onRetry={load} /> : filtered.length === 0 ? <EmptyState icon={Images} title={query || visibility !== 'all' ? 'No projects match' : 'Show the work Hich is proud of'} description={query || visibility !== 'all' ? 'Try a different search or visibility filter.' : 'Add a title, a live link, a clear story and 2–3 sample images for each project.'} action={!query && visibility === 'all' ? <Button icon={Plus} onClick={() => openEditor()}>Add first project</Button> : undefined} /> : <div className="portfolio-admin-grid">{filtered.map((project) => {
      const images = imagesFor(project)
      return <article className="portfolio-admin-card" key={project.id}><div className="portfolio-admin-card__visual">{images[0] ? <img src={images[0]} alt={`${project.title} preview`} /> : <span><Images size={26} /></span>}<div className="portfolio-admin-card__badges"><StatusPill status={project.published ? 'published' : 'draft'} />{project.featured && <span className="featured-pill"><Star size={12} fill="currentColor" /> Featured</span>}</div><div className="more-menu"><button className="icon-button" type="button" onClick={() => setMenu(menu === project.id ? null : project.id)} aria-label={`More actions for ${project.title}`}><MoreHorizontal size={18} /></button>{menu === project.id && <div className="more-menu__popover"><button onClick={() => openEditor(project)}>Edit project</button><button onClick={() => togglePublished(project)}>{project.published ? <EyeOff size={15} /> : <Eye size={15} />}{project.published ? 'Unpublish' : 'Publish'}</button>{project.url && <a href={project.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open live link</a>}<button className="danger" onClick={() => { setDeleting(project); setMenu(null) }}><Trash2 size={15} /> Delete</button></div>}</div></div><div className="portfolio-admin-card__body"><span>{project.category || 'Digital experience'} · {images.length} images</span><h3>{project.title}</h3><p>{project.sub_description || project.main_description}</p></div><footer><Button variant="secondary" size="sm" onClick={() => openEditor(project)}>Edit project</Button><small>Updated {formatDate(project.updated_at || project.created_at)}</small></footer></article>
    })}</div>}

    <Modal open={Boolean(editing)} onClose={() => { if (!saving && !processingImages) setEditing(null) }} title={editing === 'new' ? 'Add portfolio project' : 'Edit portfolio project'} description="Use concrete details and real screens to make each project story credible." size="xl" footer={<><Button variant="ghost" disabled={saving || processingImages} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="portfolio-form" loading={saving || processingImages}>{processingImages ? 'Preparing images' : editing === 'new' ? 'Create project' : 'Save project'}</Button></>}>
      <form id="portfolio-form" className="portfolio-form" onSubmit={save}>
        <div className="form-grid">
          <Input label="Project title" value={form.title || ''} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Storefront redesign" required />
          <Input label="Project ID / slug" value={form.slug || ''} onChange={(event) => setForm({ ...form, slug: event.target.value })} onBlur={() => setForm((current) => ({ ...current, slug: normalizeProjectSlug(current.slug || '') }))} placeholder={normalizeProjectSlug(form.title || '') || 'storefront-redesign'} hint="Leave blank to generate from the title. Spaces and capitals are formatted automatically." optional />
          <Input className="form-grid__full" label="Live project link" type="url" value={form.url || ''} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://example.com" optional />
          <Input label="Category" value={form.category || ''} onChange={(event) => setForm({ ...form, category: event.target.value })} placeholder="E-commerce" list="project-categories" /><datalist id="project-categories"><option value="E-commerce" /><option value="Business website" /><option value="Web application" /><option value="Management system" /><option value="Booking platform" /></datalist>
          <Input label="Display order" type="number" min="0" value={form.sort_order || 0} onChange={(event) => setForm({ ...form, sort_order: Number(event.target.value) })} />
          <Textarea className="form-grid__full" label="Main description" value={form.main_description || ''} onChange={(event) => setForm({ ...form, main_description: event.target.value })} rows={5} placeholder="Explain the problem, approach and meaningful result…" required />
          <Textarea className="form-grid__full" label="Short description" value={form.sub_description || ''} onChange={(event) => setForm({ ...form, sub_description: event.target.value })} rows={3} placeholder="A concise summary for the project card." />
          <label className="switch-field"><input type="checkbox" checked={Boolean(form.published)} onChange={(event) => setForm({ ...form, published: event.target.checked })} /><span /><div><strong>Published</strong><small>Visible on the public portfolio</small></div></label>
          <label className="switch-field"><input type="checkbox" checked={Boolean(form.featured)} onChange={(event) => setForm({ ...form, featured: event.target.checked })} /><span /><div><strong>Featured</strong><small>Prioritise this project in the grid</small></div></label>
        </div>
        <section className="image-manager">
          <header><div><p className="eyebrow">Project gallery</p><h3>Add 2–3 sample images</h3><p>Use clear desktop or mobile screens. JPG, PNG or WebP up to 6 MB each.</p></div><span>{imagesFor(form).length + files.length}/3</span></header>
          <div className="image-preview-grid">
            {imagesFor(form).map((image, index) => <figure key={image}><img src={image} alt={`Existing project preview ${index + 1}`} /><figcaption>Image {index + 1}</figcaption><button type="button" onClick={() => removeExisting(image)} aria-label={`Remove image ${index + 1}`}><Trash2 size={15} /></button><span><GripVertical size={14} /></span></figure>)}
            {previews.map((preview, index) => <figure className="image-preview--new" key={preview}><img src={preview} alt={`New project preview ${index + 1}`} /><figcaption>{files[index]?.name}</figcaption><button type="button" onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} aria-label={`Remove ${files[index]?.name}`}><Trash2 size={15} /></button><span><UploadCloud size={14} /></span></figure>)}
            {imagesFor(form).length + files.length < 3 && <button className="image-upload-tile" type="button" disabled={processingImages || saving} onClick={() => fileInput.current?.click()}><ImagePlus size={24} /><strong>{processingImages ? 'Preparing images...' : 'Add images'}</strong><small>{Math.max(0, 3 - imagesFor(form).length - files.length)} slot{3 - imagesFor(form).length - files.length === 1 ? '' : 's'} left</small></button>}
          </div>
          <p className="field__hint">SVG files are converted to PNG before upload.</p>
          <input ref={fileInput} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" multiple disabled={processingImages || saving} onChange={chooseFiles} />
        </section>
      </form>
    </Modal>
    <ConfirmDialog open={Boolean(deleting)} onClose={() => setDeleting(null)} onConfirm={remove} loading={deleteBusy} title={`Delete “${deleting?.title || 'project'}”?`} description="Its images and public portfolio entry will be removed." />
  </div>
}
