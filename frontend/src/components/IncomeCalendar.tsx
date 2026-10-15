import { CalendarDays, ChevronLeft, ChevronRight, CircleDollarSign, Clock3, FileText, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { formatCurrency, formatDate } from '../lib/format'
import type { CalendarEvent, CalendarEventType, CalendarReport } from '../lib/types'
import { EmptyState, LoadingState } from './ui'

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const colomboToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })

function parts(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

function isoDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day, 12)).toISOString().slice(0, 10)
}

function monthRange(monthValue: string) {
  const { year, month } = parts(`${monthValue}-01`)
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start: isoDate(year, month, 1), end: isoDate(year, month, last) }
}

function shiftMonth(value: string, distance: number) {
  const { year, month } = parts(`${value}-01`)
  return new Date(Date.UTC(year, month - 1 + distance, 1, 12)).toISOString().slice(0, 7)
}

type CalendarMode = 'income' | 'renewals'

function eventLabel(type: CalendarEventType, mode: CalendarMode) {
  if (type === 'receipt') return mode === 'renewals' ? 'Renewal collected' : 'Received'
  if (type === 'invoice_due') return mode === 'renewals' ? 'Collection due' : 'Invoice due'
  return mode === 'renewals' ? 'Service renewal' : 'Renewal due'
}

function eventDestination(event: CalendarEvent) {
  if (event.invoice_id) return `/admin/invoices?invoice=${encodeURIComponent(String(event.invoice_id))}`
  if (event.agreement_id) return `/admin/agreements?search=${encodeURIComponent(event.reference || event.project_title || event.client_name)}`
  if (event.client_id) return `/admin/clients?client=${encodeURIComponent(String(event.client_id))}`
  return '/admin/income'
}

function EventIcon({ type }: { type: CalendarEventType }) {
  const Icon = type === 'receipt' ? CircleDollarSign : type === 'invoice_due' ? FileText : RefreshCw
  return <Icon size={16} aria-hidden="true" />
}

function EventDetail({ event, mode }: { event: CalendarEvent; mode: CalendarMode }) {
  return <article className={`income-calendar__detail income-calendar__detail--${event.type}`}>
    <span className="income-calendar__detail-icon"><EventIcon type={event.type} /></span>
    <div>
      <small>{eventLabel(event.type, mode)}{event.status ? ` · ${event.status}` : ''}</small>
      <strong>{event.client_name}</strong>
      <p>{event.reference || event.project_title || event.title}</p>
      {event.type === 'receipt' && (event.method || event.payment_reference) && <em>{[event.method, event.payment_reference].filter(Boolean).join(' · ')}</em>}
    </div>
    <div className="income-calendar__detail-value">
      <strong>{formatCurrency(Number(event.amount || 0), event.currency || 'LKR')}</strong>
      <Link className="text-link" to={eventDestination(event)}>Open record</Link>
    </div>
  </article>
}

