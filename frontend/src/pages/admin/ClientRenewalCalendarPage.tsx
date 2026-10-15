import { CalendarDays, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { IncomeCalendar } from '../../components/IncomeCalendar'
import { PageHeader, Select } from '../../components/ui'
import { api } from '../../lib/api'
import type { Client } from '../../lib/types'

export function ClientRenewalCalendarPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [clients, setClients] = useState<Client[]>([])
  const [error, setError] = useState('')
  const clientId = searchParams.get('client') || ''

  useEffect(() => {
    let cancelled = false
    void api.clients.list().then(result => {
      if (!cancelled) setClients(result.items)
    }).catch(requestError => {
      if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Client filters could not be loaded.')
    })
    return () => { cancelled = true }
  }, [])

  const selectedClient = useMemo(() => clients.find(client => String(client.id) === clientId), [clients, clientId])
  const chooseClient = (value: string) => setSearchParams(current => {
    const next = new URLSearchParams(current)
    if (value) next.set('client', value)
    else next.delete('client')
    return next
  })

  return <div className="admin-page">
    <PageHeader
      eyebrow="Relationships"
      title="Client renewal calendar"
      description="Plan renewal collections before service expiry, confirm received renewal payments and open the related client record from one calendar."
      action={<Link className="button button--secondary button--md" to="/admin/clients"><Users size={18} />Clients</Link>}
    />
    <section className="toolbar panel panel--flat">
      <div><CalendarDays size={18} /><strong>{selectedClient ? `${selectedClient.name} renewals` : 'All client renewals'}</strong></div>
      <div className="toolbar__right"><Select aria-label="Filter renewal calendar by client" value={clientId} onChange={event => chooseClient(event.target.value)}><option value="">All clients</option>{clients.map(client => <option key={client.id} value={String(client.id)}>{client.company ? `${client.company} — ${client.name}` : client.name}</option>)}</Select></div>
    </section>
    {error && <div className="data-notice" role="status">{error} The calendar remains available without the client filter.</div>}
    <IncomeCalendar mode="renewals" clientId={clientId || undefined} />
  </div>
}
