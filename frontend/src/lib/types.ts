export type Id = string | number

export interface User {
  id: Id
  email: string
  name?: string
  role?: string
  avatar_url?: string | null
}

export interface Client {
  id: Id
  name: string
  email?: string
  company?: string
  phone?: string
  address?: string
  status?: 'active' | 'lead' | 'archived' | string
  project_count?: number
  total_value?: number
  totals_by_currency?: Record<string, number>
  created_at?: string
  updated_at?: string
  last_activity?: string
  notes?: string
}

export interface ClientProfile {
  client: Client
  invoices: Invoice[]
  agreements: Agreement[]
}

export type AgreementStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'expired' | 'void' | string

export interface Agreement {
  renewal_amount?: number
  renewal_currency?: string
  renewal_due_date?: string
  id: Id
  reference?: string
  title: string
  status: AgreementStatus
  client_id?: Id
  client?: Client | string
  client_name?: string
  client_email?: string
  client_phone?: string
  signer_job_role?: string
  version?: number
  expected_version?: number
  content_sha256?: string
  consent_text?: string
  signed_record_sha256?: string
  project_title?: string
  description?: string
  terms?: string | string[] | Record<string, unknown>
  amount?: number
  currency?: string
  created_at?: string
  updated_at?: string
  sent_at?: string
  viewed_at?: string
  expires_at?: string
  signed_at?: string
  signer_name?: string
  share_url?: string
}

export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'overdue' | 'void' | string

export interface Invoice {
  id: Id
  reference?: string
  client_id?: Id
  client?: Client | string
  client_name?: string
  project_title?: string
  status: InvoiceStatus
  amount: number
  paid_amount?: number
  currency?: string
  issue_date?: string
  due_date?: string
  created_at?: string
  payment_method?: string
  notes?: string
  share_url?: string
  phone?: string
  payment_instructions?: string
  customer_note?: string
  revision?: number
  expected_revision?: number
  balance_due?: number
  updated_at?: string
  share_expires_at?: string
  renewal_amount?: number
  renewal_currency?: string
  renewal_due_date?: string
  payments?: Array<{
    id?: Id
    name: string
    amount: number
    status?: string
    is_paid?: boolean
    isPaid?: boolean
    paid_at?: string
  }>
}

export interface PortfolioProject {
  id: Id
  slug?: string
  title: string
  url?: string
  category?: string
  main_description?: string
  sub_description?: string
  images?: string[]
  image_urls?: string[]
  image_records?: Array<{
    id: string
    storage_path: string
    public_url?: string
    alt_text?: string
    position?: number
    is_cover?: boolean
  }>
  published?: boolean
  featured?: boolean
  sort_order?: number
  created_at?: string
  updated_at?: string
}

export interface AuditEvent {
  id: Id
  action: string
  actor?: string
  actor_email?: string
  target?: string
  details?: string
  created_at: string
  metadata?: Record<string, unknown>
}

export interface RevenuePoint {
  label?: string
  date?: string
  month?: string
  value?: number
  revenue?: number
  paid?: number
  pending?: number
}

export interface DashboardData {
  metrics?: {
    total_revenue?: number
    pending_revenue?: number
    active_clients?: number
    awaiting_signatures?: number
    revenue_change?: number
    clients_change?: number
  }
  total_revenue?: number
  pending_revenue?: number
  active_clients?: number
  awaiting_signatures?: number
  revenue?: RevenuePoint[]
  recent_activity?: AuditEvent[]
  upcoming_invoices?: Invoice[]
  upcoming_renewals?: Array<{
    id?: Id
    client_name?: string
    client?: Client | string
    phone?: string
    amount?: number
    currency?: string
    due_date?: string
    share_url?: string
    invoice_id?: Id
  }>
  agreement_statuses?: Array<{ name?: string; status?: string; value?: number; count?: number }>
  intelligence?: BusinessIntelligence
}

export type InsightSeverity = 'critical' | 'warning' | 'opportunity' | 'success' | 'info'

export interface BusinessInsight {
  id: string
  severity: InsightSeverity
  category: string
  title: string
  summary: string
  recommendation: string
  action_label?: string
  action_path?: string
  impact?: number
}

export interface BusinessIntelligence {
  health_score: number
  risk_level: 'high' | 'medium' | 'low'
  narrative: string
  cash_forecast_30d: number
  overdue_balance: number
  revenue_momentum_percent?: number | null
  generated_at: string
  insights: BusinessInsight[]
}

export interface PublicAgreement extends Agreement {
  studio_name?: string
  studio_email?: string
  clauses?: Array<{ title?: string; body: string }>
  signed?: boolean
}

export interface SignAgreementPayload {
  signer_name: string
  signer_job_role: string
  expected_version?: number
  expected_content_sha256?: string
  signer_email?: string
  typed_signature?: string
  signature_data_url?: string
  consent: boolean
  signed_at?: string
}

export interface AgreementTemplate {
  id: string
  title: string
  description: string
  terms: Agreement['terms']
  consent_text: string
  review_note: string
}

export interface InvoiceVersion { version: number; created_at: string; snapshot: Partial<Invoice> & { project_value?: number; payment_records?: Array<{ amount: number }> } }
export interface OperationTask { id: string; title: string; due_date?: string; priority: string; status: string; notes?: string; client_id?: string; clients?: { name: string }; created_at: string }
export interface ChangeOrder { id: string; agreement_id: string; title: string; description: string; amount: number; currency: string; extra_days: number; status: string; share_url?: string; created_at: string; approved_at?: string; signer_name?: string; signer_job_role?: string; project_title?: string; reference?: string }
export interface PortfolioCollection { id: string; title: string; description?: string; category?: string; project_ids: string[]; share_url: string; created_at: string }

export interface Paginated<T> {
  items: T[]
  total?: number
  page?: number
  pages?: number
}
