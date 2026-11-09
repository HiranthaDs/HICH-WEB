import type { Invoice } from './types'

type Phase = NonNullable<Invoice['payments']>[number]
const cents = (value: unknown) => Math.round(Number(value || 0) * 100)

/** Allocate spare funds first, otherwise split only the unreceived part of a phase. */
export function addPaymentPhase(phases: Phase[], total: number, name: string, requestedAmount?: number): Phase[] {
  if (phases.length >= 100) throw new Error('An invoice can contain up to 100 payment phases.')
  const payments = phases.map(phase => ({ ...phase }))
  const remaining = cents(total) - payments.reduce((sum, phase) => sum + cents(phase.amount), 0)
  if (remaining < 0) throw new Error('Correct the over-allocated payment plan before adding another phase.')
  const pending = payments.map((phase, index) => ({ phase, index, available: cents(phase.amount) - cents(phase.paid_amount) }))
    .filter(({ phase, available }) => !(phase.is_paid ?? phase.isPaid) && available >= 2)
  const source = pending.filter(({ phase }) => /final|balance/i.test(phase.name)).at(-1) || pending.at(-1)
  if (requestedAmount !== undefined && (!Number.isFinite(requestedAmount) || cents(requestedAmount) <= 0)) throw new Error('Enter a positive amount for the new payment stage.')
  if (remaining > 0) {
    const amount = requestedAmount === undefined ? remaining : cents(requestedAmount)
    if (amount > remaining) throw new Error('The new stage exceeds the unallocated amount.')
    payments.splice(source && /final|balance/i.test(source.phase.name) ? source.index : payments.length, 0, { name, amount: amount / 100, is_paid: false, status: 'Pending' })
  } else {
    if (!source) throw new Error('There is no unpaid balance to split. Increase the invoice total or edit the payment schedule first.')
    const amount = requestedAmount === undefined ? Math.floor(source.available / 2) : cents(requestedAmount)
    if (amount >= source.available) throw new Error('Leave at least 0.01 in the existing stage, or record its balance without adding a stage.')
    payments[source.index].amount = (cents(source.phase.amount) - amount) / 100
    payments.splice(/final|balance/i.test(source.phase.name) && !cents(source.phase.paid_amount) ? source.index : source.index + 1, 0, { name, amount: amount / 100, is_paid: false, status: 'Pending' })
  }
  return payments
}
