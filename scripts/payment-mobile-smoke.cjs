/* Payment workflow checks use isolated API fixtures; no live records are changed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const fixtures = require('./ui-fixtures.cjs');
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const output = path.resolve(__dirname, '../docs/ui-review/payment-mobile');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage();
    const errors = [], writes = [], checks = [];
    let failReceipt = true, failPlan = true;
    let invoice = { ...fixtures.invoice, amount: 300000, paid_amount: 0, status: 'sent', payment_records: [], payments: [
      { id: 'first', name: 'Advance payment', amount: 60000, paid_amount: 0 },
      { id: 'second', name: 'Design approval', amount: 90000, paid_amount: 0 },
      { id: 'third', name: 'Launch payment', amount: 150000, paid_amount: 0 },
    ] };
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const endpoint = url.pathname.slice(4), method = request.method();
      const data = request.postData() ? JSON.parse(request.postData()) : null;
      let payload = [], status = 200;
      if (endpoint === '/auth/me') payload = { user: { id: 'admin', name: 'Phone Admin', email: 'phone@example.test', role: 'admin' } };
      else if (endpoint === '/clients') payload = [fixtures.client];
      else if (endpoint === '/invoices') payload = [invoice];
      else if (endpoint === `/invoices/${invoice.id}` && method === 'GET') payload = invoice;
      else if (endpoint === `/invoices/${invoice.id}` && method === 'PUT') {
        writes.push({ endpoint, method, data });
        if (failPlan) { failPlan = false; status = 503; payload = { detail: 'Test connection failure. Retry your plan.' }; }
        else {
          invoice = { ...invoice, ...data, revision: invoice.revision + 1, payments: data.payments.map((phase, i) => ({ ...phase, id: phase.id || `stage-${i + 1}` })) };
          payload = invoice;
        }
      } else if (endpoint.startsWith(`/invoices/${invoice.id}/payments`)) {
        writes.push({ endpoint, method, data });
        if (failReceipt) { failReceipt = false; status = 503; payload = { detail: 'Test connection failure. Retry your payment.' }; }
        else {
          const original = method === 'PUT' ? invoice.payment_records.find(receipt => endpoint.endsWith('/' + receipt.id)) : null;
          const payment = { ...original, ...data, id: original?.id || `receipt-${invoice.payment_records.length + 1}`, receipt_number: original?.receipt_number || `RCT-000${invoice.payment_records.length + 1}` };
          invoice.payment_records = original ? invoice.payment_records.map(receipt => receipt.id === original.id ? payment : receipt) : [...invoice.payment_records, payment];
          invoice.paid_amount = invoice.payment_records.reduce((sum, receipt) => sum + receipt.amount, 0);
          invoice.payments = invoice.payments.map(phase => {
            const paid_amount = invoice.payment_records.filter(receipt => receipt.milestone_id === phase.id).reduce((sum, receipt) => sum + receipt.amount, 0);
            return { ...phase, paid_amount, is_paid: paid_amount >= phase.amount };
          });
          invoice.status = invoice.paid_amount >= invoice.amount ? 'paid' : 'partial';
          payload = { invoice, payment };
        }
      } else if (endpoint.endsWith('/share')) payload = { share_url: base + '/invoice/test', invoice };
      else if (endpoint === '/communications/email-status') payload = { available: false };
      request.respond({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    const click = async (text, scope = '.modal') => {
      const handle = await page.evaluateHandle((text, scope) => [...document.querySelectorAll(`${scope} button, ${scope} summary`)].find(el => el.textContent.trim() === text && el.getBoundingClientRect().height > 0), text, scope);
      assert.ok(handle.asElement(), `Missing action: ${text}`);
      await handle.asElement().click(); await handle.dispose();
    };
    const field = async label => {
      const id = await page.evaluate(label => [...document.querySelectorAll('.modal label.field')].find(el => el.querySelector('.field__label')?.firstChild?.textContent.trim() === label)?.querySelector('input, select')?.id, label);
      assert.ok(id, `Missing field: ${label}`); return `[id="${id}"]`;
    };
    const fill = async (label, value) => {
      const selector = await field(label);
      await page.click(selector);
      await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.type(selector, value);
    };
    const measure = async label => {
      await page.waitForFunction(() => !document.querySelector('.modal')?.getAnimations().some(animation => animation.playState === 'running'));
      const result = await page.evaluate(() => {
        const body = document.querySelector('.modal__body'), footer = document.querySelector('.modal__footer');
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, body: body.clientWidth, scroll: body.scrollWidth, footer: footer.getBoundingClientRect().bottom, height: innerHeight };
      });
      assert.ok(result.page <= page.viewport().width + 1 && result.scroll <= result.body + 1 && result.footer <= result.height + 1, `${label}: ${JSON.stringify(result)}`);
      checks.push(label);
    };
    const open = async () => {
      await page.goto(base + '/admin/invoices', { waitUntil: 'networkidle0' });
      await click('Record payment', '.invoice-row__actions'); await page.waitForSelector('#receipt-form');
    };
    for (const [width, height] of [[320, 568], [360, 640], [390, 844], [430, 932], [740, 360], [768, 1024], [1440, 1000]]) {
      await page.setViewport({ width, height, isMobile: width <= 760, hasTouch: width <= 760 });
      await open(); await measure(`Record payment ${width}`);
      assert.equal(await page.$eval(await field('Payment milestone'), input => input.value), 'first');
      assert.equal(await page.$eval(await field('Payment amount (LKR)'), input => input.value), '60,000');
      if (width === 390) await page.screenshot({ path: path.join(output, 'record-390.png') });
      await click('Payment plan'); await measure(`Compact plan ${width}`);
      assert.equal(await page.$$eval('.payment-stage', stages => stages.length), 3);
      assert.equal(await page.$$eval('.payment-stage[open]', stages => stages.length), 0);
      if (width === 390) await page.screenshot({ path: path.join(output, 'plan-390.png') });
      await click('Add payment stage'); await measure(`Add stage ${width}`);
      if (width === 390) {
        await page.$eval('.payment-add-stage', el => el.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: path.join(output, 'add-stage-390.png') });
      }
      await click('Receipts (0)'); await measure(`Receipt history ${width}`);
    }
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    for (const [id, amount] of [['first', '60000'], ['second', '90000'], ['third', '25000']]) {
      await open();
      assert.equal(await page.$eval(await field('Payment milestone'), input => input.value), id, 'Next unpaid stage is selected');
      await fill('Payment amount (LKR)', amount);
      await fill('Transfer / receipt reference', `BANK-${id}`);
      assert.deepEqual(await page.$$eval('#receipt-form input, #receipt-form select', inputs => inputs.filter(input => !input.checkValidity()).map(input => ({ value: input.value, reason: input.validationMessage }))), [], 'Receipt fields must be valid before saving');
      if (id === 'first') {
        await page.setViewport({ width: 390, height: 380, isMobile: true, hasTouch: true });
        await measure('Save above keyboard');
        await click('Save payment'); await page.waitForSelector('.toast--error');
        assert.equal(await page.$eval(await field('Payment amount (LKR)'), input => input.value), '60,000');
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      }
      await click('Save payment'); await page.waitForSelector('.share-panel');
      assert.equal(invoice.payment_records.at(-1).milestone_id, id);
      assert.equal(invoice.payment_records.at(-1).amount, Number(amount));
    }
    assert.equal(writes[0].data.idempotency_key, writes[1].data.idempotency_key, 'Retries retain the same receipt key');
    checks.push('First, second and partial third payments; numeric API amounts; failed-save retry');
    await open(); await click('Payment plan'); await click('Add payment stage');
    await fill('New stage amount (LKR)', '50000');
    assert.match(await page.$eval('.payment-add-stage__preview', el => el.textContent), /100,000/);
    await click('Add to plan');
    assert.equal(await page.$$eval('.payment-stage', stages => stages.length), 4);
    await click('Record payment', '.payment-navigation');
    assert.equal(await page.$eval('[form="receipt-form"]', button => button.disabled), true, 'Unsaved plan blocks receipt submission');
    await click('Review payment plan');
    await click('Save payment plan');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast--error')].some(el => el.textContent.includes('Retry your plan')));
    assert.equal(await page.$$eval('.payment-stage', stages => stages.length), 4, 'Failed save retains new stage');
    await click('Save payment plan');
    await page.waitForFunction(() => !document.querySelector('.payment-notice'));
    assert.equal(invoice.payments.reduce((sum, phase) => sum + phase.amount, 0), 300000);
    assert.deepEqual(invoice.payments.slice(0, 2).map(phase => phase.amount), [60000, 90000]);
    assert.equal(invoice.payments[2].paid_amount, 25000);
    assert.equal(invoice.payments[3].amount, 50000);
    await page.$$eval('.toast__close', buttons => buttons.forEach(button => button.click()));
    await page.screenshot({ path: path.join(output, 'four-stages-390.png') });
    await click('Record payment', '.payment-navigation');
    await page.select(await field('Payment milestone'), invoice.payments[3].id);
    assert.equal(await page.$eval(await field('Payment amount (LKR)'), input => input.value), '50,000');
    await click('Save payment'); await page.waitForSelector('.share-panel');
    assert.equal(invoice.paid_amount, 225000);
    checks.push('Fourth stage preview, balanced plan, existing receipts preserved, fourth payment recorded');
    await open(); await click('Receipts (4)'); await click('Edit receipt');
    assert.equal(await page.$eval(await field('Payment amount (LKR)'), input => input.value), '60,000');
    await fill('Transfer / receipt reference', 'CORRECTED-REF');
    await click('Save correction'); await page.waitForSelector('.share-panel');
    assert.equal(invoice.payment_records[0].reference, 'CORRECTED-REF');
    assert.equal(invoice.paid_amount, 225000);
    checks.push('Receipt correction keeps totals and original receipt identity');
    await open();
    await fill('Payment amount (LKR)', '1234.50');
    assert.equal(await page.$eval(await field('Payment amount (LKR)'), input => input.value), '1,234.50');
    await fill('Payment amount (LKR)', '75000.01');
    assert.equal(await page.$eval('#receipt-form', form => form.checkValidity()), false, 'Amount above stage balance is rejected');
    await fill('Payment amount (LKR)', '');
    assert.equal(await page.$eval('#receipt-form', form => form.checkValidity()), false, 'Blank amount is rejected');
    checks.push('Decimal entry and required / maximum amount validation');
    await fill('Payment amount (LKR)', '1234567.89');
    assert.equal(await page.$eval(await field('Payment amount (LKR)'), input => input.value), '1,234,567.89', 'Amounts use three-digit groups');
    await fill('Payment amount (LKR)', '1234.50');
    const amountField = await field('Payment amount (LKR)');
    await page.$eval(amountField, input => { input.focus(); input.setSelectionRange(2, 2); });
    await page.keyboard.press('Backspace');
    assert.equal(await page.$eval(amountField, input => input.value), '234.50', 'Backspace crosses a thousands separator');
    await page.$eval(amountField, input => { input.focus(); input.setSelectionRange(1, 1); });
    await page.keyboard.type('9');
    assert.equal(await page.$eval(amountField, input => input.value), '2,934.50', 'Middle editing preserves cursor position and decimals');
    // Fully settle a decimal balance that is not exact in binary floating point.
    invoice = { ...invoice, amount: 0.3, paid_amount: 0.2, payments: [{ id: 'decimal', name: 'Small balance', amount: 0.3, paid_amount: 0.2 }] };
    await open();
    assert.equal(await page.$eval(await field('Payment amount (LKR)'), input => input.value), '0.1');
    assert.equal(await page.$eval('#receipt-form', form => form.checkValidity()), true);
    invoice.payments = [];
    await open();
    assert.equal(await page.$eval(await field('Payment amount (LKR)'), input => input.value), '0.1');
    assert.equal(await page.$eval('#receipt-form', form => form.checkValidity()), true);
    checks.push('Million formatting, comma deletion, cursor editing and exact cent balances');
    await click('Cancel');
    await click('Actions', '.invoice-row__actions');
    await click('Edit payments');
    await page.waitForSelector('.payment-plan');
    assert.equal(await page.$eval('.payment-navigation [aria-pressed="true"]', button => button.textContent.trim()), 'Payment plan');
    checks.push('Edit payments opens the dedicated plan directly on phones');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, writes }, null, 2));
    console.log(`Payment mobile smoke: ${checks.length} checks passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
