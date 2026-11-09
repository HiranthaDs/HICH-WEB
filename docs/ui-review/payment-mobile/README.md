# Mobile payment review

The admin payment dialog now has separate Record payment, Payment plan, and Receipts sections. Edit payments opens the plan directly; invoice cards have a direct Record payment action.

- Numbered, expandable cards keep the first, second, third, and later stages compact.
- Adding a stage previews both its amount and the existing stage that funds it. Received funds and the invoice total are preserved.
- Unsaved plan changes block receipt submission. Failed saves retain the entered data, and payment retries retain their idempotency key.
- The next unpaid stage is selected automatically. Partial payments and receipt corrections show the resulting balance.
- Amount fields show three-digit comma groups while editing, accept decimals, and submit numeric values. Invoice, renewal, agreement, and additional-work amounts use the same field.
- Phone dialogs keep their save action visible, use decimal keyboards for amounts, and avoid horizontal scrolling.

## Verification

All browser checks intercept API requests with synthetic fixtures. They do not change live client records or send messages.

- `npm run build`: production TypeScript / Vite build.
- `npm run test:ui:admin-mobile`: 122 layout and form checks across 11 admin routes.
- `npm run test:ui:payments-mobile`: 35 payment layout and workflow checks, including first through fourth payments, failed-save retries, receipt correction, comma editing, validation, and cent rounding.
- `npm run test:ui:portal`: 10 portal regression checks.
- `npm run test:ui:renewals`: 8 renewal workflow checks plus allocation assertions.
- `npm run test:ui:requested-fixes`: agreement creation with blank and zero visiting fees.
- `node scripts/client-work-invoices-smoke.cjs`: new-work invoices with decimal amounts at desktop and phone widths.

Viewport widths: 320, 360, 390, 430, 740 (landscape), 768, and 1440 pixels. Keyboard space is approximated with a reduced viewport. Real iOS / Android device testing was not performed.

## Phone screenshots

- [Record payment](record-390.png)
- [Compact payment plan](plan-390.png)
- [Preview a new stage](add-stage-390.png)
- [Four payment stages](four-stages-390.png)
