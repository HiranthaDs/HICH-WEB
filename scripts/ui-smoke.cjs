/* Browser smoke review with isolated fixtures; never mutates the connected database.
 * Requires a local Vite server and Puppeteer: node scripts/ui-smoke.cjs
 * Override UI_BASE_URL to review another local port. Screenshots go to docs/ui-review.
 */
const puppeteer = require('puppeteer');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const destination = path.resolve(__dirname, '../docs/ui-review');
fs.mkdirSync(destination, { recursive: true });
const { client, agreement, invoice, projects, change, tasks, collection, dashboard } = require('./ui-fixtures.cjs');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  let authenticated = true;
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return request.continue();
    const endpoint = url.pathname.slice(4);
    let payload;
    let status = 200;
    if (endpoint === '/auth/me') { payload = authenticated ? { user: { id: 'user1', name: 'Hirantha Dias', email: 'hello@example.test', role: 'admin' } } : { detail: 'Unauthenticated' }; status = authenticated ? 200 : 401; }
    else if (endpoint === '/auth/refresh') { status = 401; payload = {}; }
    else if (endpoint === '/dashboard') payload = dashboard;
    else if (endpoint === '/clients') payload = [client];
    else if (endpoint === '/agreements') payload = [agreement, { ...agreement, id: 'agreement-2', status: 'signed', reference: 'HICH-2026-016', project_title: 'Studio North Website' }];
    else if (endpoint === '/invoices' && request.method() === 'POST') { const data = JSON.parse(request.postData() || '{}'); requests.push({ endpoint, data }); payload = { invoice: { ...invoice, ...data, id: 'invoice-created', revision: 1 } }; }
    else if (endpoint === '/invoices') payload = [invoice];
    else if (endpoint === '/portfolio' || endpoint === '/public/portfolio') payload = projects;
    else if (endpoint === '/collections') payload = [collection];
    else if (endpoint === '/public/collections/test') payload = { collection, projects: [projects[0], projects[2]] };
    else if (endpoint === '/operations/tasks') payload = tasks;
    else if (endpoint.startsWith('/operations/tasks/')) { requests.push({ endpoint, data: JSON.parse(request.postData() || '{}') }); payload = { ...tasks[0], ...JSON.parse(request.postData() || '{}') }; }
    else if (endpoint === '/operations/changes') payload = [change];
    else if (endpoint === '/public/changes/test') payload = change;
    else if (endpoint === '/public/invoices/test') payload = invoice;
    else if (endpoint === '/public/agreements/test') payload = agreement;
    else if (endpoint === '/public/agreements/test/sign') { const data = JSON.parse(request.postData()); requests.push({ endpoint, data }); payload = { ...agreement, ...data, status: 'signed', signed: true, signed_at: '2026-10-08T11:00:00Z' }; }
    else if (endpoint === '/audit') payload = dashboard.recent_activity;
    else payload = [];
    request.respond({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  const review = [];
  const routes = [['portfolio', '/'], ['dashboard', '/admin'], ['agreements', '/admin/agreements'], ['invoices', '/admin/invoices'], ['work-library', '/admin/portfolio'], ['operations', '/admin/operations'], ['signing', '/sign/test'], ['client-invoice', '/invoice/test'], ['scope-approval', '/change/test'], ['collection', '/collection/test']].filter(([name]) => !process.env.UI_REVIEW_FILTER || new RegExp(process.env.UI_REVIEW_FILTER).test(name));
  for (const [width, height, device] of [[1440, 1000, 'desktop'], [390, 844, 'mobile']]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    for (const [name, route] of routes) {
      await page.goto(base + route, { waitUntil: 'networkidle0' });
      await page.screenshot({ path: path.join(destination, `${name}-${device}.png`), fullPage: name === 'signing' ? false : true });
      const measure = await page.evaluate(() => ({ width: window.innerWidth, contentWidth: document.documentElement.scrollWidth, title: document.querySelector('h1')?.textContent, logos: [...document.querySelectorAll('.brand img')].every(image => image.complete && image.naturalWidth > 0), overflow: [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed').slice(0, 8).map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })) }));
      review.push({ name, device, ...measure });
      assert.ok(measure.logos, `Logo did not load: ${name} ${device}`);
      if (measure.contentWidth > width + 1) console.log('OVERFLOW', name, device, JSON.stringify(measure.overflow));
    }
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(base + '/admin', { waitUntil: 'networkidle0' });
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await page.waitForSelector('[role="combobox"]');
  await page.type('[role="combobox"]', 'INV-2026');
  await page.waitForFunction(() => document.querySelector('.command-result strong')?.textContent === 'INV-2026-024');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.modal')).opacity === '1');
  for (let index = 0; index < 4; index++) await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.querySelector('.modal').contains(document.activeElement)), 'Keyboard focus escaped the search dialog');
  await page.focus('[role="combobox"]');
  await page.screenshot({ path: path.join(destination, 'workspace-search-desktop.png') });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.search.includes('INV-2026-024'));
  await page.waitForSelector('.search-box input');
  assert.equal(await page.$eval('.search-box input', input => input.value), 'INV-2026-024');
  await page.goto(base + '/admin/invoices', { waitUntil: 'networkidle0' });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.includes('New invoice')).click());
  await page.waitForSelector('#invoice-form');
  const invoiceFields = await page.$$eval('#invoice-form label.field', labels => Object.fromEntries(labels.map(label => [label.querySelector('.field__label')?.firstChild?.textContent?.trim(), label.querySelector('input,select,textarea')?.id])));
  await page.select(`[id="${invoiceFields.Client}"]`, client.id);
  await page.type(`[id="${invoiceFields['Project title']}"]`, 'Milestone validation check');
  await page.type(`[id="${invoiceFields['Total project amount']}"]`, '100000');
  const plannedAmounts = await page.$$eval('.milestone-list input[type="number"]', inputs => inputs.map(input => Number(input.value)));
  assert.deepEqual(plannedAmounts, [50000, 50000], 'New invoice total did not create a valid 50/50 milestone plan');
  await page.click('#invoice-form button[type="submit"], button[form="invoice-form"][type="submit"]');
  await page.waitForFunction(() => !document.querySelector('#invoice-form'));
  const createdInvoice = requests.find(request => request.endpoint === '/invoices');
  assert.ok(createdInvoice, 'Invoice create request was not sent');
  assert.equal(createdInvoice.data.payments.length, 2);
  assert.equal(createdInvoice.data.payments.reduce((sum, payment) => sum + payment.amount, 0), 100000);
  assert.ok(createdInvoice.data.payments.every(payment => payment.amount > 0));
  await page.goto(base + '/sign/test', { waitUntil: 'networkidle0' });
  const labels = await page.$$eval('label.field', labels => labels.map(label => ({ text: label.textContent, id: label.querySelector('input')?.id })));
  const role = labels.find(label => /Job role/.test(label.text));
  await page.type(`[id="${role.id}"]`, 'Managing Director');
  await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find(button => button.textContent.includes('Type')).click());
  const signatureInput = await page.$eval('.typed-signature input', input => input.id);
  await page.type(`[id="${signatureInput}"]`, client.name);
  await page.click('.consent-check');
  await page.click('.sign-submit');
  await page.waitForSelector('.sign-complete');
  const signed = requests.find(request => request.endpoint.endsWith('/sign'));
  assert.equal(signed.data.signer_job_role, 'Managing Director');
  assert.equal(signed.data.consent, true);
  assert.equal(signed.data.expected_version, 2);
  assert.equal(signed.data.typed_signature, client.name);
  await page.screenshot({ path: path.join(destination, 'signature-complete-desktop.png') });
  await page.goto(base + '/invoice/test', { waitUntil: 'networkidle0' });
  await page.emulateMediaType('print');
  assert.notEqual(await page.$eval('.sign-header', element => getComputedStyle(element).display), 'none', 'Invoice print lost the logo');
  assert.notEqual(await page.$eval('.document-sidebar', element => getComputedStyle(element).display), 'none', 'Invoice print lost payment instructions');
  await page.emulateMediaType('screen');
  await page.goto(base + '/', { waitUntil: 'networkidle0' });
  assert.equal(await page.$$eval('a[href*="/admin"]', elements => elements.length), 0, 'Public website exposes an admin navigation link');
  await page.focus('.development-preview__controls button');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.development-preview--build .preview-code');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.development-preview__screen')).opacity === '1');
  await page.screenshot({ path: path.join(destination, 'studio-model-build-desktop.png') });
  await page.keyboard.press('End');
  await page.waitForSelector('.development-preview--launch .preview-launch');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.development-preview__screen')).opacity === '1');
  await page.screenshot({ path: path.join(destination, 'studio-model-launch-desktop.png') });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  assert.equal(await page.$eval('.development-model__stack', element => getComputedStyle(element).animationName), 'none', 'Reduced motion did not stop the model animation');
  await page.emulateMediaFeatures([]);
  authenticated = false;
  await page.goto(base + '/admin/login', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(destination, 'login-desktop.png') });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(destination, 'login-mobile.png'), fullPage: true });
  assert.deepEqual(errors, [], 'Browser errors');
  assert.ok(review.every(item => item.contentWidth <= item.width + 1), 'Horizontal page overflow');
  fs.writeFileSync(path.join(destination, process.env.UI_REVIEW_FILTER ? 'results-focused.json' : 'results.json'), JSON.stringify({ review, functionalChecks: ['Command palette keyboard shortcut and real filtered destination', 'Modal keyboard focus stays in the dialog', 'New invoice auto-allocates and submits two positive milestones matching the total', 'Typed signature submits name, role, explicit consent, signature, expected version', 'Invoice print retains logo and payment instructions', 'Interactive development model keyboard stages and reduced-motion support', 'No public admin navigation links', 'Logo asset loading', 'Desktop and mobile horizontal overflow', 'No browser JavaScript exceptions'], errors }, null, 2));
  console.log(JSON.stringify({ screens: review.length + 6, routes: routes.length, checks: 'passed', output: destination }, null, 2));
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
