import { ArrowUpRight, Braces, Check, Code2, Layers3, MousePointer2, Rocket, Sparkles } from 'lucide-react'
import { useId, useRef, useState } from 'react'

const stages = [
  { key: 'design', title: 'Design', icon: Layers3, caption: 'An idea takes shape.', note: 'Made for real people' },
  { key: 'build', title: 'Build', icon: Code2, caption: 'The details connect.', note: 'Thoughtful engineering' },
  { key: 'launch', title: 'Launch', icon: Rocket, caption: 'Ready for what’s next.', note: 'Built to move you forward' },
] as const

/** An original, code-rendered studio illustration. Stage controls work without animation. */
export function DevelopmentPreview() {
  const [selected, setSelected] = useState(0)
  const controls = useRef<Array<HTMLButtonElement | null>>([])
  const panelId = useId()
  const stage = stages[selected]
  const selectWithKeyboard = (key: string) => {
    const next = key === 'ArrowRight' ? (selected + 1) % 3 : key === 'ArrowLeft' ? (selected + 2) % 3 : key === 'Home' ? 0 : key === 'End' ? 2 : selected
    setSelected(next)
    controls.current[next]?.focus()
  }
  return <div className={`development-preview development-preview--${stage.key}`}>
    <div className="development-preview__orbit" aria-hidden="true"><i /><i /><i /></div>
    <div className="development-preview__window" role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${stage.key}`}>
      <div className="development-preview__chrome" aria-hidden="true"><span><i /><i /><i /></span><small>hich / creative workspace</small><Braces size={14} /></div>
      <div className="development-preview__screen" key={stage.key}>
        <div className="development-preview__caption"><span>FROM POSSIBILITY TO PRODUCT</span><strong>{stage.caption}</strong></div>
        <div className="development-model" aria-hidden="true">
          <div className="development-model__ground" />
          <div className="development-model__stack"><span className="development-model__plate development-model__plate--base"><i /><i /><i /></span><span className="development-model__plate development-model__plate--middle"><Braces size={48} strokeWidth={1} /></span><span className="development-model__plate development-model__plate--top"><Sparkles size={42} strokeWidth={1.2} /></span></div>
          <div className="development-model__node development-model__node--one"><Layers3 size={17} /></div><div className="development-model__node development-model__node--two"><Code2 size={17} /></div><div className="development-model__node development-model__node--three"><Check size={17} /></div>
        </div>
        {stage.key === 'design' ? <div className="preview-design" aria-hidden="true"><span className="preview-design__swatch" /><span className="preview-design__swatch" /><span className="preview-design__swatch" /><div><small>ONE COHESIVE EXPERIENCE</small><strong>Considered. Connected.</strong></div><MousePointer2 className="preview-design__cursor" size={24} fill="currentColor" /></div> : stage.key === 'build' ? <div className="preview-code" aria-hidden="true"><div><i /> development.tsx</div><code><span>const</span> experience = {'{'}<br />&nbsp; design: <em>'purposeful'</em>,<br />&nbsp; build: <em>'connected'</em>,<br />&nbsp; possibilities: <b>Infinity</b><br />{'}'}</code><span className="preview-code__caret" /></div> : <div className="preview-launch" aria-hidden="true"><span className="preview-launch__check"><Check size={20} /></span><div><small>YOUR NEXT CHAPTER</small><strong>Ready for launch.</strong></div><div className="preview-launch__bars"><i /><i /><i /><i /><i /></div></div>}
      </div>
    </div>
    <div className="development-preview__note" aria-hidden="true"><span />{stage.note}<ArrowUpRight size={15} /></div>
    <div className="development-preview__controls" role="tablist" aria-label="Explore our development process">{stages.map(({ key, title, icon: Icon }, index) => <button ref={node => { controls.current[index] = node }} id={`${panelId}-${key}`} key={key} type="button" role="tab" aria-selected={selected === index} aria-controls={panelId} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); selectWithKeyboard(event.key) } }}><Icon size={14} /><span>{title}</span></button>)}</div>
  </div>
}
