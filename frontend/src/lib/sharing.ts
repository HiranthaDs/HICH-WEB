export async function copyText(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  const input = document.createElement('textarea')
  input.value = value
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('Copy is unavailable. Select and copy the link manually.')
}

export function whatsappUrl(phone: string, message: string) {
  let digits = phone.replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length === 10 && digits.startsWith('0')) digits = `94${digits.slice(1)}`
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
}

export function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  const cell = (value: unknown) => {
    let text = String(value ?? '')
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }
  const csv = [headers, ...rows.map(row => headers.map(key => row[key]))].map(row => row.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
