/* Synthetic intercepted requests only: no real clients, email or WhatsApp sends. */
const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../frontend/node_modules/typescript');
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const output = path.resolve(__dirname, '../docs/ui-review/renewal-invoices');
fs.mkdirSync(output, { recursive: true });

const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../frontend/src/lib/paymentPlan.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const plan = {}; new Function('exports', compiled.outputText)(plan);
const split = plan.addPaymentPhase([{ id: 'final', name: 'Final', amount: 100, paid_amount: 90 }], 100, 'Third instalment');
assert.equal(split[0].amount, 5); assert.equal(split[1].amount, 95); assert.equal(split[1].paid_amount, 90);
assert.equal(plan.addPaymentPhase([{ name: 'Advance', amount: 0.02 }], 0.02, 'Final')[0].amount, 0.01);
assert.throws(() => plan.addPaymentPhase([{ name: 'Final', amount: 100, is_paid: true }], 100, 'Extra'), /no unpaid balance/);

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [], writes = [], checks = [];
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
    const past = new Date(new Date(`${today}T12:00:00+05:30`).getTime() - 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
    const client = { id: 'client-1', name: 'Test Client', email: 'client@example.test', phone: '+94771111111' };
    let source = { id: 'source-1', invoice_kind: 'project', reference: 'INV-PROJECT', client_id: client.id, client_name: client.name, client_email: client.email, phone: client.phone,
      project_title: 'Business website', currency: 'GBP', amount: 100000, paid_amount: 9000, status: 'partial', revision: 1, issue_date: today, due_date: today,
      renewal_amount: 0, renewal_currency: 'LKR', renewal_due_date: past, payment_instructions: 'Bank account: TEST-ONLY',
      payments: ['Advance', 'Design', 'Development', 'Testing', 'Final balance'].map((name, i) => ({ id: `phase-${i}`, name, amount: 20000, paid_amount: i === 1 ? 9000 : 0, is_paid: false })),
      payment_records: [{ id: 'project-receipt', amount: 9000, currency: 'GBP', milestone_id: 'phase-1', paid_at: today }] };
    let renewal = null;
    let hideRenewalFromList = false;
    let failNextRenewalShare = false;
    const renewalLookups = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const endpoint = url.pathname.slice(4), method = request.method();
      const data = request.postData() && request.headers()['content-type']?.includes('json') ? JSON.parse(request.postData()) : {};
      if (method !== 'GET') writes.push({ endpoint, method, data });
      let payload = {}, status = 200;
      if (endpoint === '/auth/me') payload = { user: { id: 'owner', role: 'admin', email: 'owner@example.test' } };
      else if (endpoint === '/clients') payload = [client];
      else if (endpoint === '/communications/email-status') payload = { available: false };
      else if (endpoint === '/invoices') payload = renewal && !hideRenewalFromList ? [renewal, source] : [source];
      else if (endpoint === '/invoices/source-1' && method === 'GET') payload = { invoice: source };
      else if (endpoint === '/invoices/source-1/renewal-invoice' && method === 'GET') {
        renewalLookups.push(url.searchParams.get('period_date'));
        payload = { invoice: renewal?.renewal_period_date === url.searchParams.get('period_date') ? renewal : null };
      }
      else if (endpoint === '/invoices/source-1' && method === 'PUT') { source = { ...source, ...data, paid_amount: 9000, revision: 2, payments: data.payments.map((phase, i) => ({ ...phase, id: phase.id || `extra-${i}` })) }; payload = { invoice: source }; }
      else if (endpoint === '/invoices/source-1/renewal-invoice') {
        const amount = data.items.reduce((sum, item) => sum + item.amount, 0), fee = data.apply_late_fee ? Math.round(amount * 18) / 100 : 0;
        renewal ||= { id: 'renewal-1', reference: 'REN-TEST', invoice_kind: 'renewal', renewal_source_invoice_id: source.id, renewal_period_date: data.renewal_period_date,
          client_id: client.id, client_name: client.name, client_email: client.email, phone: client.phone, project_title: 'Domain & hosting renewal — Business website',
          currency: data.currency, amount: amount + fee, paid_amount: 0, balance_due: amount + fee, status: 'draft', issue_date: today, due_date: data.due_date, revision: 1,
          renewal_items: data.items, renewal_late_fee: fee, renewal_late_fee_accepted: data.late_fee_accepted, payment_instructions: source.payment_instructions,
          payments: [{ id: 'renewal-phase', name: 'Renewal payment', amount: amount + fee, paid_amount: 0, is_paid: false }], payment_records: [] };
        payload = { invoice: renewal };
      }
      else if (endpoint === '/invoices/renewal-1/payments') {
        renewal.payment_records.push({ id: `renewal-receipt-${renewal.payment_records.length}`, receipt_number: `RCT-0000000${renewal.payment_records.length + 1}`, ...data });
        renewal.paid_amount += data.amount; renewal.balance_due = renewal.amount - renewal.paid_amount;
        renewal.status = renewal.balance_due ? 'partial' : 'paid'; if (renewal.status === 'paid') source.renewal_due_date = `${Number(past.slice(0, 4)) + 1}${past.slice(4)}`; const phase = renewal.payments.find(phase => phase.id === data.milestone_id); if (phase) { phase.paid_amount += data.amount; phase.is_paid = phase.paid_amount >= phase.amount; } payload = { invoice: renewal, payment: renewal.payment_records.at(-1) };
      }
      else if (endpoint.endsWith('/share')) {
        if (endpoint.includes('renewal-1') && failNextRenewalShare) { failNextRenewalShare = false; status = 503; payload = { detail: 'Synthetic link preparation failure. Please retry.' }; }
        else { if (endpoint.includes('renewal-1') && renewal.status === 'draft') renewal.status = 'sent'; payload = { invoice: endpoint.includes('renewal-1') ? renewal : source, share_url: base + (endpoint.includes('renewal-1') ? '/invoice/renewal-test' : '/invoice/source-test') }; }
      }
      else if (endpoint === '/invoices/renewal-1') payload = { invoice: renewal };
      else if (endpoint === '/public/invoices/renewal-test') payload = { invoice: renewal };
      else { status = 404; payload = { detail: 'Unexpected synthetic endpoint' }; }
      request.respond({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    const go = route => page.goto(base + route, { waitUntil: 'networkidle0' });
    const click = async (text, scope = 'body') => {
      const handle = await page.evaluateHandle((text, scope) => [...document.querySelectorAll(`${scope} button, ${scope} a`)].find(e => e.textContent.trim() === text && e.getBoundingClientRect().height > 0), text, scope);
      assert.ok(handle.asElement(), `Missing button ${text}`); await handle.asElement().click(); await handle.dispose();
    };
    const invoiceAction = async (reference, action) => {
      const opened = await page.evaluate(reference => {
        const row = [...document.querySelectorAll('.invoice-row')].find(element => element.textContent.includes(reference));
        const button = row && [...row.querySelectorAll('.invoice-row__actions button')].find(element => element.textContent.trim() === 'Actions');
        if (!button) return false;
        button.click();
        return true;
      }, reference);
      assert.ok(opened, `Missing Actions menu for ${reference}`);
      await page.waitForSelector('.invoice-actions-menu');
      await click(action, '.invoice-actions-menu');
    };
    const field = async label => {
      const id = await page.evaluate(label => [...document.querySelectorAll('label.field')].find(e => e.querySelector('.field__label')?.firstChild?.textContent.trim() === label)?.querySelector('input,select,textarea')?.id, label);
      assert.ok(id, `Missing field ${label}`); return `[id="${id}"]`;
    };
    const fill = async (label, value) => { const selector = await field(label); await page.$eval(selector, (e, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); }, value); };
    const noOverflow = async label => { await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1, { timeout: 2000 }).catch(() => {}); const details = await page.evaluate(() => ({ ok: document.documentElement.scrollWidth <= innerWidth + 1, elements: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => ({ tag: e.tagName, cls: e.className, text: e.textContent.slice(0, 65), right: e.getBoundingClientRect().right })).slice(-10) })); if (!details.ok) { await page.screenshot({ path: path.join(output, 'overflow-debug.png'), fullPage: true }); console.log(details); } assert.ok(details.ok, `Overflow: ${label}`); };
    await page.setViewport({ width: 1440, height: 1000 }); await go('/admin/invoices');
    const invoiceNavigation = await page.evaluate(() => ({
      current: document.querySelector('.invoice-sections [aria-current="page"]')?.textContent.trim(),
      completed: [...document.querySelectorAll('.invoice-sections button')].some(button => button.textContent.trim().startsWith('Completed')),
      actions: [...document.querySelectorAll('.invoice-row__actions button')].filter(button => button.textContent.trim() === 'Actions').length,
    }));
    assert.ok(invoiceNavigation.current?.startsWith('Pending')); assert.equal(invoiceNavigation.completed, true); assert.equal(invoiceNavigation.actions, 1);
    checks.push('Pending invoices are the default, Completed is separate, and the source invoice has one Actions button');
    await invoiceAction('INV-PROJECT', 'Edit payments');
    for (let i = 0; i < 4; i++) await click('Add phase');
    await click('Add mid payment');
    assert.equal(await page.$$eval('.milestone-row', rows => rows.length), 10);
    await click('Save changes', '.modal'); await page.waitForSelector('.share-panel textarea');
    const saved = writes.find(write => write.method === 'PUT');
    assert.equal(saved.data.payments.length, 10); assert.equal(saved.data.payments.reduce((sum, phase) => sum + phase.amount, 0), 100000);
    assert.equal(saved.data.payments.find(phase => phase.id === 'phase-1').paid_amount, 9000);
    checks.push('Ten phases save without increasing the agreed total or changing partial receipts; cent rounding and fully-paid rejection');

    await go('/admin/invoices?section=renewals');
    await click('Set up renewal', '.renewal-cycle');
    await page.waitForSelector('.invoice-form--renewal-first');
    const projectSharesBeforeSetup = writes.filter(write => write.endpoint === '/invoices/source-1/share').length;
    await fill('Renewal amount', '12000');
    await click('Save & prepare renewal', '.modal');
    await page.waitForSelector('#renewal-invoice-form');
    assert.equal(writes.filter(write => write.endpoint === '/invoices/source-1/share').length, projectSharesBeforeSetup);
    assert.equal(await page.$eval(await field('Service amount 1'), element => element.value), '12000');
    checks.push('Incomplete renewal setup saves the annual charge and continues to renewal preparation without opening the original project invoice message');

    await go('/admin/invoices?section=renewals&renewal=source-1');
    await page.waitForSelector('#renewal-invoice-form');
    assert.equal(await page.$eval('.invoice-sections [aria-current="page"]', element => element.textContent.trim().startsWith('Renewals')), true);
    assert.deepEqual(renewalLookups, [past, past]);
    assert.equal(await page.$eval(await field('Billing currency'), e => e.value), 'LKR');
    await fill('Service description 1', 'example.test domain renewal'); await page.select(await field('Service 1'), 'domain'); assert.equal(await page.$eval(await field('Service description 1'), e => e.value), 'example.test domain renewal'); await fill('Service amount 1', '4000'); await click('Add service'); await fill('Service amount 2', '8000');
    assert.equal(await page.$eval('.renewal-fee-options label:nth-child(2) input', e => e.disabled), true);
    await page.click('.renewal-fee-options label:nth-child(1) input'); await page.click('.renewal-fee-options label:nth-child(2) input');
    for (const width of [390, 320]) { await page.setViewport({ width, height: 844 }); await noOverflow(`Renewal form ${width}`); }
    await page.setViewport({ width: 1440, height: 1000 }); await click('Create & record payment'); await page.waitForSelector('#receipt-form');
    await fill('Payment amount (LKR)', '5000'); await fill('Transfer / receipt reference', 'RENEWAL-PARTIAL'); await click('Save payment & prepare receipt'); await page.waitForSelector('.share-panel textarea');
    assert.equal(renewal.amount, 14160); assert.equal(renewal.status, 'partial');
    assert.ok((await page.$eval('.share-panel textarea', e => e.value)).includes('9,160'));
    hideRenewalFromList = true;
    await go('/admin/invoices'); await invoiceAction('INV-PROJECT', 'Renewal invoice');
    await page.waitForSelector('.renewal-review');
    assert.ok((await page.$eval('.renewal-review', element => element.textContent)).includes('9,160'));
    assert.equal(writes.filter(write => write.endpoint.endsWith('/renewal-invoice')).length, 1);
    await click('Record payment', '.renewal-review'); await page.waitForSelector('#receipt-form');
    hideRenewalFromList = false;
    checks.push('Deep link opens renewal form, custom descriptions survive service changes, authoritative cycle lookup reuses a partial invoice missing from the list');
    await fill('Transfer / receipt reference', 'RENEWAL-FINAL'); await click('Save payment & prepare receipt'); await page.waitForSelector('.share-panel textarea');
    const message = await page.$eval('.share-panel textarea', e => e.value);
    assert.equal(renewal.status, 'paid'); assert.equal(renewal.payment_records.length, 2);
    assert.ok(message.includes('RCT-00000002') && message.replace(/\s/g, ' ').includes('Remaining balance: LKR 0.00'));
    assert.ok(!message.includes('100,000') && !message.includes('9,000') && !message.includes('GBP'));
    await page.screenshot({ path: path.join(output, 'paid-renewal-message.png'), fullPage: true });
    checks.push('Separate domain/hosting renewal, independent currency, accepted itemised 18% fee, partial then final payment and renewal-only paid message');

    await go('/admin/invoices'); await page.click('.invoice-sections button:nth-child(2)');
    await page.waitForFunction(() => document.querySelector('.invoice-sections [aria-current="page"]')?.textContent.trim().startsWith('Completed'));
    assert.equal(await page.$$eval('.invoice-row', rows => rows.length), 1);
    assert.ok((await page.$eval('.invoice-row', row => row.textContent)).includes('REN-TEST'));
    assert.equal(await page.$$eval('.invoice-row__actions button', buttons => buttons.filter(button => button.textContent.trim() === 'Actions').length), 1);
    await page.click('.invoice-sections button:nth-child(4)');
    await page.waitForSelector('.renewal-cycle');
    assert.equal(await page.$$eval('.renewal-cycle', rows => rows.length), 2);
    for (const width of [390, 320]) {
      await page.setViewport({ width, height: 844 }); await noOverflow(`Renewal workspace ${width}`);
      assert.ok(await page.$$eval('.invoice-sections button', buttons => buttons.every(button => { const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; })), `All invoice sections visible at ${width}`);
    }
    await page.screenshot({ path: path.join(output, 'renewals-workspace-mobile.png'), fullPage: true });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(output, 'renewals-workspace-desktop.png'), fullPage: true });
    await click('Needs action', '.renewal-filters');
    assert.equal(await page.$$eval('.renewal-cycle', rows => rows.length), 0);
    await click('Upcoming', '.renewal-filters');
    assert.equal(await page.$$eval('.renewal-cycle', rows => rows.length), 1);
    assert.ok((await page.$eval('.renewal-cycle', row => row.textContent)).includes('Upcoming'));
    await click('Paid', '.renewal-filters');
    assert.equal(await page.$$eval('.renewal-cycle', rows => rows.length), 1);
    await page.evaluate(() => {
      const original = URL.createObjectURL;
      URL.createObjectURL = function(blob) { if (blob.type.startsWith('text/csv')) window.renewalExportText = blob.text(); return original.call(this, blob); };
    });
    await click('Export shown', '.renewal-controls');
    const exported = await page.evaluate(() => window.renewalExportText);
    assert.equal(exported.trim().split(/\r?\n/).length, 2);
    assert.ok(exported.includes('REN-TEST') && exported.includes('paid'));
    checks.push('All invoice sections remain visible on mobile; renewal CSV export includes only the selected paid cycle');
    await click('Review', '.renewal-cycle'); await page.waitForSelector('.renewal-review');
    assert.ok(!(await page.$eval('.renewal-review', element => element.textContent)).includes('Record payment'));
    failNextRenewalShare = true;
    await click('Send paid renewal invoice', '.renewal-review');
    await page.waitForFunction(() => document.body.textContent.includes('Synthetic link preparation failure'));
    assert.ok(await page.$('.renewal-review'));
    await click('Send paid renewal invoice', '.renewal-review'); await page.waitForSelector('.share-panel textarea');
    const paidMessage = await page.$eval('.share-panel textarea', e => e.value);
    assert.ok(paidMessage.includes('paid in full') && !paidMessage.includes('payment is overdue'));
    assert.equal(writes.filter(write => write.endpoint.endsWith('/renewal-invoice')).length, 1);
    checks.push('Renewals workspace keeps paid history after annual date advances, separates next-year cycles from Needs action, and retries failed sharing from the saved review without an overdue reminder or duplicate bill');
    await go('/invoice/renewal-test');
    const document = await page.$eval('.agreement-document', e => e.textContent); assert.equal(renewal.payments[0].is_paid, true);
    assert.ok(document.includes('example.test domain renewal') && document.includes('Hosting renewal') && document.includes('Payments received'));
    assert.ok(!document.includes('Total project amount') && !document.includes('100,000') && !document.includes('GBP'));
    for (const width of [390, 320]) { await page.setViewport({ width, height: 844 }); await noOverflow(`Paid renewal invoice ${width}`); }
    await page.screenshot({ path: path.join(output, 'paid-renewal-invoice-mobile.png'), fullPage: true });
    checks.push('Client invoice contains only renewal services, surcharge and actual receipts; form and public invoice fit 320/390 px');
    assert.ok(!writes.some(write => write.endpoint.includes('/communications/email')));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, interceptedWrites: writes.length }, null, 2));
    console.log(JSON.stringify({ checks, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
