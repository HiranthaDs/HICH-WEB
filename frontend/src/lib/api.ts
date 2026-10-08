import type {
  Agreement,
  AuditEvent,
  Client,
  ClientProfile,
  DashboardData,
  Invoice,
  Paginated,
  PortfolioProject,
  PublicAgreement,
  SignAgreementPayload,
  User,
  AgreementTemplate,
  InvoiceVersion,
  OperationTask,
  ChangeOrder,
  PortfolioCollection,
} from './types'

const API_ROOT = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
let refreshRequest: Promise<boolean> | null = null

function refreshSession() {
  if (!refreshRequest) {
    refreshRequest = fetch(`${API_ROOT}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).then((response) => response.ok).catch(() => false).finally(() => { refreshRequest = null })
  }
  return refreshRequest
}

export class ApiError extends Error {
  status: number
  details?: unknown

  constructor(message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown }

function errorMessage(details: unknown, fallback: string) {
  if (!details || typeof details !== 'object') return fallback
  const record = details as Record<string, unknown>
  if (typeof record.message === 'string') return record.message
  if (typeof record.detail === 'string') return record.detail
  if (Array.isArray(record.detail)) {
    const messages = record.detail
      .map((item) => {
        if (!item || typeof item !== 'object') return undefined
        const issue = item as Record<string, unknown>
        if (typeof issue.msg !== 'string') return undefined
        const location = Array.isArray(issue.loc) ? issue.loc.filter(part => !['body', 'query', 'path'].includes(String(part))) : []
        const labels: Record<string, string> = { slug: 'Project URL name', client_id: 'Client', project_value: 'Total project amount', amount: 'Amount', renewal_currency: 'Renewal currency', renewal_amount: 'Renewal amount', project_title: 'Project title', invoice_number: 'Invoice reference' }
        const field = location.map(part => typeof part === 'number' ? String(part + 1) : labels[String(part)] || String(part).replace(/_/g, ' ')).join(' / ')
        const message = location.includes('slug') && issue.type === 'string_pattern_mismatch'
          ? 'Use letters, numbers and single hyphens, for example my-project.'
          : issue.msg.replace(/^Value error, /, '')
        return field ? `${field.charAt(0).toUpperCase()}${field.slice(1)}: ${message}` : message
      })
      .filter((item): item is string => typeof item === 'string')
    if (messages.length) return messages.join(' ')
  }
  return fallback
}

async function request<T>(path: string, options: RequestOptions = {}, retried = false): Promise<T> {
  const isForm = options.body instanceof FormData
  const body: BodyInit | undefined = options.body === undefined
    ? undefined
    : isForm
      ? options.body as FormData
      : JSON.stringify(options.body)
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(isForm ? {} : options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body,
  })

  if (response.status === 401 && !retried && !path.startsWith('/public/') && !['/auth/login', '/auth/refresh', '/auth/recover', '/auth/reset-password'].includes(path)) {
    if (await refreshSession()) return request<T>(path, options, true)
  }

  if (!response.ok) {
    let details: unknown
    try { details = await response.json() } catch { details = await response.text().catch(() => undefined) }
    const message = errorMessage(details, `Request failed (${response.status})`)
    throw new ApiError(message, response.status, details)
  }

  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return response.json() as Promise<T>
  return response.text() as Promise<T>
}

const unwrap = <T>(payload: unknown, keys: string[]): T => {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of keys) if (record[key] !== undefined) return record[key] as T
    if (record.data !== undefined) return record.data as T
  }
  return payload as T
}

const unwrapList = <T>(payload: unknown, keys: string[]): Paginated<T> => {
  const source = unwrap<unknown>(payload, keys)
  if (Array.isArray(source)) return { items: source as T[], total: source.length }
  if (source && typeof source === 'object') {
    const record = source as Record<string, unknown>
    const items = (record.items || record.results || record.data || []) as T[]
    return {
      items: Array.isArray(items) ? items : [],
      total: Number(record.total ?? (Array.isArray(items) ? items.length : 0)),
      page: record.page ? Number(record.page) : undefined,
      pages: record.pages ? Number(record.pages) : undefined,
    }
  }
  return { items: [] }
}

async function listAll<T>(path: string, keys: string[]): Promise<Paginated<T>> {
  const items: T[] = []
  const limit = 200
  while (true) {
    const page = unwrapList<T>(await request(`${path}?limit=${limit}&offset=${items.length}`), keys)
    items.push(...page.items)
    if (page.items.length < limit) return { items, total: items.length }
  }
}

async function download(path: string, fallbackName: string) {
  const response = await fetch(`${API_ROOT}${path}`, { credentials: 'include' })
  if (!response.ok) throw new ApiError('Could not download the document.', response.status)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fallbackName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const api = {
  auth: {
    recover: (email: string) => request<{ message: string }>('/auth/recover', { method: 'POST', body: { email } }),
    resetPassword: (access_token: string, refresh_token: string, password: string) => request<{ message: string }>('/auth/reset-password', { method: 'POST', body: { access_token, refresh_token, password } }),
    async login(email: string, password: string) {
      const payload = await request<unknown>('/auth/login', { method: 'POST', body: { email, password } })
      return unwrap<User>(payload, ['user'])
    },
    async me() {
      const payload = await request<unknown>('/auth/me')
      return unwrap<User>(payload, ['user'])
    },
    logout: () => request<void>('/auth/logout', { method: 'POST' }),
  },
  async dashboard() {
    const payload = await request<unknown>('/dashboard')
    return unwrap<DashboardData>(payload, ['dashboard'])
  },
  clients: {
    async list() { return listAll<Client>('/clients', ['clients']) },
    async profile(id: Client['id']) { return unwrap<ClientProfile>(await request(`/clients/${encodeURIComponent(String(id))}/profile`), ['profile']) },
    async create(data: Partial<Client>) { return unwrap<Client>(await request('/clients', { method: 'POST', body: data }), ['client']) },
    async update(id: Client['id'], data: Partial<Client>) { return unwrap<Client>(await request(`/clients/${id}`, { method: 'PUT', body: data }), ['client']) },
    remove: (id: Client['id']) => request<void>(`/clients/${id}`, { method: 'DELETE' }),
  },
  agreements: {
    async template() { return unwrap<AgreementTemplate>(await request('/agreements/template'), ['template']) },
    async list() { return listAll<Agreement>('/agreements', ['agreements']) },
    async create(data: Partial<Agreement>) { return unwrap<Agreement>(await request('/agreements', { method: 'POST', body: data }), ['agreement']) },
    async update(id: Agreement['id'], data: Partial<Agreement>) { return unwrap<Agreement>(await request(`/agreements/${id}`, { method: 'PUT', body: data }), ['agreement']) },
    remove: (id: Agreement['id']) => request<void>(`/agreements/${id}`, { method: 'DELETE' }),
    async share(id: Agreement['id']) {
      const payload = await request<unknown>(`/agreements/${id}/share`, { method: 'POST' })
      return unwrap<{ url?: string; share_url?: string; token?: string }>(payload, ['share'])
    },
    pdf: (id: Agreement['id'], reference = 'agreement') => download(`/agreements/${id}/pdf`, `${reference}.pdf`),
  },
  invoices: {
    async share(id: Invoice['id'], options: { rotate?: boolean; expires_at?: string | null } = {}) { return request<{ share_url: string; expires_at?: string; invoice?: Invoice }>(`/invoices/${id}/share`, { method: 'POST', body: options }) },
    revoke: (id: Invoice['id']) => request<void>(`/invoices/${id}/share`, { method: 'DELETE' }),
    async versions(id: Invoice['id']) { return unwrap<InvoiceVersion[]>(await request(`/invoices/${id}/versions`), ['versions']) },
    async list() { return listAll<Invoice>('/invoices', ['invoices']) },
    async create(data: Partial<Invoice>) { return unwrap<Invoice>(await request('/invoices', { method: 'POST', body: data }), ['invoice']) },
    async update(id: Invoice['id'], data: Partial<Invoice>) { return unwrap<Invoice>(await request(`/invoices/${id}`, { method: 'PUT', body: data }), ['invoice']) },
    remove: (id: Invoice['id']) => request<void>(`/invoices/${id}`, { method: 'DELETE' }),
  },
  portfolio: {
    async list() { return unwrapList<PortfolioProject>(await request('/portfolio'), ['projects', 'portfolio']) },
    async get(id: PortfolioProject['id']) { return unwrap<PortfolioProject>(await request(`/portfolio/${id}`), ['project']) },
    async create(data: Partial<PortfolioProject>) { return unwrap<PortfolioProject>(await request('/portfolio', { method: 'POST', body: data }), ['project']) },
    async update(id: PortfolioProject['id'], data: Partial<PortfolioProject>) { return unwrap<PortfolioProject>(await request(`/portfolio/${id}`, { method: 'PUT', body: data }), ['project']) },
    remove: (id: PortfolioProject['id']) => request<void>(`/portfolio/${id}`, { method: 'DELETE' }),
    async uploadImages(id: PortfolioProject['id'], files: File[]) {
      const body = new FormData()
      files.forEach((file) => body.append('images', file))
      const payload = await request<unknown>(`/portfolio/${id}/images`, { method: 'POST', body })
      return unwrap<PortfolioProject>(payload, ['project'])
    },
    removeImage: (projectId: PortfolioProject['id'], imageId: string) => request<void>(`/portfolio/${projectId}/images/${imageId}`, { method: 'DELETE' }),
  },
  async audit() { return unwrapList<AuditEvent>(await request('/audit'), ['events', 'audit']) },
  async publicPortfolio() { return unwrapList<PortfolioProject>(await request('/public/portfolio'), ['projects', 'portfolio']) },
  async publicInvoice(token: string) { return unwrap<Invoice>(await request(`/public/invoices/${encodeURIComponent(token)}`), ['invoice']) },
  publicAgreementPdf: (token: string) => download(`/public/agreements/${encodeURIComponent(token)}/pdf`, 'hich-signed-agreement.pdf'),
  operations: {
    async tasks() { return unwrap<OperationTask[]>(await request('/operations/tasks'), ['tasks']) },
    async createTask(data: Partial<OperationTask>) { return unwrap<OperationTask>(await request('/operations/tasks', { method: 'POST', body: data }), ['task']) },
    async updateTask(id: string, data: Partial<OperationTask>) { return unwrap<OperationTask>(await request(`/operations/tasks/${id}`, { method: 'PATCH', body: data }), ['task']) },
    async changes() { return unwrap<ChangeOrder[]>(await request('/operations/changes'), ['changes']) },
    async createChange(data: Partial<ChangeOrder>) { return unwrap<ChangeOrder>(await request('/operations/changes', { method: 'POST', body: data }), ['change']) },
    async shareChange(id: string) { return request<{ share_url: string }>(`/operations/changes/${id}/share`, { method: 'POST' }) },
    async voidChange(id: string) { return request(`/operations/changes/${id}/void`, { method: 'POST' }) },
  },
  collections: {
    async list() { return unwrap<PortfolioCollection[]>(await request('/collections'), ['collections']) },
    async create(data: Partial<PortfolioCollection>) { return unwrap<PortfolioCollection>(await request('/collections', { method: 'POST', body: data }), ['collection']) },
    remove: (id: string) => request(`/collections/${id}`, { method: 'DELETE' }),
    async public(token: string) { return request<{ collection: PortfolioCollection; projects: PortfolioProject[] }>(`/public/collections/${encodeURIComponent(token)}`) },
  },
  async publicChange(token: string) { return unwrap<ChangeOrder>(await request(`/public/changes/${encodeURIComponent(token)}`), ['change']) },
  async approveChange(token: string, data: { signer_name: string; signer_job_role: string; consent: boolean }) { return unwrap<ChangeOrder>(await request(`/public/changes/${encodeURIComponent(token)}/approve`, { method: 'POST', body: data }), ['change']) },
  async publicAgreement(token: string) {
    const payload = await request<unknown>(`/public/agreements/${encodeURIComponent(token)}`)
    return unwrap<PublicAgreement>(payload, ['agreement'])
  },
  async signAgreement(token: string, data: SignAgreementPayload) {
    const payload = await request<unknown>(`/public/agreements/${encodeURIComponent(token)}/sign`, { method: 'POST', body: data })
    return unwrap<PublicAgreement>(payload, ['agreement'])
  },
}
