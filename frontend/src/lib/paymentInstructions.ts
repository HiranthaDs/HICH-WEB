export const DEFAULT_PAYMENT_INSTRUCTIONS = `Account Name: Hich Web
Account Number: 119020299485
Bank: HNB (Hatton National Bank)
Branch: Kandana`

export const withDefaultPaymentInstructions = (value?: string) => {
  const instructions = value?.trim() || ''
  if (instructions.includes('119020299485')) return instructions
  return instructions ? `${instructions}\n\n${DEFAULT_PAYMENT_INSTRUCTIONS}` : DEFAULT_PAYMENT_INSTRUCTIONS
}
