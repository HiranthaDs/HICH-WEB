/* Synthetic intercepted requests only: no real clients or messages are changed. */
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [], writes = [];
    const client = { id: 'client-work', name: 'Existing Client', company: 'Client Company', email: 'client@example.test', phone: '+94771111111', status: 'active' };
    const original = { id: 'original', client_id: client.id, client, client_name: client.name, project_title: 'Original website', reference: 'INV-ORIGINAL', amount: 100000, paid_amount: 100000, currency: 'LKR', status: 'paid', payments: [], payment_records: [] };
    const invoices = [original];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const endpoint = url.pathname.slice(4), method = request.method();
      const data = request.postData() && request.headers()['content-type']?.includes('json') ? JSON.parse(request.postData()) : {};
      if (method !== 'GET') writes.push({ endpoint, method, data });
      let payload, status = 200;
      if (endpoint === '/auth/me') payload = { user: { id: 'owner', role: 'admin', email: 'owner@example.test' } };
      else if (endpoint === '/clients') payload = [client];
      else if (endpoint === '/clients/client-work/profile') payload = { profile: { client, invoices, agreements: [], proposals: [] } };
      else if (endpoint === '/communications/email-status') payload = { available: false };
      else if (endpoint === '/invoices' && method === 'POST') {
        const invoice = { ...data, id: `new-work-${invoices.length}`, reference: `INV-WORK-${invoices.length}`, client, client_name: client.name, client_email: client.email, phone: client.phone, payment_records: [] };
        invoices.push(invoice); payload = { invoice };
      }
      else if (endpoint === '/invoices') payload = invoices;
      else if (endpoint.endsWith('/share')) {
        const invoice = invoices.find(item => endpoint === `/invoices/${item.id}/share`);
        assert.ok(invoice, 'Share must target a saved invoice');
        invoice.status = invoice.paid_amount >= invoice.amount ? 'paid' : 'sent';
        payload = { invoice, share_url: `${base}/invoice/${invoice.id}` };
      }
      else { status = 404; payload = { detail: `Unexpected synthetic endpoint: ${endpoint}` }; }
      request.respond({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    const click = async (text, scope = 'body') => {
      const handle = await page.evaluateHandle((text, scope) => [...document.querySelectorAll(`${scope} button, ${scope} a`)].find(e => e.textContent.trim() === text && e.getBoundingClientRect().height > 0), text, scope);
      assert.ok(handle.asElement(), `Missing control: ${text}`);
      await handle.asElement().click(); await handle.dispose();
    };
    const field = async label => {
      const id = await page.evaluate(label => [...document.querySelectorAll('label.field')].find(e => e.querySelector('.field__label')?.firstChild?.textContent.trim() === label)?.querySelector('input,select,textarea')?.id, label);
      assert.ok(id, `Missing field: ${label}`); return `[id="${id}"]`;
    };
    const fill = async (label, value) => {
      await page.$eval(await field(label), (element, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    };
    const noOverflow = async label => {
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1);
      assert.equal(await page.$eval('.modal', element => element.scrollWidth <= element.clientWidth + 1), true, `${label} dialog must fit`);
    };

    for (const width of [1440, 390, 320]) {
      await page.setViewport({ width, height: 960 });
      await page.goto(`${base}/admin/clients?client=${client.id}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.client-profile'); await noOverflow(`Client profile ${width}`);
      await click('New work invoice', '.client-profile');
      await page.waitForSelector('#invoice-form');
      assert.equal(await page.$eval(await field('Client'), element => element.value), client.id);
      assert.equal(await page.$eval(await field('Work description'), element => element.value), '');
      assert.equal(await page.$$eval('.milestone-row', elements => elements.length), 1);
      assert.equal(new URL(page.url()).searchParams.has('create'), false, 'Reload should not reopen a consumed create request');
      await fill('Work description', `Website changes at ${width}px`);
      await fill('Amount for new work', '12500.50');
      await fill('Amount for new work', '15000.75');
      assert.equal(await page.$eval(await field('Amount'), element => element.value), '15000.75');
      assert.equal(await page.$eval(await field('Optional visiting fee (LKR)'), element => element.value), '');
      await noOverflow(`New work form ${width}`);
      if (width === 390) {
        await click('Add phase');
        assert.equal(await page.$$eval('.milestone-row', elements => elements.length), 2, 'Instalments remain available');
      }
      await click('Create & prepare message', '.modal');
      await page.waitForSelector('.share-panel textarea');
      await noOverflow(`Prepared message ${width}`);
      const created = invoices.at(-1);
      assert.equal(created.client_id, client.id);
      assert.equal(created.amount, 15000.75);
      assert.equal(created.paid_amount, 0);
      assert.equal(created.renewal_amount, 0);
      assert.equal(Math.round(created.payments.reduce((sum, phase) => sum + phase.amount, 0) * 100), 1500075);
      const message = await page.$eval('.share-panel textarea', element => element.value);
      assert.ok(message.includes(`Website changes at ${width}px`) && message.includes(`/invoice/${created.id}`));
      assert.equal(await page.$eval(await field('Recipient email'), element => element.value), client.email);
      assert.ok(await page.$eval('.share-panel a[href*="wa.me"]', element => element.href.includes('94771111111')));
      assert.ok(await page.$eval('.share-panel a[href^="mailto:"]', element => element.href.includes('client@example.test')));
    }

    await page.goto(`${base}/admin/clients?client=${client.id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.client-profile');
    await click('Share & send message', '.client-profile');
    await page.waitForSelector('.share-panel textarea');
    assert.ok((await page.$eval('.share-panel textarea', element => element.value)).includes('Original website'));
    assert.equal(await page.$('#invoice-form'), null, 'Profile share opens the message directly');
    assert.equal(invoices.length, 4);
    assert.equal(original.amount, 100000); assert.equal(original.paid_amount, 100000);
    assert.equal(writes.filter(write => write.endpoint === '/invoices' && write.method === 'POST').length, 3);
    assert.equal(writes.filter(write => write.endpoint === '/clients' || write.method === 'PUT' || write.endpoint === '/communications/email').length, 0);
    assert.deepEqual(errors, []);
    console.log('PASS: Client profile creates independent new-work invoices, preselects client, supports full payment and instalments, prepares send links, and shares existing invoices at 1440/390/320px.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
