import { Eraser } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

export interface SignaturePadHandle {
  clear: () => void
  toDataURL: () => string | undefined
  isEmpty: () => boolean
}

export const SignaturePad = forwardRef<SignaturePadHandle, { onChange?: (hasSignature: boolean) => void }>(function SignaturePad({ onChange }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
  const empty = useRef(true)
  const [ready, setReady] = useState(false)

  const configureContext = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.lineWidth = 2.3
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = '#15291f'
  }

  const clear = () => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height)
    empty.current = true
    onChange?.(false)
  }

  useImperativeHandle(ref, () => ({
    clear,
    isEmpty: () => empty.current,
    toDataURL: () => empty.current ? undefined : canvasRef.current?.toDataURL('image/png'),
  }))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const ratio = Math.max(window.devicePixelRatio || 1, 1)
      canvas.width = Math.max(1, Math.floor(rect.width * ratio))
      canvas.height = Math.max(1, Math.floor(rect.height * ratio))
      const context = canvas.getContext('2d')
      context?.setTransform(ratio, 0, 0, ratio, 0, 0)
      configureContext()
      empty.current = true
      onChange?.(false)
      setReady(true)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [onChange])

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drawing.current = true
    lastPoint.current = point(event)
  }

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !lastPoint.current) return
    const next = point(event)
    const context = event.currentTarget.getContext('2d')
    if (!context) return
    configureContext()
    context.beginPath()
    context.moveTo(lastPoint.current.x, lastPoint.current.y)
    context.lineTo(next.x, next.y)
    context.stroke()
    lastPoint.current = next
    if (empty.current) {
      empty.current = false
      onChange?.(true)
    }
  }

  const stop = (event: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = false
    lastPoint.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div className="signature-pad">
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={(event) => { if (event.buttons === 0) stop(event) }}
        aria-label="Draw your signature in this box"
      />
      {!ready && <span className="signature-pad__hint">Preparing signature pad…</span>}
      <span className="signature-pad__line" aria-hidden="true" />
      <span className="signature-pad__caption">Sign above the line</span>
      <button type="button" className="signature-pad__clear" onClick={clear}><Eraser size={15} /> Clear</button>
    </div>
  )
})
