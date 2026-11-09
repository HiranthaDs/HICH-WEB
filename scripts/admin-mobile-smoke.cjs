/* Phone layout and data-entry checks. All API requests use isolated fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const fixtures = require('./ui-fixtures.cjs');
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const output = path.resolve(__dirname, '../docs/ui-review/admin-mobile');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage();
    const errors = [], writes = [], checks = [];
    let failClientSave = true;
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const endpoint = url.pathname.slice(4);
      let payload = [];
      if (endpoint === '/auth/me') payload = { user: { id: 'admin-test', name: 'Mobile Admin', email: 'mobile@example.test', role: 'admin' } };
      else if (endpoint === '/dashboard') payload = fixtures.dashboard;
      else if (endpoint === '/clients') payload = [fixtures.client];
      else if (endpoint === '/agreements/template') payload = { template: { title: fixtures.agreement.title, description: fixtures.agreement.description, terms: { Scope: fixtures.agreement.description } } };
      else if (endpoint === '/agreements') payload = [fixtures.agreement];
      else if (endpoint === '/invoices') payload = [fixtures.invoice];
      else if (endpoint === '/portfolio') payload = fixtures.projects;
      else if (endpoint === '/collections') payload = [fixtures.collection];
      else if (endpoint === '/operations/tasks') payload = fixtures.tasks;
      else if (endpoint === '/operations/changes') payload = [fixtures.change];
      else if (endpoint === '/audit') payload = fixtures.dashboard.recent_activity;
      else if (endpoint === '/calendar') payload = { start: url.searchParams.get('start'), end: url.searchParams.get('end'), events: [] };
      else if (endpoint === '/income') payload = {
        start: '2026-11-01', end: '2026-11-08', as_of: '2026-11-08', currencies: [], monthly: [], methods: [], clients: [],
        ledger: [{ id: 'receipt-1', invoice_id: fixtures.invoice.id, client_name: fixtures.client.name, reference: fixtures.invoice.reference, project_title: fixtures.invoice.project_title, amount: 140000, currency: 'LKR', method: 'Bank transfer', paid_at: '2026-11-02', invoice_status: 'partial' }],
        receivables: [{ invoice_id: fixtures.invoice.id, client_name: fixtures.client.name, reference: fixtures.invoice.reference, total: 350000, paid: 140000, balance: 210000, currency: 'LKR', due_date: '2026-11-20', days_overdue: 0 }],
      };
      if (request.method() === 'POST' && endpoint === '/clients') {
        const data = JSON.parse(request.postData());
        writes.push(data);
        if (failClientSave) { failClientSave = false; return request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Test connection failure. Please retry.' }) }); }
        payload = { client: { ...data, id: 'mobile-created' } };
      }
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    const go = route => page.goto(base + route, { waitUntil: 'networkidle0' });
    const click = async text => {
      const handle = await page.evaluateHandle(text => [...document.querySelectorAll('button, a')].find(el => el.textContent.trim() === text && el.getBoundingClientRect().height > 0), text);
      assert.ok(handle.asElement(), `Missing action: ${text}`);
      await handle.asElement().click();
      await handle.dispose();
    };
    const measure = async label => {
      const result = await page.evaluate(() => {
        const body = document.querySelector('.modal__body');
        const modal = document.querySelector('.modal');
        const footer = document.querySelector('.modal__footer');
        return { width: innerWidth, scroll: document.documentElement.scrollWidth, bodyWidth: body?.clientWidth, bodyScroll: body?.scrollWidth, modalBottom: modal?.getBoundingClientRect().bottom, footerBottom: footer?.getBoundingClientRect().bottom, height: innerHeight };
      });
      assert.ok(result.scroll <= page.viewport().width + 1 && (!result.bodyWidth || result.bodyScroll <= result.bodyWidth + 1) && (!result.modalBottom || result.modalBottom <= result.height + 1), `${label}: overflow ${JSON.stringify(result)}`);
      if (result.footerBottom) assert.ok(result.footerBottom <= result.height + 1, `${label}: Save is off screen`);
      checks.push(label);
    };
    const routes = [
      ['/admin', null], ['/admin/clients', 'Add client'], ['/admin/proposals', 'New proposal'],
      ['/admin/invoices', 'New invoice'], ['/admin/agreements', 'New agreement'],
      ['/admin/portfolio', 'Add project'], ['/admin/operations', 'New follow-up'],
      ['/admin/activity', null], ['/admin/settings', null],
      ['/admin/income', null], ['/admin/clients/calendar', null],
    ];
    for (const [width, height] of [[320, 568], [360, 640], [390, 844], [430, 932], [740, 360], [768, 1024], [1440, 1000]]) {
      await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 760, hasTouch: width < 760 });
      for (const [route, action] of routes) {
        await go(route);
        await measure(`${route} ${width}`);
        if (route === '/admin/income') {
          assert.equal(await page.$$eval('.income-table-wrap tbody td', cells => cells.filter(cell => cell.getBoundingClientRect().height > 0).length), 12, 'Income amounts and balances must remain visible');
        }
        if (width === 390) await page.screenshot({ path: path.join(output, `${route.split('/').pop()}-390.png`), fullPage: true });
        if (!action) continue;
        await click(action);
        await page.waitForSelector('.modal');
        await page.waitForFunction(() => !document.querySelector('.modal').getAnimations().some(animation => animation.playState === 'running'));
        await measure(`${route} form ${width}`);
        if (width <= 760) {
          const smallInputs = await page.$$eval('.modal input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), .modal select, .modal textarea', inputs => inputs.filter(input => input.getBoundingClientRect().height > 0 && parseFloat(getComputedStyle(input).fontSize) < 16).map(input => input.id));
          assert.deepEqual(smallInputs, [], 'Phone form text must not trigger automatic zoom');
        }
        if (width === 390) await page.screenshot({ path: path.join(output, `${route.split('/').pop()}-form-390.png`) });
      }
    }
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await go('/admin/clients');
    await page.click('[aria-label="More workspace pages"]');
    await page.waitForSelector('#mobile-workspace-navigation');
    await page.click('#mobile-workspace-navigation a[href="/admin/clients"]');
    await page.waitForSelector('#mobile-workspace-navigation', { hidden: true });
    await page.click('[aria-label="More workspace pages"]');
    await page.click('#mobile-workspace-navigation a[href="/admin/proposals"]');
    await page.waitForFunction(() => location.pathname === '/admin/proposals');
    await page.waitForSelector('#mobile-workspace-navigation', { hidden: true });
    await page.click('[aria-label="More workspace pages"]');
    await page.setViewport({ width: 1024, height: 768 });
    await page.waitForFunction(() => !document.body.classList.contains('navigation-open'));
    checks.push('More navigation, same-page dismissal, and rotation unlock');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await go('/admin/clients');
    await click('Add client');
    const field = async label => {
      const id = await page.evaluate(label => [...document.querySelectorAll('#client-form label')].find(el => el.querySelector('.field__label')?.firstChild?.textContent === label)?.querySelector('input,textarea')?.id, label);
      assert.ok(id, `Missing field ${label}`);
      return `[id="${id}"]`;
    };
    await page.type(await field('Client name'), 'Mobile Test Client');
    await page.type(await field('Email address'), 'phone@example.test');
    await page.type(await field('Phone number'), '+94771234567');
    await page.type(await field('Internal notes'), 'Entered on a phone');
    // Approximate the available space above an open software keyboard.
    await page.setViewport({ width: 390, height: 380, isMobile: true, hasTouch: true });
    await measure('Client form with reduced keyboard viewport');
    assert.ok(await page.$eval('.modal__footer button[type="submit"]', button => { const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'Save must be reachable above the keyboard');
    await page.click('[form="client-form"][type="submit"]');
    await page.waitForFunction(() => document.querySelector('.toast--error'));
    assert.equal(await page.$eval(await field('Client name'), input => input.value), 'Mobile Test Client', 'Failed save must retain typed data');
    await page.click('[form="client-form"][type="submit"]');
    await page.waitForSelector('#client-form', { hidden: true });
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(writes[1].notes, 'Entered on a phone');
    checks.push('Mobile client entry, reachable Save, failed-save recovery');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, writes }, null, 2));
    console.log(`Admin mobile smoke: ${checks.length} checks passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
