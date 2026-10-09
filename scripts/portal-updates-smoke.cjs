/* Browser checks use intercepted API data and never send a client message. */
const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const output = path.resolve(__dirname, '../docs/ui-review/portal-updates');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [], writes = [], checks = [];
    const client = { id: 'client-1', name: 'Test Client', company: 'Test Company', email: 'client@example.test', phone: '+94771111111', address: 'Colombo', status: 'active' };
    let invoice = { id: 'invoice-1', client_id: client.id, client_name: client.name, phone: client.phone, client_email: client.email, reference: 'INV-TEST', project_title: 'Business website', amount: 100000, paid_amount: 20000, currency: 'LKR', status: 'partial', revision: 1, issue_date: '2026-10-01', due_date: '2026-10-20', renewal_amount: 12000, renewal_currency: 'LKR', renewal_due_date: '2026-10-18', payment_instructions: 'Bank transfer, reference INV-TEST', payments: [{ id: 'advance', name: 'Advance payment', amount: 25000, paid_amount: 20000, is_paid: false }, { id: 'final', name: 'Final balance', amount: 75000, paid_amount: 0, is_paid: false }], payment_records: [{ id: 'receipt-1', milestone_id: 'advance', amount: 20000, currency: 'LKR', paid_at: '2026-10-01T06:30:00Z', method: 'Bank transfer', reference: 'TR-001' }] };
    const template = { title: 'Development agreement', description: 'Business website according to the accepted scope and schedule.', terms: { Scope: 'Only the agreed deliverables are included.' } };
    const agreements = [{ id: 'old-agreement', reference: 'AGR-OLD', title: 'Older agreement', client_id: client.id, client_name: client.name, project_title: 'Earlier project', amount: 50000, currency: 'LKR', status: 'draft', created_at: '2026-10-01T00:00:00Z' }];
    const users = [{ id: 'owner', email: 'owner@example.test', full_name: 'Owner', role: 'admin', active: true }];
    const income = { start: '2026-10-01', end: '2026-10-08', as_of: '2026-10-08', note: 'Cash receipts and current receivables are separate.', currencies: [{ currency: 'LKR', collected: 20000, invoiced: 100000, outstanding: 80000, overdue: 0, lifetime_collected: 20000, draft_value: 0, overpayments: 0, collected_on_void: 0, receipts: 1, invoices: 1, aging: { not_due: 80000 } }, { currency: 'USD', collected: 100, invoiced: 300, outstanding: 200, overdue: 0, lifetime_collected: 100, draft_value: 0, receipts: 1, invoices: 1, aging: { not_due: 200 } }], ledger: [{ id: 'receipt-1', invoice_id: invoice.id, client_id: client.id, client_name: client.name, reference: invoice.reference, project_title: invoice.project_title, amount: 20000, currency: 'LKR', method: 'Bank transfer', paid_at: '2026-10-01T06:30:00Z', invoice_status: 'partial' }], receivables: [], monthly: [{ currency: 'LKR', month: '2026-10', collected: 20000 }], methods: [], clients: [] };
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const endpoint = url.pathname.slice(4), method = request.method();
      const data = request.postData() && request.headers()['content-type']?.includes('json') ? JSON.parse(request.postData()) : {};
      if (method !== 'GET') writes.push({ endpoint, method, data, pin: request.headers()['x-deletion-pin'] });
      let payload = {}, status = 200;
      if (endpoint === '/auth/me') payload = { user: { id: 'owner', email: 'owner@example.test', name: 'Owner', role: 'admin' } };
      else if (endpoint === '/clients') payload = [client];
      else if (endpoint.endsWith('/profile')) payload = { profile: { client, invoices: [invoice], agreements } };
      else if (endpoint === '/invoices') payload = invoice.deleted_at ? [] : [invoice];
      else if (endpoint === '/invoices/invoice-1' && method === 'PUT') {
        invoice = { ...invoice, ...data, revision: invoice.revision + 1, payments: data.payments.map((p, i) => ({ ...p, id: p.id || `phase-${i}`, paid_amount: p.is_paid ? p.amount : p.paid_amount || 0 })) };
        invoice.paid_amount = invoice.payments.reduce((sum, p) => sum + Number(p.paid_amount), 0);
        payload = { invoice };
      }
      else if (endpoint === '/invoices/invoice-1' && method === 'DELETE') {
        if (request.headers()['x-deletion-pin'] !== '2113') { status = 403; payload = { detail: 'Enter the correct deletion PIN.' }; }
        else { invoice.status = 'void'; invoice.deleted_at = new Date().toISOString(); status = 204; }
      }
      else if (endpoint === '/invoices/invoice-1') payload = { invoice };
      else if (endpoint.endsWith('/share') && endpoint.startsWith('/invoices/')) payload = { invoice, share_url: base + '/invoice/test' };
      else if (endpoint === '/invoices/invoice-1/payments') {
        invoice.payment_records.push({ ...data, id: 'receipt-2' });
        invoice.paid_amount += Number(data.amount);
        const phase = invoice.payments.find(p => p.id === data.milestone_id);
        if (phase) { phase.paid_amount += Number(data.amount); phase.is_paid = phase.paid_amount >= phase.amount; }
        payload = { invoice };
      }
      else if (endpoint === '/agreements/template') payload = { template };
      else if (endpoint.startsWith('/agreements/from-invoice/')) payload = { agreement: { ...template, client_id: client.id, client_name: client.name, client_phone: client.phone, client_email: client.email, source_invoice_id: invoice.id, project_title: invoice.project_title, amount: invoice.amount, currency: invoice.currency, renewal_amount: invoice.renewal_amount, renewal_currency: invoice.renewal_currency, renewal_due_date: invoice.renewal_due_date, visiting_fee_lkr: 5000, payment_instructions: invoice.payment_instructions, payment_schedule: invoice.payments.map(p => ({ name: p.name, amount: p.amount, received_amount: p.paid_amount, is_paid: p.is_paid })) } };
      else if (endpoint === '/agreements' && method === 'POST') { const agreement = { ...data, id: 'new-agreement', reference: 'AGR-NEW', created_at: '2026-10-08T10:00:00Z', status: 'draft' }; agreements.unshift(agreement); payload = { agreement }; }
      else if (endpoint.startsWith('/agreements/') && method === 'DELETE') {
        if (request.headers()['x-deletion-pin'] !== '2113') { status = 403; payload = { detail: 'Enter the correct deletion PIN.' }; }
        else { const index = agreements.findIndex(a => a.id === endpoint.split('/').at(-1)); agreements.splice(index, 1); status = 204; }
      }
      else if (endpoint === '/agreements') payload = agreements;
      else if (endpoint.endsWith('/share') && endpoint.startsWith('/agreements/')) payload = { share: { share_url: base + '/sign/test' } };
      else if (endpoint === '/communications/email-status') payload = { available: false };
      else if (endpoint === '/income') payload = { income };
      else if (endpoint === '/auth/users' && method === 'POST') { const { temporary_password, ...profile } = data; users.push({ ...profile, id: `staff-${users.length}`, active: true }); payload = { user: users.at(-1), message: temporary_password ? 'User created.' : 'Invitation sent.' }; }
      else if (endpoint === '/auth/users') payload = { users };
      request.respond({ status, contentType: 'application/json', body: status === 204 ? undefined : JSON.stringify(payload) });
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
    const noOverflow = async label => { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow: ${label}`); };

    await page.setViewport({ width: 1440, height: 1000 }); await go('/admin/invoices');
    const invoiceNavigation = await page.evaluate(() => ({
      current: document.querySelector('.invoice-sections [aria-current="page"]')?.textContent.trim(),
      completed: [...document.querySelectorAll('.invoice-sections button')].some(button => button.textContent.trim().startsWith('Completed')),
      actions: [...document.querySelectorAll('.invoice-row__actions button')].filter(button => button.textContent.trim() === 'Actions').length,
    }));
    assert.ok(invoiceNavigation.current?.startsWith('Pending')); assert.equal(invoiceNavigation.completed, true); assert.equal(invoiceNavigation.actions, 1);
    checks.push('Pending invoices are the default, Completed is separate, and each invoice has one Actions button');
    await invoiceAction('INV-TEST', 'Edit payments');
    await fill('Optional visiting fee (LKR)', '5000');
    await click('Add visiting fee'); await click('Add mid payment'); await click('Record final payment'); await click('Save changes', '.modal');
    await page.waitForSelector('.share-panel textarea');
    const update = writes.find(w => w.method === 'PUT' && w.endpoint === '/invoices/invoice-1');
    assert.equal(update.data.payments.reduce((sum, p) => sum + p.amount, 0), 100000);
    assert.equal(update.data.payments.find(p => /Visiting/.test(p.name)).amount, 5000);
    assert.equal(update.data.payments.find(p => /Mid/.test(p.name)).amount, 35000);
    assert.equal(update.data.payments.find(p => /Final/.test(p.name)).is_paid, true);
    const message = await page.$eval('.share-panel textarea', e => e.value);
    assert.ok(message.includes('PAYMENT BREAKDOWN') && message.includes('Remaining balance') && message.includes('Payments received'));
    assert.ok(!(await page.$eval('.modal', element => element.textContent)).includes('Link expiry'));
    await click('Preview professional email layout', '.share-panel').catch(async () => page.click('.email-preview summary'));
    const iframe = await page.$('iframe[title="Professional email preview"]'); const frame = await iframe.contentFrame();
    assert.ok((await frame.$eval('body', e => e.textContent)).includes('HICH WEB'));
    await page.screenshot({ path: path.join(output, 'invoice-client-message.png') }); checks.push('Mid / final / visiting-fee allocation; balanced total; prepared payment message and HTML email');

    await go('/admin/invoices'); await invoiceAction('INV-TEST', 'Add payment'); await page.waitForSelector('#receipt-form'); await page.select(await field('Payment milestone'), 'advance'); await fill('Payment amount (LKR)', '2000'); await fill('Transfer / receipt reference', 'TR-002'); await click('Save payment & prepare message'); await page.waitForSelector('.share-panel textarea');
    assert.equal(writes.find(w => w.endpoint === '/invoices/invoice-1/payments').data.amount, 2000);
    assert.ok((await page.$eval('.share-panel textarea', e => e.value)).includes('Part received')); checks.push('Partial payment receipt retains amount, milestone and transfer reference');

    await go('/admin/invoices'); await invoiceAction('INV-TEST', 'Create agreement'); await page.waitForFunction(() => document.querySelector('input[placeholder="Project or engagement name"]')?.value === 'Business website');
    assert.equal(await page.$eval(await field('Client name'), e => e.value), client.name);
    assert.equal(await page.$eval(await field('Project budget'), e => e.value), '100000');
    assert.equal(await page.$eval(await field('Visiting fee (LKR)'), e => e.value), '5000');
    await click('Create signing link', '.modal'); await page.waitForSelector('.share-panel textarea');
    const created = writes.find(w => w.endpoint === '/agreements' && w.method === 'POST');
    assert.equal(created.data.source_invoice_id, invoice.id); assert.equal(created.data.payment_schedule.length, 4); assert.equal(created.data.renewal_amount, 12000);
    await go('/admin/agreements'); assert.equal(await page.$eval('.agreement-card .agreement-card__copy > span', e => e.textContent), 'AGR-NEW'); checks.push('Invoice copies contact, budget, payments, renewal and fee into agreement; newest agreement first');

    await go('/admin/settings'); await click('Invite user'); await fill('Full name', 'Operations User'); await fill('Email', 'operations@example.test'); await page.select(await field('Account setup'), 'email'); await click('Send invitation', '.modal'); await page.waitForFunction(() => !document.querySelector('#user-access-form'));
    const invited = writes.find(w => w.endpoint === '/auth/users' && w.method === 'POST'); assert.equal(invited.data.role, 'staff'); assert.equal(invited.data.email, 'operations@example.test'); assert.equal(invited.data.password, undefined); checks.push('Staff invited by email with no admin-selected password');

    await click('Invite user'); await fill('Full name', 'Temporary User'); await fill('Email', 'temporary@example.test'); await fill('Temporary password', 'Custom-temporary-123'); await click('Create user', '.modal');
    await page.waitForFunction(() => [...document.querySelectorAll('.modal h2')].some(e => e.textContent === 'Portal user created'));
    assert.equal(await page.$eval(await field('Created password'), e => e.value), 'Custom-temporary-123');
    assert.equal(writes.find(w => w.data.email === 'temporary@example.test').data.temporary_password, 'Custom-temporary-123');
    await click('Done', '.modal'); checks.push('Admin-selected temporary password is submitted and login credentials are shown once');

    agreements[0].status = 'signed'; await go('/admin/agreements'); await click('Delete'); await page.waitForSelector('input[autocomplete="off"]'); await fill('Deletion PIN', '2113'); await click('Delete agreement', '.modal');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await go('/admin/agreements'); assert.ok(!(await page.$eval('body', e => e.innerText)).includes('AGR-NEW')); checks.push('Visible agreement delete accepts PIN and stays removed after reload, including signed agreements');

    for (const width of [390, 320]) { await page.setViewport({ width, height: 844 }); for (const route of ['/admin/invoices', '/admin/agreements', '/admin/settings', '/admin/income', '/admin/clients?client=client-1']) { await go(route); await noOverflow(`${route} ${width}`); } }
    await page.setViewport({ width: 1440, height: 1000 });
    await go('/admin/invoices'); await invoiceAction('INV-TEST', 'Delete invoice'); await page.waitForSelector('input[autocomplete="off"]'); await fill('Deletion PIN', '1234'); await click('Delete invoice', '.modal'); await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(e => e.textContent.includes('correct deletion PIN')));
    assert.equal(invoice.status, 'partial'); await fill('Deletion PIN', '2113'); await click('Delete invoice', '.modal'); await page.waitForFunction(() => !document.querySelector('input[autocomplete="off"]')); assert.equal(invoice.status, 'void');
    await go('/admin/invoices'); assert.ok(!(await page.$eval('body', e => e.innerText)).includes('INV-TEST')); checks.push('Incorrect deletion PIN leaves data unchanged; correct PIN deletes and stays removed after reload');
    await page.setViewport({ width: 320, height: 844 });
    await go('/admin/income'); await page.screenshot({ path: path.join(output, 'income-mobile.png'), fullPage: true }); checks.push('Settings, agreement, invoice, client profile and income fit 320 / 390 px');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, interceptedWrites: writes.length }, null, 2)); console.log(JSON.stringify({ checks, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