export function IncomeCalendar({ mode = 'income', clientId }: { mode?: CalendarMode; clientId?: string }) {
  const today = colomboToday()
  const [month, setMonth] = useState(today.slice(0, 7))
  const [selectedDate, setSelectedDate] = useState(today)
  const [report, setReport] = useState<CalendarReport | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const generation = useRef(0)

  const load = useCallback(async () => {
    const attempt = ++generation.current
    const range = monthRange(month)
    setBusy(true); setError(''); setReport(null)
    try {
      const result = await api.calendar(range.start, range.end)
      if (attempt === generation.current) setReport(result)
    } catch (requestError) {
      if (attempt === generation.current) setError(requestError instanceof Error ? requestError.message : 'Calendar details could not be loaded.')
    } finally {
      if (attempt === generation.current) setBusy(false)
    }
  }, [month])

  useEffect(() => { void load() }, [load])

  const visibleEvents = useMemo(() => (report?.events || []).filter(event => {
    if (clientId && String(event.client_id) !== clientId) return false
    return mode === 'income' || event.type === 'renewal_due' || event.invoice_kind === 'renewal'
  }), [report, mode, clientId])

  const eventsByDate = useMemo(() => visibleEvents.reduce<Record<string, CalendarEvent[]>>((grouped, event) => {
    if (!grouped[event.date]) grouped[event.date] = []
    grouped[event.date].push(event)
    return grouped
  }, {}), [visibleEvents])

  const days = useMemo(() => {
    const { year, month: monthNumber } = parts(`${month}-01`)
    const firstWeekday = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
    const count = Math.ceil((firstWeekday + daysInMonth) / 7) * 7
    return Array.from({ length: count }, (_, index) => {
      const date = isoDate(year, monthNumber, index - firstWeekday + 1)
      return { date, day: parts(date).day, current: date.slice(0, 7) === month }
    })
  }, [month])

  const groupedEventDays = useMemo(() => Object.entries(eventsByDate).sort(([left], [right]) => left.localeCompare(right)), [eventsByDate])
  const selectedEvents = eventsByDate[selectedDate] || []
  const counts = useMemo(() => visibleEvents.reduce<Record<CalendarEventType, number>>((total, event) => {
    total[event.type] += 1
    return total
  }, { receipt: 0, invoice_due: 0, renewal_due: 0 }), [visibleEvents])
  const monthTitle = new Intl.DateTimeFormat('en-LK', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`))

  const chooseMonth = (next: string) => {
    setMonth(next)
    setSelectedDate(next === today.slice(0, 7) ? today : `${next}-01`)
  }

  const headingId = mode === 'renewals' ? 'client-renewal-calendar-heading' : 'income-calendar-heading'

  return <section className="panel income-calendar" aria-labelledby={headingId} aria-busy={busy}>
    <header className="income-calendar__header">
      <div>
        <p className="eyebrow">{mode === 'renewals' ? 'Clients & recurring services' : 'Cash & commitments'}</p>
        <h2 id={headingId}>{mode === 'renewals' ? 'Renewal collection calendar' : 'Income calendar'}</h2>
        <p>{mode === 'renewals' ? 'Renewal payment deadlines, collected renewal payments and service expiry dates in one monthly view.' : 'Cleared receipts, open invoice deadlines and service renewals in one monthly view.'}</p>
      </div>
      <div className="income-calendar__navigation">
        <button className="icon-button" type="button" onClick={() => chooseMonth(shiftMonth(month, -1))} aria-label="Previous month"><ChevronLeft size={18} /></button>
        <strong aria-live="polite">{monthTitle}</strong>
        <button className="icon-button" type="button" onClick={() => chooseMonth(shiftMonth(month, 1))} aria-label="Next month"><ChevronRight size={18} /></button>
        <button className="button button--ghost button--sm" type="button" onClick={() => chooseMonth(today.slice(0, 7))}>Today</button>
      </div>
    </header>

    <div className="income-calendar__legend" aria-label="Calendar event totals">
      <span className="income-calendar__legend-item income-calendar__legend-item--receipt"><i />{mode === 'renewals' ? 'Renewal collected' : 'Received'} <strong>{counts.receipt}</strong></span>
      <span className="income-calendar__legend-item income-calendar__legend-item--invoice_due"><i />{mode === 'renewals' ? 'Collection due' : 'Invoice due'} <strong>{counts.invoice_due}</strong></span>
      <span className="income-calendar__legend-item income-calendar__legend-item--renewal_due"><i />{mode === 'renewals' ? 'Service renewal' : 'Renewal due'} <strong>{counts.renewal_due}</strong></span>
    </div>

    {error && <div className="inline-alert inline-alert--error" role="alert"><Clock3 size={17} /><span>{error}</span><button className="text-link" type="button" onClick={() => void load()}>Retry</button></div>}
    {busy && !report ? <LoadingState compact label="Loading calendar…" /> : <>
      <div className="income-calendar__grid" role="grid" aria-label={`${monthTitle} ${mode === 'renewals' ? 'client renewal events' : 'income and renewal events'}`}>
        {weekdays.map(day => <div className="income-calendar__weekday" role="columnheader" key={day}>{day}</div>)}
        {days.map(day => {
          const dayEvents = eventsByDate[day.date] || []
          return <div className={`income-calendar__day${day.current ? '' : ' income-calendar__day--outside'}${day.date === today ? ' income-calendar__day--today' : ''}${day.date === selectedDate ? ' income-calendar__day--selected' : ''}`} role="gridcell" aria-selected={day.date === selectedDate} key={day.date}>
            <button type="button" className="income-calendar__date" onClick={() => setSelectedDate(day.date)} aria-label={`${formatDate(day.date)}, ${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}`} aria-pressed={day.date === selectedDate}>{day.day}</button>
            <div className="income-calendar__day-events">
              {dayEvents.slice(0, 2).map(event => <Link key={event.id} to={eventDestination(event)} className={`income-calendar__event income-calendar__event--${event.type}`} title={`${eventLabel(event.type, mode)}: ${event.client_name}, ${formatCurrency(Number(event.amount), event.currency)}`}><span>{eventLabel(event.type, mode)}</span><strong>{formatCurrency(Number(event.amount), event.currency)}</strong></Link>)}
              {dayEvents.length > 2 && <button type="button" onClick={() => setSelectedDate(day.date)}>+{dayEvents.length - 2} more</button>}
            </div>
          </div>
        })}
      </div>

      <div className="income-calendar__selection">
        <header><div><CalendarDays size={18} /><h3>{formatDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3></div><span>{selectedEvents.length} event{selectedEvents.length === 1 ? '' : 's'}</span></header>
        {selectedEvents.length ? <div className="income-calendar__details">{selectedEvents.map(event => <EventDetail key={event.id} event={event} mode={mode} />)}</div> : <p>{mode === 'renewals' ? 'No renewal collection or service date is recorded for this day.' : 'No income or renewal activity is recorded for this day.'}</p>}
      </div>

      <div className="income-calendar__agenda" aria-label={`${monthTitle} agenda`}>
        {groupedEventDays.length ? groupedEventDays.map(([date, events]) => <section key={date}>
          <header><strong>{formatDate(date, { weekday: 'short', day: 'numeric', month: 'short' })}</strong><span>{events.length}</span></header>
          <div>{events.map(event => <EventDetail key={event.id} event={event} mode={mode} />)}</div>
        </section>) : <EmptyState icon={CalendarDays} title={mode === 'renewals' ? 'No renewals scheduled this month' : 'Nothing scheduled this month'} description={mode === 'renewals' ? 'Add a service expiry date or prepare a renewal invoice to place it on this calendar.' : 'Cleared receipts, invoice deadlines and renewal dates will appear here.'} />}
      </div>
    </>}
  </section>
}
