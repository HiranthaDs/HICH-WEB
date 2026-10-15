/* Intercepted synthetic API only. Does not touch a connected database or send messages. */
const assert = require('node:assert/strict')
const puppeteer = require('puppeteer')
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5173'
const token = 'synthetic-proposal-opening-token-1234567890'
const date = '2026-10-15T08:00:00Z'

;(async () => {
  const browser = await puppeteer.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.evaluateOnNewDocument(() => {
      // Local HTTP previews do not expose randomUUID in every browser.
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
    })
    const errors = [], openings = [], reads = []
    let viewCount = null
    let holdList = false
    const heldLists = []
    const proposal = { id: 'proposal-test', client_id: 'client-test', title: 'Opening count test', client_name: 'Synthetic client', reference: 'PROP-TEST', status: 'sent', created_at: date, html_content: '<!doctype html><html><body><h1>Your proposal</h1></body></html>' }
    page.on('pageerror', error => errors.push(error.message))
    await page.setRequestInterception(true)
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname
      if (!pathname.startsWith('/api/')) return request.continue()
      const json = (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (pathname === `/api/public/proposals/${token}/open`) {
        openings.push(JSON.parse(request.postData()).opening_id)
        return openings.length === 1 ? json({ detail: 'Synthetic temporary tracking failure' }, 502) : request.respond({ status: 204 })
      }
      reads.push(pathname)
      if (pathname === `/api/public/proposals/${token}`) return json({ proposal })
      if (pathname === '/api/auth/me') return json({ user: { id: 'admin', email: 'test@example.test', role: 'admin' } })
      if (pathname === '/api/proposals') {
        if (holdList) { heldLists.push(request); return }
        return json({ items: [{ ...proposal, view_count: viewCount, last_opened_at: viewCount ? date : null }] })
      }
      if (pathname === `/api/proposals/${proposal.id}/share`) return json({ share: { url: `${base}/proposal/${token}` } })
      if (pathname === '/api/clients') return json({ items: [] })
      if (pathname === '/api/invoices') return json({ items: [] })
      if (pathname === '/api/agreements/template') return json({ template: { title: 'Signing document', terms: [] } })
      if (pathname === '/api/agreements') return json({ items: [{ id: 'agreement-test', title: 'Signing document', status: 'sent', client_name: 'Synthetic client', created_at: date }] })
      return json({ detail: `Unexpected synthetic endpoint ${pathname}` }, 404)
    })
    await page.goto(`${base}/proposal/${token}`, { waitUntil: 'networkidle0' })
    const frame = await (await page.waitForSelector('.proposal-public-viewer iframe')).contentFrame()
    assert.equal(await frame.$eval('h1', element => element.textContent), 'Your proposal')
    await new Promise(resolve => setTimeout(resolve, 2400))
    assert.equal(openings.length, 2, 'one failed tracking POST should retry once')
    assert.equal(new Set(openings).size, 1, 'retry must preserve the opening ID')
    assert.equal(reads.filter(path => path.includes('/public/proposals/')).length, 1, 'initial document read should not duplicate')
    assert(!reads.includes('/api/auth/me'), 'a client link should not wait for authentication')
    await page.reload({ waitUntil: 'networkidle0' })
    assert.equal(openings.length, 3)
    assert.equal(new Set(openings).size, 2, 'a new visit must count again')

    const slowPage = await browser.newPage()
    let pendingImage
    let slowOpens = 0
    await slowPage.setRequestInterception(true)
    slowPage.on('pageerror', error => errors.push(error.message))
    slowPage.on('request', request => {
      const pathname = new URL(request.url()).pathname
      if (pathname === '/slow-proposal-image.png') { pendingImage = request; return }
      if (pathname === `/api/public/proposals/${token}`) return request.respond({
        status: 200, contentType: 'application/json', body: JSON.stringify({ proposal: {
          ...proposal, html_content: `<!doctype html><html><head><title>Slow assets</title></head><body><h1>Already visible</h1><img src="${base}/slow-proposal-image.png"></body></html>`,
        } }),
      })
      if (pathname === `/api/public/proposals/${token}/open`) {
        slowOpens += 1
        return request.respond({ status: 204 })
      }
      return request.continue()
    })
    const earlyOpen = slowPage.waitForResponse(response => response.url().endsWith(`/${token}/open`))
    await slowPage.goto(`${base}/proposal/${token}`, { waitUntil: 'domcontentloaded' })
    await earlyOpen
    assert(pendingImage, 'the image must still be loading when the displayed visit is recorded')
    assert.equal(slowOpens, 1, 'visible proposal must count before slow images finish')
    await pendingImage.respond({ status: 204 })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(slowOpens, 1, 'iframe load and content-ready signals must not double-count')
    await slowPage.close()
    await page.bringToFront()

    await page.goto(`${base}/admin/proposals`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.proposal-card')
    assert.equal(await page.$eval('.proposal-card dl dd', element => element.textContent), 'Unavailable')
    assert((await page.$eval('.data-notice', element => element.textContent)).includes('tracking is unavailable'))
    viewCount = 12
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => document.querySelector('.proposal-card dl dd')?.textContent === '12')
    assert.equal(await page.$('.data-notice'), null)
    holdList = true
    const refreshStarted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/proposals')
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
    await refreshStarted
    assert.equal(heldLists.length, 1, 'overlapping focus events must share one count refresh')
    await page.click('.proposal-card footer button')
    await page.waitForFunction(() => document.querySelector('.proposal-card footer button')?.textContent.includes('Copy link'))
    await heldLists[0].respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ ...proposal, view_count: 11 }] }) })
    holdList = false
    await new Promise(resolve => setTimeout(resolve, 100))
    assert((await page.$eval('.proposal-card footer button', element => element.textContent)).includes('Copy link'), 'an older count refresh must not undo a completed share')
    assert.equal(await page.$eval('.proposal-card dl dd', element => element.textContent), '12', 'stale count refresh must be ignored after a mutation')
    await page.keyboard.press('Escape')
    await page.setViewport({ width: 320, height: 800 })
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'proposal cards overflow on mobile')
    await page.goto(`${base}/admin/agreements`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.agreement-card')
    assert(!await page.evaluate(() => document.body.textContent.includes('Link opens')), 'agreements must not show link-open counts')
    assert.deepEqual(errors, [])
    console.log('PASS: proposal display survives tracking failure; retry deduplication; reload counts; slow assets do not delay counts; HTTP preview IDs; one initial read; no public auth; unavailable vs zero; focus refresh; stale refresh protection; mobile cards; no agreement counts.')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
