/* Public-link delivery checks with intercepted fixtures; no database writes. */
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const fixtures = require('./ui-fixtures.cjs');

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5181';
const proposal = { id: 'proposal-1', title: 'Client proposal', status: 'sent', html_content: '<!doctype html><html><body><h1>Client proposal</h1></body></html>' };
const cases = [
  { path: '/proposal/test', endpoint: '/api/public/proposals/test', payload: { proposal }, selector: '.proposal-public-viewer iframe', module: 'PublicProposal' },
  { path: '/invoice/test', endpoint: '/api/public/invoices/test', payload: { invoice: fixtures.invoice }, selector: '.invoice-paper', module: 'PublicInvoice' },
  { path: '/sign/test', endpoint: '/api/public/agreements/test', payload: { agreement: fixtures.agreement }, selector: '.agreement-document', module: 'AgreementSigning' },
  { path: '/change/test', endpoint: '/api/public/changes/test', payload: { change: fixtures.change }, selector: '.agreement-document', module: 'PublicChange' },
  { path: '/collection/test', endpoint: '/api/public/collections/test', payload: { collection: fixtures.collection, projects: fixtures.projects }, selector: '.project-card', module: 'PublicPortfolio' },
  { path: '/', endpoint: '/api/public/portfolio', payload: { projects: fixtures.projects }, selector: '.project-card', module: 'PublicPortfolio' },
];

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    for (const scenario of cases) {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.setRequestInterception(true);
      const requests = [];
      const errors = [];
      let publicReads = 0;
      let revoked = false;
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        const url = new URL(request.url());
        requests.push(url.pathname);
        if (!url.pathname.startsWith('/api/')) return request.continue();
        if (url.pathname === scenario.endpoint && request.method() === 'GET') {
          publicReads += 1;
          return request.respond({ status: revoked ? 404 : 200, contentType: 'application/json', body: JSON.stringify(revoked ? { detail: 'Link revoked' } : scenario.payload) });
        }
        if (url.pathname.endsWith('/open') && request.method() === 'POST') return request.respond({ status: 204 });
        return request.respond({ status: 404, contentType: 'application/json', body: '{"detail":"Unexpected request"}' });
      });
      await page.goto(`${base}${scenario.path}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector(scenario.selector);
      assert.equal(publicReads, 1, `${scenario.path}: concurrent mounts should share one document read`);
      assert.equal(requests.some(path => path.startsWith('/api/auth/')), false, `${scenario.path}: no admin session request`);
      for (const otherModule of new Set(cases.map(item => item.module))) {
        if (otherModule === scenario.module) continue;
        assert.equal(requests.some(path => path.includes(`/${otherModule}.tsx`) || path.includes(`/${otherModule}-`)), false, `${scenario.path}: unrelated ${otherModule} should not load`);
      }
      assert.deepEqual(errors, [], `${scenario.path}: no browser errors`);

      if (scenario.module === 'PublicInvoice') {
        revoked = true;
        await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Refresh').click());
        await page.waitForFunction(() => document.body.textContent.includes('Link revoked'));
        assert.equal(publicReads, 2, 'Refresh revalidates the current link instead of returning completed cached content');
      }
      console.log(`PASS ${scenario.path}: one initial read, isolated route bundle, no session check`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
