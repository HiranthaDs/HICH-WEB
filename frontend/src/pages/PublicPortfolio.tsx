import {
  ArrowDownRight,
  ArrowRight,
  BadgeCheck,
  Blocks,
  ChevronLeft,
  ChevronRight,
  Code2,
  ExternalLink,
  Layers3,
  Menu,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { DevelopmentPreview } from '../components/DevelopmentPreview'
import { Brand } from '../components/Brand'
import { TermsOverview } from '../components/TermsOverview'
import { ContactActions } from '../components/ContactActions'
import { Button, EmptyState, ErrorState, LoadingState, Modal } from '../components/ui'
import { copyText } from '../lib/sharing'
import { useToast } from '../context/ToastContext'
import { api } from '../lib/api'
import type { PortfolioProject } from '../lib/types'

const projectImages = (project: PortfolioProject) => project.images?.length ? project.images : project.image_urls || []

export function PublicPortfolio() {
  const { collectionToken } = useParams()
  const [params, setParams] = useSearchParams()
  const { toast } = useToast()
  const category = params.get('category') || ''
  const [collection, setCollection] = useState<{ title: string; description?: string } | null>(null)
  const [projects, setProjects] = useState<PortfolioProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [selected, setSelected] = useState<PortfolioProject | null>(null)
  const [selectedImage, setSelectedImage] = useState(0)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      if (collectionToken) { const response = await api.collections.public(collectionToken); setProjects(response.projects); setCollection(response.collection) }
      else { const response = await api.publicPortfolio(); setProjects(response.items.filter(project => project.published !== false)); setCollection(null) }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Portfolio projects could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [collectionToken])
  useEffect(() => {
    setSelectedImage(0)
    document.querySelector<HTMLElement>('.modal--xl:has(.case-study) .modal__body')?.scrollTo(0, 0)
  }, [selected])

  const featured = useMemo(() => projects.filter(project => !category || (project.category || 'Other').toLowerCase() === category.toLowerCase()).sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || Number(a.sort_order || 0) - Number(b.sort_order || 0)), [projects, category])
  const selectedImages = selected ? projectImages(selected) : []
  const selectedProjectIndex = selected ? featured.findIndex(project => project.id === selected.id) : -1

  return (
    <div className="public-site">
      <header className="public-nav">
        <div className="public-nav__inner">
          <Brand />
          <nav className={`public-nav__links${menuOpen ? ' public-nav__links--open' : ''}`} aria-label="Main navigation">
            <a href="#work" onClick={() => setMenuOpen(false)}>Selected work</a>
            <a href="#services" onClick={() => setMenuOpen(false)}>Capabilities</a>
            <a href="#process" onClick={() => setMenuOpen(false)}>Process</a>
            <a href="#contact" onClick={() => setMenuOpen(false)}>Contact</a>
          </nav>
          <button className="public-nav__menu" type="button" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen}>
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero__glow hero__glow--one" />
          <div className="hero__glow hero__glow--two" />
          <div className="public-container hero__inner">
            <div className="hero__copy">
              <p className="hero__kicker"><span><Sparkles size={14} /></span> Design and engineering, together</p>
              <h1>{collection ? collection.title : <>Your next chapter.<br /><em>Built with Hich.</em></>}</h1>
              <p className="hero__lead">{collection?.description || 'Websites, e-commerce experiences and powerful business systems. Designed around your ambition. Built for what comes next.'}</p>
              <div className="hero__actions">
                <a className="button button--primary button--lg" href="#work"><span>Explore our work</span><ArrowDownRight size={18} /></a>
                <a className="text-link" href="mailto:hello@hich.studio">Start a conversation <ArrowRight size={16} /></a>
              </div>
              <ContactActions light />
              <div className="hero__proof">
                <span><BadgeCheck size={17} /> Purpose-built systems</span>
                <span><BadgeCheck size={17} /> Transparent delivery</span>
              </div>
            </div>
            <DevelopmentPreview />
          </div>
        </section>

        <section className="public-section public-section--work" id="work">
          <div className="public-container">
            <div className="section-heading">
              <div><p className="eyebrow">Selected work</p><h2>{category ? `${category}. Built to perform.` : 'Good ideas. Great outcomes.'}</h2></div>
              <p>A closer look at the commerce, platform and brand experiences we have helped bring to life.</p>
            </div>

            <div className="portfolio-filters"><div role="group" aria-label="Project category"><button type="button" className={!category ? 'active' : ''} aria-pressed={!category} onClick={() => setParams({})}>All work <small>{projects.length}</small></button>{[...new Set(projects.map(project => project.category || 'Other'))].map(item => <button type="button" key={item} className={category.toLowerCase() === item.toLowerCase() ? 'active' : ''} aria-pressed={category.toLowerCase() === item.toLowerCase()} onClick={() => setParams({ category: item })}>{item}<small>{projects.filter(p => (p.category || 'Other') === item).length}</small></button>)}</div><Button variant="secondary" size="sm" onClick={() => void copyText(window.location.href.split('#')[0] + '#work').then(() => toast('Collection link copied.', 'success')).catch(e => toast(e.message, 'error'))}>Copy collection link</Button></div>
            {loading ? <LoadingState label="Loading selected work…" /> : error ? (
              <ErrorState title="Our work is temporarily unavailable" message={error} onRetry={load} />
            ) : featured.length === 0 ? (
              <EmptyState icon={Layers3} title={category ? `No ${category} projects yet` : 'New work is on the way'} description="Published completed projects will appear here." />
            ) : (
              <div className="project-grid">
                {featured.map((project, index) => {
                  const images = projectImages(project)
                  return (
                    <article className={`project-card${index === 0 ? ' project-card--featured' : ''}`} key={project.id}>
                      <button className="project-card__visual" type="button" onClick={() => setSelected(project)} aria-label={`View ${project.title} project`}>
                        {images[0] ? <img src={images[0]} alt={`${project.title} preview`} loading="lazy" /> : <span className={`project-placeholder project-placeholder--${index % 3}`}><span>{project.title.slice(0, 1)}</span></span>}
                        <span className="project-card__open"><ArrowDownRight size={18} /></span>
                        {images.length > 1 && <span className="project-card__count">{images.length} images</span>}
                      </button>
                      <div className="project-card__body">
                        <div className="project-card__heading"><span className="project-card__category">{project.category || 'Digital experience'}</span><span className="project-card__number">{String(index + 1).padStart(2, '0')}</span></div>
                        <h3>{project.title}</h3>
                        <p>{project.sub_description || project.main_description || 'A focused digital experience created around real people and clear business goals.'}</p>
                        <button type="button" className="text-link" onClick={() => setSelected(project)}>View case study <ArrowRight size={15} /></button>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        </section>

        <section className="public-section" id="services">
          <div className="public-container">
            <div className="section-heading section-heading--compact"><div><p className="eyebrow">Capabilities</p><h2>One focused team, end to end.</h2></div></div>
            <div className="capability-grid">
              <article><span><Sparkles size={21} /></span><small>01</small><h3>Product direction</h3><p>Requirements, user flows and a practical roadmap that keeps decisions aligned.</p></article>
              <article><span><Blocks size={21} /></span><small>02</small><h3>Interface design</h3><p>Distinctive, responsive systems designed for clarity, trust and conversion.</p></article>
              <article><span><Code2 size={21} /></span><small>03</small><h3>Web engineering</h3><p>Modern frontend and backend builds with performance and maintainability in mind.</p></article>
              <article><span><RefreshCw size={21} /></span><small>04</small><h3>Care after launch</h3><p>Measured iteration, dependable support and a clear path for the product to grow.</p></article>
            </div>
          </div>
        </section>

        <section className="public-section public-section--process" id="process">
          <div className="public-container process-layout">
            <div className="process-intro"><p className="eyebrow">How we work</p><h2>A calm path from idea to launch.</h2><p>Each phase ends with something concrete to review. You always know what is happening, why it matters, and what comes next.</p></div>
            <ol className="process-list">
              <li><span>01</span><div><h3>Align</h3><p>We define the audience, problem, scope and measure of success.</p></div></li>
              <li><span>02</span><div><h3>Shape</h3><p>We turn the brief into flows, visual direction and a working plan.</p></div></li>
              <li><span>03</span><div><h3>Build</h3><p>Design and engineering move together through visible, testable releases.</p></div></li>
              <li><span>04</span><div><h3>Launch & learn</h3><p>We ship carefully, measure the result and refine what creates value.</p></div></li>
            </ol>
          </div>
        </section>

        <section className="public-section"><div className="public-container"><TermsOverview /></div></section>
        <section className="contact-band" id="contact">
          <div className="public-container contact-band__inner">
            <div><p className="eyebrow">Have something in mind?</p><h2>Let’s make the next version real.</h2></div>
            <ContactActions light />
          </div>
        </section>
      </main>

      <footer className="public-footer">
        <div className="public-container public-footer__inner">
          <Brand inverse />
          <p>Thoughtful digital work, built in Sri Lanka for teams everywhere.</p>
          <div><a href="mailto:hello@hich.studio">Email</a></div>
          <small>© {new Date().getFullYear()} Hich Studio.</small>
        </div>
      </footer>

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.title || 'Project'} description={selected?.category} size="xl">
        {selected && <div className="case-study">
          <div className="case-study__gallery">
            <div className="case-study__image">
              {selectedImages[selectedImage] ? <img src={selectedImages[selectedImage]} alt={`${selected.title} image ${selectedImage + 1} of ${selectedImages.length}`} /> : <span className="project-placeholder"><span>{selected.title.slice(0, 1)}</span></span>}
            </div>
            {selectedImages.length > 0 && <div className="case-study__image-bar">
              <span>{String(selectedImage + 1).padStart(2, '0')} / {String(selectedImages.length).padStart(2, '0')}</span>
              <a href={selectedImages[selectedImage]} target="_blank" rel="noreferrer">Open full image <ExternalLink size={14} /></a>
              {selectedImages.length > 1 && <div className="case-study__image-controls">
                <button type="button" onClick={() => setSelectedImage(index => (index - 1 + selectedImages.length) % selectedImages.length)} aria-label="Previous image"><ChevronLeft size={19} /></button>
                <button type="button" onClick={() => setSelectedImage(index => (index + 1) % selectedImages.length)} aria-label="Next image"><ChevronRight size={19} /></button>
              </div>}
            </div>}
            {selectedImages.length > 1 && <div className="case-study__thumbs" role="group" aria-label="Project images">{selectedImages.map((image, index) => <button className={selectedImage === index ? 'active' : ''} type="button" key={`${image}-${index}`} onClick={() => setSelectedImage(index)} aria-label={`Show image ${index + 1} of ${selectedImages.length}`} aria-pressed={selectedImage === index}><img src={image} alt="" loading="lazy" /></button>)}</div>}
          </div>
          <div className="case-study__copy">
            <p className="case-study__eyebrow">About the project</p>
            <p>{selected.main_description || selected.sub_description || 'A focused digital experience created around real people and clear business goals.'}</p>
            {selected.sub_description && selected.main_description !== selected.sub_description && <small>{selected.sub_description}</small>}
            {selected.url && <a className="button button--primary" href={selected.url} target="_blank" rel="noreferrer"><span>Visit live project</span><ExternalLink size={17} /></a>}
            {featured.length > 1 && <div className="case-study__project-nav">
              <button type="button" onClick={() => { setSelectedImage(0); setSelected(featured[selectedProjectIndex - 1]) }} disabled={selectedProjectIndex <= 0}><ChevronLeft size={17} /> Previous project</button>
              <button type="button" onClick={() => { setSelectedImage(0); setSelected(featured[selectedProjectIndex + 1]) }} disabled={selectedProjectIndex >= featured.length - 1}>Next project <ChevronRight size={17} /></button>
            </div>}
          </div>
        </div>}
      </Modal>
    </div>
  )
}
