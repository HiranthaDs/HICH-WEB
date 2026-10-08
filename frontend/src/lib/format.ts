export const formatCurrency = (value = 0, currency = 'LKR') => {
  try {
    return new Intl.NumberFormat('en-LK', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${currency} ${new Intl.NumberFormat('en-US').format(value)}`
  }
}

export const formatDate = (value?: string, options?: Intl.DateTimeFormatOptions) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-LK', { timeZone: 'Asia/Colombo', ...(options ?? {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }) }).format(date)
}

export const formatRelative = (value?: string) => {
  if (!value) return 'Recently'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return formatter.format(days, 'day')
  return formatDate(value)
}

export const initials = (name?: string) => {
  if (!name) return 'H'
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
}

export const titleCase = (value?: string) => (value || 'unknown')
  .replace(/[_-]/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase())

export const getClientName = (client?: string | { name?: string; company?: string }, fallback?: string) => {
  if (typeof client === 'string') return client
  return client?.company || client?.name || fallback || 'Unassigned client'
}

export const classNames = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')
