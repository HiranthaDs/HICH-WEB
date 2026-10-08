/* End-to-end UI regressions with intercepted API fixtures. Never touches live data. */
const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('./ui-fixtures.cjs');
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const output = path.resolve(__dirname, '../docs/ui-review');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [], checks = [], writes = [];
    const clients = [fixtures.client], invoices = [fixtures.invoice], agreements = [fixtures.agreement];
    let failNextInvoice = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const endpoint = url.pathname.slice(4), method = request.method();
      const data = request.postData() && request.headers()['content-type']?.includes('json') ? JSON.parse(request.postData()) : {};
      let payload = [], status = 200;
      if (method !== 'GET') writes.push({ endpoint, data });
      if (endpoint === '/auth/me') payload = { user: { id: 'admin-1', name: 'Hich Admin', email: 'admin@example.test', role: 'admin' } };
      else if (endpoint === '/dashboard') payload = fixtures.dashboard;
      else if (endpoint === '/clients' && method === 'POST') { const client = { ...data, id: `new-client-${clients.length}`, created_at: '2026-10-08T08:00:00Z' }; clients.push(client); payload = { client }; }
      else if (endpoint === '/clients') payload = clients;
      else if (/^\/clients\/[^/]+\/profile$/.test(endpoint)) {
        const id = endpoint.split('/')[2];
        payload = { profile: { client: clients.find(client => client.id === id), invoices: invoices.filter(invoice => invoice.client_id === id), agreements: agreements.filter(agreement => agreement.client_id === id) } };
      }
      else if (endpoint === '/invoices' && method === 'POST') {
        if (failNextInvoice) { failNextInvoice = false; status = 503; payload = { detail: 'Temporary invoice failure. Please retry.' }; }
        else { const invoice = { ...data, id: `new-invoice-${invoices.length}`, client: clients.find(client => client.id === data.client_id), revision: 1, reference: `INV-NEW-${invoices.length}` }; invoices.push(invoice); payload = { invoice }; }
      }
      else if (endpoint === '/invoices') payload = invoices;
      else if (endpoint === '/agreements/template') payload = { template: { title: 'Website & Systems Development Agreement', description: fixtures.agreement.description, terms: fixtures.agreement.clauses.map(clause => `${clause.title}: ${clause.body}`) } };
      else if (endpoint === '/agreements' && method === 'POST') { const agreement = { ...data, id: `new-agreement-${agreements.length}`, reference: 'AGR-NEW', status: 'draft' }; agreements.push(agreement); payload = { agreement }; }
      else if (endpoint === '/agreements') payload = agreements;
      else if (endpoint === '/public/agreements/test') payload = fixtures.agreement;
      else if (endpoint === '/public/invoices/test') payload = { ...fixtures.invoice, renewal_amount: 120, renewal_currency: 'GBP' };
      else if (endpoint === '/public/changes/test') payload = fixtures.change;
      else if (endpoint === '/portfolio' || endpoint === '/public/portfolio') payload = fixtures.projects;
      else if (endpoint === '/collections') payload = [fixtures.collection];
      else if (endpoint === '/operations/tasks') payload = fixtures.tasks;
      else if (endpoint === '/operations/changes') payload = [fixtures.change];
      else if (endpoint === '/audit') payload = fixtures.dashboard.recent_activity;
      request.respond({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    const go = async route => { await page.goto(base + route, { waitUntil: 'networkidle0' }); };
    const clickText = async (text, scope = 'body') => {
      const handle = await page.evaluateHandle((text, scope) => [...document.querySelectorAll(`${scope} button, ${scope} a`)].find(element => element.textContent.trim() === text && element.getBoundingClientRect().height > 0), text, scope);
      assert.ok(handle.asElement(), `Visible action missing: ${text}`);
      await handle.asElement().click(); await handle.dispose();
    };
    const field = async (label, scope = '.modal') => {
      const id = await page.evaluate((label, scope) => [...document.querySelectorAll(`${scope} label.field`)].find(element => element.querySelector('.field__label')?.firstChild?.textContent.trim() === label)?.querySelector('input,select,textarea')?.id, label, scope);
      assert.ok(id, `Field missing: ${label}`); return `[id="${id}"]`;
    };
    const fill = async (label, value) => { const selector = await field(label); await page.click(selector, { clickCount: 3 }); await page.type(selector, String(value)); };
    const select = async (label, value) => page.select(await field(label), value);
    const noPageOverflow = async (label) => {
      const result = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 12).map(e => ({tag: e.tagName, class: e.className, right: e.getBoundingClientRect().right})) }));
      assert.ok(result.scroll <= result.width + 1, `${label}: page overflow ${JSON.stringify(result)}`);
    };
    const checkDialog = async label => {
      await page.waitForSelector('[role="dialog"]');
      await page.waitForFunction(() => !document.querySelector('.modal').getAnimations().some(animation => animation.playState === 'running'));
      const metrics = await page.evaluate(() => {
        const modal = document.querySelector('.modal'), shell = modal.parentElement, body = modal.querySelector('.modal__body'), footer = modal.querySelector('.modal__footer');
        const rect = modal.getBoundingClientRect(), f = footer?.getBoundingClientRect();
        const close = modal.querySelector('[aria-label="Close dialog"]'), r = close.getBoundingClientRect();
        return { rootPortal: shell.parentElement === document.body, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, bodyOverflow: body.scrollWidth > body.clientWidth + 1, footerVisible: !f || f.bottom <= innerHeight + 1, closeOnTop: close.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
      });
      assert.ok(metrics.rootPortal && metrics.left >= -1 && metrics.right <= metrics.width + 1 && metrics.top >= -1 && metrics.bottom <= metrics.height + 1 && !metrics.bodyOverflow && metrics.footerVisible && metrics.closeOnTop, `${label}: dialog unusable ${JSON.stringify(metrics)}`);
      await page.evaluate(() => { const body = document.querySelector('.modal__body'); body.scrollTop = body.scrollHeight; });
      if (await page.$('.modal__footer button[type="submit"]')) {
        assert.ok(await page.$eval('.modal__footer button[type="submit"]', button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), `${label}: submit covered`);
      }
      checks.push(label);
    };
    const viewports = process.env.UI_QUICK ? [[320, 640], [844, 390]] : [[320, 568], [360, 640], [390, 844], [430, 932], [768, 1024], [844, 390], [1440, 1000]];
    for (const [width, height] of viewports) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      for (const [route, action] of [['/admin/invoices', 'New invoice'], ['/admin/agreements', 'New agreement'], ['/admin/portfolio', 'Add project'], ['/admin/clients', 'Add client'], ['/admin/operations', 'New follow-up']]) {
        await go(route); await noPageOverflow(`${route} ${width}`); await clickText(action); await checkDialog(`${route} dialog ${width}x${height}`);
        if (width === 320) await page.screenshot({ path: path.join(output, `${route.split('/').pop()}-dialog-320.png`) });
        await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.modal'));
      }
      for (const route of ['/admin', '/admin/activity', '/admin/settings', '/', '/invoice/test', '/sign/test', '/change/test']) {
        await go(route); await noPageOverflow(`${route} ${width}`);
      }
      await go('/sign/test');
      await clickText('See more — full agreement'); await checkDialog(`Full agreement ${width}x${height}`);
      assert.equal(await page.$$eval('.agreement-terms-dialog .agreement-section h2', elements => elements.filter(element => /^\d+\./.test(element.textContent)).length), 15);
      await page.keyboard.press('Escape');
      await page.emulateMediaType('print');
      assert.notEqual(await page.$eval('.agreement-terms-full', element => getComputedStyle(element).display), 'none');
      await page.emulateMediaType('screen');
      console.log(`Viewport ${width}x${height} passed`);
    }
    await page.setViewport({ width: 390, height: 844 });
    await go('/admin/invoices'); await clickText('New invoice');
    await select('Client option', 'new');
    await fill('Client name', 'Mobile Client'); await fill('Company', 'Mobile Company');
    await fill('Email address', 'mobile@example.test'); await fill('Phone number', '0714112113'); await fill('Address', '42 Test Road, Colombo');
    await fill('Project title', 'Mobile website'); await fill('Total project amount', '2400'); await select('Project currency', 'USD');
    await fill('Renewal amount', '180'); await select('Renewal currency', 'GBP');
    failNextInvoice = true;
    await clickText('Create invoice', '.modal');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(element => element.textContent.includes('Temporary invoice failure')));
    assert.equal(clients.filter(client => client.name === 'Mobile Client').length, 1);
    await clickText('Create invoice', '.modal');
    await page.waitForFunction(() => !document.querySelector('#invoice-form'));
    assert.equal(clients.filter(client => client.name === 'Mobile Client').length, 1, 'Invoice retry duplicated client');
    const createdClient = clients.find(client => client.name === 'Mobile Client'), createdInvoice = invoices.find(invoice => invoice.project_title === 'Mobile website');
    assert.equal(createdInvoice.client_id, createdClient.id); assert.equal(createdInvoice.currency, 'USD'); assert.equal(createdInvoice.amount, 2400); assert.equal(createdInvoice.renewal_currency, 'GBP'); assert.equal(createdInvoice.renewal_amount, 180);
    assert.deepEqual(createdInvoice.payments.map(payment => payment.amount), [1200, 1200]);
    checks.push('Invoice creates shared client; retry preserves client; project USD and renewal GBP persist');
    await go(`/admin/clients?client=${createdClient.id}`); await checkDialog('New client profile mobile');
    assert.ok((await page.$eval('.modal', element => element.textContent)).includes('Mobile website'));
    assert.ok((await page.$eval('.modal', element => element.textContent)).includes('42 Test Road'));
    await page.screenshot({ path: path.join(output, 'client-profile-390.png') });
    await go(`/admin/agreements?client=${createdClient.id}&create=1`); await checkDialog('Agreement from new client mobile');
    assert.equal(await page.$eval(await field('Client name'), input => input.value), 'Mobile Client');
    assert.equal(await page.$eval(await field('Client phone number'), input => input.value), '0714112113');
    await fill('Project title', 'Mobile website agreement'); await fill('Project budget', '2400'); await select('Currency', 'USD');
    await fill('Annual renewal amount', '180'); await select('Renewal currency', 'GBP');
    const saveButton = await page.$('.modal__footer button[type="submit"]'); await saveButton.click();
    await page.waitForFunction(() => !document.querySelector('#agreement-form'));
    assert.equal(agreements.at(-1).client_id, createdClient.id); assert.equal(agreements.at(-1).renewal_currency, 'GBP');
    checks.push('Agreement reuses invoice client with complete contact details');
    for (const route of ['/', '/admin']) {
      await go(route); assert.ok(await page.$('a[href="tel:+94714112113"]')); assert.ok(await page.$('a[href="https://wa.me/94714112113"]'));
    }
    assert.deepEqual(errors, [], 'Browser errors');
    fs.writeFileSync(path.join(output, 'mobile-workflows-results.json'), JSON.stringify({ viewports, checks, errors, interceptedWrites: writes.length }, null, 2));
    console.log(JSON.stringify({ checks: checks.length, errors, output }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
