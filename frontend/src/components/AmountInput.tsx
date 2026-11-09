import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import { Input } from './ui'

type Props = Omit<ComponentProps<typeof Input>, 'type' | 'value' | 'onChange' | 'step'> & {
  value: number | string | null | undefined
  onValueChange: (value: number | '') => void
}

const group = (value: string) => {
  if (!value) return ''
  const [whole, fraction] = value.split('.')
  return (whole || '0').replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`)
}

/** Keep currency readable while editing; only unformatted numbers leave this field. */
export function AmountInput({ value, onValueChange, id, min, max, onBlur, onKeyDown, ...props }: Props) {
  const generatedId = useId()
  const inputId = id || generatedId
  const [draft, setDraft] = useState(() => group(String(value ?? '')))
  const caret = useRef<number | null>(null)
  useEffect(() => {
    setDraft(current => Number(current.replaceAll(',', '')) === Number(value ?? '') && Boolean(current) === Boolean(String(value ?? '')) ? current : group(String(value ?? '')))
  }, [value])
  useLayoutEffect(() => {
    const input = document.getElementById(inputId) as HTMLInputElement | null
    if (!input) return
    const amount = Number(draft.replaceAll(',', ''))
    input.setCustomValidity(draft && min !== undefined && amount < Number(min) ? `Enter an amount of at least ${group(String(min))}.` : draft && max !== undefined && amount > Number(max) ? `Enter an amount no greater than ${group(String(max))}.` : '')
    if (caret.current !== null) {
      input.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
  }, [draft, inputId, min, max])
  return <Input {...props} id={inputId} type="text" inputMode="decimal" autoComplete="off" value={draft}
    onKeyDown={event => {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      const input = event.currentTarget, position = input.selectionStart
      if (position === null || position !== input.selectionEnd) return
      // Delete the neighbouring digit with its separator, so the cursor never gets stuck on a comma.
      if (event.key === 'Backspace' && input.value[position - 1] === ',') input.setSelectionRange(position - 2, position)
      if (event.key === 'Delete' && input.value[position] === ',') input.setSelectionRange(position, position + 2)
    }}
    onChange={event => {
      const input = event.target
      const raw = input.value.replaceAll(',', '').trim()
      if (!/^\d*(\.\d{0,2})?$/.test(raw) || (raw && !Number.isFinite(Number(raw === '.' ? '0.' : raw)))) return
      const next = group(raw)
      const beforeCursor = input.value.slice(0, input.selectionStart ?? input.value.length).replaceAll(',', '').length
      let position = 0, count = 0
      while (position < next.length && count < beforeCursor) { if (next[position] !== ',') count++; position++ }
      caret.current = position
      setDraft(next)
      onValueChange(raw === '' ? '' : Number(raw === '.' ? '0' : raw))
    }}
    onBlur={event => {
      if (draft.endsWith('.')) setDraft(draft.slice(0, -1))
      onBlur?.(event)
    }} />
}
