/* Isolated portfolio form checks; all API requests are intercepted. */
const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const destination = path.resolve(__dirname, '../docs/ui-review');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#83abf7"/><circle cx="120" cy="80" r="40" fill="#183444"/></svg>';

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    const writes = [];
    let project;
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const endpoint = url.pathname.slice(4);
      let payload = [];
      if (endpoint === '/auth/me') payload = { user: { id: 'operator', email: 'admin@example.test', role: 'admin' } };
      else if (endpoint === '/portfolio' && request.method() === 'POST') {
        const data = JSON.parse(request.postData());
        writes.push({ endpoint, data });
        project = { id: 'project-test', ...data, images: [] };
        payload = { project };
      } else if (endpoint === '/portfolio/project-test/images') {
        const posted = await request.fetchPostData();
        const body = posted?.includes('Content-Disposition') ? posted : Buffer.from(posted || '', 'base64').toString('utf8');
        writes.push({ endpoint, body });
        project.images = ['data:image/svg+xml,' + encodeURIComponent(svg)];
        payload = { project };
      } else if (endpoint === '/portfolio/project-test' && request.method() !== 'GET') {
        const data = JSON.parse(request.postData());
        writes.push({ endpoint, data });
        project = { ...project, ...data };
        payload = { project };
      } else if (endpoint === '/portfolio') payload = project ? [project] : [];
      else if (endpoint === '/portfolio/project-test') payload = { project };
      await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(base + '/admin/portfolio', { waitUntil: 'networkidle0' });
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Add project').click());
    await page.waitForSelector('#portfolio-form');
    const fields = await page.$$eval('#portfolio-form label.field', labels => Object.fromEntries(labels.map(label => [label.querySelector('.field__label')?.firstChild?.textContent?.trim(), label.querySelector('input,textarea')?.id])));
    await page.type(`[id="${fields['Project title']}"]`, 'SVG project');
    await page.type(`[id="${fields['Project ID / slug']}"]`, '  My Store / Desktop!');
    await page.focus(`[id="${fields['Main description']}"]`);
    await page.type(`[id="${fields['Main description']}"]`, 'SVG portfolio sample and normalized project URL.');
    assert.equal(await page.$eval(`[id="${fields['Project ID / slug']}"]`, input => input.value), 'my-store-desktop');

    await page.$eval('#portfolio-form input[type="file"]', (input, content) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], 'sample.svg', { type: 'image/svg+xml' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, svg);
    await page.waitForFunction(() => document.querySelector('.image-preview--new figcaption')?.textContent === 'sample.png');
    const converted = await page.$eval('.image-preview--new img', async image => {
      const response = await fetch(image.src);
      return { type: response.headers.get('content-type'), signature: [...new Uint8Array(await response.arrayBuffer()).slice(0, 8)] };
    });
    assert.equal(converted.type, 'image/png');
    assert.deepEqual(converted.signature, [137, 80, 78, 71, 13, 10, 26, 10]);

    await page.$eval('#portfolio-form input[type="file"]', input => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['not an SVG'], 'broken.svg', { type: 'image/svg+xml' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast--error')].some(toast => toast.textContent.includes('broken.svg')));
    assert.equal((await page.$$('.image-preview--new')).length, 1, 'Malformed SVG was accepted');
    await page.click('.toast--error .toast__close');
    await page.waitForFunction(() => !document.querySelector('button[form="portfolio-form"]').disabled);
    fs.mkdirSync(destination, { recursive: true });
    await page.screenshot({ path: path.join(destination, 'portfolio-form-mobile.png'), fullPage: true });
    await page.click('button[form="portfolio-form"][type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#portfolio-form'));
    assert.equal(writes[0].data.slug, 'my-store-desktop');
    assert.ok(writes.find(write => write.endpoint.endsWith('/images'))?.body.includes('filename="sample.png"'));
    assert.ok(writes.find(write => write.endpoint.endsWith('/images'))?.body.includes('Content-Type: image/png'));

    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Edit project').click());
    await page.waitForSelector('#portfolio-form');
    const slugId = await page.$$eval('#portfolio-form label.field', labels => labels.find(label => label.textContent.includes('Project ID / slug')).querySelector('input').id);
    await page.focus(`[id="${slugId}"]`);
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.type('UPDATED__Portfolio / Sample');
    await page.click('button[form="portfolio-form"][type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#portfolio-form'));
    assert.equal(writes.at(-1).data.slug, 'updated-portfolio-sample');
    assert.deepEqual(errors, [], 'Browser errors occurred');
    const result = { viewport: '390x844', checks: ['slug normalized on blur', 'SVG converted to PNG with valid image bytes', 'invalid SVG rejected', 'PNG sent in multipart upload', 'create slug normalized', 'update slug normalized'], browserErrors: errors };
    fs.writeFileSync(path.join(destination, 'portfolio-form-results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
