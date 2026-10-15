/* Focused mobile/client-agreement regression checks with intercepted API data. */
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const fixtures = require('./ui-fixtures.cjs');

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const agreementWrites = [];
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const endpoint = url.pathname.slice(4);
      let payload;
      if (endpoint === '/auth/me') payload = { user: { id: 'admin-1', name: 'Admin', email: 'admin@example.test', role: 'admin' } };
      else if (endpoint === '/clients') payload = [fixtures.client];
      else if (endpoint === '/invoices') payload = [fixtures.invoice];
      else if (endpoint === '/agreements' && request.method() === 'POST') {
        const data = JSON.parse(request.postData());
        agreementWrites.push(data);
        payload = { agreement: { ...fixtures.agreement, ...data, id: `saved-agreement-${agreementWrites.length}`, status: 'draft' } };
      }
      else if (endpoint.startsWith('/agreements/saved-agreement-') && endpoint.endsWith('/share')) payload = { share: { share_url: `${base}/sign/no-visit-required` } };
      else if (endpoint === '/agreements') payload = [fixtures.agreement];
      else if (endpoint === '/agreements/template') payload = { template: { title: fixtures.agreement.title, description: fixtures.agreement.description, terms: { Scope: fixtures.agreement.description } } };
      else if (endpoint === `/agreements/from-invoice/${fixtures.invoice.id}`) payload = { agreement: {
        client_id: fixtures.client.id,
        client_name: fixtures.client.name,
        client_phone: fixtures.client.phone,
        client_email: fixtures.client.email,
        project_title: fixtures.invoice.project_title,
        amount: fixtures.invoice.amount,
        currency: fixtures.invoice.currency,
        source_invoice_id: fixtures.invoice.id,
        visiting_fee_lkr: '0.00',
        payment_schedule: fixtures.invoice.payments,
        payment_instructions: fixtures.invoice.payment_instructions,
        renewal_amount: 120,
        renewal_currency: 'GBP',
        renewal_due_date: '2027-10-12',
        terms: { Scope: fixtures.agreement.description },
      } };
      else return request.respond({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'Not found' }) });
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });

    await page.goto(`${base}/admin/invoices`, { waitUntil: 'networkidle0' });
    const actions = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Actions'));
    assert.ok(actions.asElement(), 'The invoice Actions button should be visible on mobile.');
    await actions.asElement().click();
    await page.waitForSelector('[role="dialog"] .invoice-actions-dialog');
    assert.equal(await page.$eval('[role="dialog"] h2', element => element.textContent), 'Invoice actions');
    assert.ok(await page.$eval('.invoice-actions-dialog', element => element.textContent.includes('Share & send message')));
    await page.keyboard.press('Escape');

    await page.goto(`${base}/admin/agreements`, { waitUntil: 'networkidle0' });
    const create = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'New agreement'));
    assert.ok(create.asElement(), 'The New agreement button should be visible.');
    await create.asElement().click();
    const clientSelect = await page.evaluateHandle(() => [...document.querySelectorAll('.modal label.field')].find(label => label.querySelector('.field__label')?.textContent.includes('Client record'))?.querySelector('select'));
    assert.ok(clientSelect.asElement(), 'Client record selector should exist.');
    await clientSelect.asElement().select(fixtures.client.id);
    await page.waitForFunction(title => [...document.querySelectorAll('.modal label.field')].find(label => label.querySelector('.field__label')?.textContent.includes('Project title'))?.querySelector('input')?.value === title, {}, fixtures.invoice.project_title);
    const values = await page.evaluate(() => {
      const value = name => [...document.querySelectorAll('.modal label.field')].find(label => label.querySelector('.field__label')?.textContent.includes(name))?.querySelector('input,select,textarea')?.value;
      return { phone: value('Client phone number'), project: value('Project title'), budget: value('Project budget') };
    });
    assert.equal(values.phone, fixtures.client.phone);
    assert.equal(values.project, fixtures.invoice.project_title);
    assert.equal(Number(values.budget), fixtures.invoice.amount);
    const versionLabels = await page.$$eval('.agreement-version-picker label', labels => labels.map(label => label.textContent.trim()));
    assert.deepEqual(versionLabels.length, 2);

    for (const commercialDetailsVisible of [true, false]) {
      for (const feeState of ['prefilled-zero', 'blank', 'zero', 'cleared']) {
        await page.goto(`${base}/admin/agreements?client=${fixtures.client.id}&create=1`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('#agreement-form');
        const invoiceSelect = await page.evaluateHandle(() => [...document.querySelectorAll('.modal label.field')].find(label => label.querySelector('.field__label')?.textContent.includes('Copy from invoice'))?.querySelector('select'));
        await invoiceSelect.asElement().select(fixtures.invoice.id);
        await page.waitForFunction(title => [...document.querySelectorAll('.modal label.field')].find(label => label.querySelector('.field__label')?.textContent.includes('Project title'))?.querySelector('input')?.value === title, {}, fixtures.invoice.project_title);
        const versions = await page.$$('input[name="agreement-version"]');
        await versions[commercialDetailsVisible ? 0 : 1].click();
        const fee = (await page.evaluateHandle(() => [...document.querySelectorAll('.modal label.field')].find(label => label.querySelector('.field__label')?.textContent.includes('Visiting fee'))?.querySelector('input'))).asElement();
        if (feeState !== 'prefilled-zero') {
          await fee.click();
          await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
          await page.keyboard.press('Backspace');
          if (feeState === 'zero') await fee.type('0');
          if (feeState === 'cleared') {
            await fee.type('5000');
            await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
          }
        }
        assert.equal(await fee.evaluate(input => input.checkValidity()), true, `${feeState} should be a valid optional visiting fee.`);
        assert.equal(await page.$eval('#agreement-form', form => form.checkValidity()), true, 'A fee must not be required to submit the agreement.');
        await Promise.all([
          page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/agreements')),
          page.click('button[type="submit"][form="agreement-form"]'),
        ]);
        await page.waitForSelector('#agreement-form', { hidden: true });
        assert.equal(agreementWrites.at(-1).visiting_fee_lkr, 0);
        assert.equal(agreementWrites.at(-1).commercial_details_visible, commercialDetailsVisible);
      }
    }
    assert.equal(agreementWrites.length, 8, 'Both agreement versions should save with every no-fee input state.');

    console.log('requested fixes smoke: passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
