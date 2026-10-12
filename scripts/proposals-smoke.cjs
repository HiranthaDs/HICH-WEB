const fs = require('fs')
const assert = require('assert')
const puppeteer = require('puppeteer')

const baseUrl = process.env.PROPOSAL_PREVIEW_URL || 'http://127.0.0.1:4173'
const samplePath = process.env.PROPOSAL_SAMPLE_HTML
if (!samplePath) throw new Error('Set PROPOSAL_SAMPLE_HTML to a complete proposal HTML file.')
const html = fs.readFileSync(samplePath, 'utf8')
const date = '2026-01-03T00:00:00Z'
const client = { id: 'client-existing', name: 'Alice Carter', company: 'Carter Logistics', email: 'alice@example.com', phone: '+94770000000', address: 'Colombo', status: 'active', created_at: date, updated_at: date }
const clients = [client, { ...client, id: 'client-second', name: 'Brian Silva', company: 'Silva Holdings' }]
const proposals = [{ id: 'proposal-linked', public_id: 'public-linked', client_id: client.id, client_name: client.name, client_company: client.company, client_email: client.email, client_phone: client.phone, title: 'Existing linked proposal', reference: 'PROP-LINKED', html_content: '<!doctype html><html><body><h1>Existing proposal</h1></body></html>', status: 'sent', version: 1, created_at: date, updated_at: date, sent_at: date }]
const writes = []
const json = (request, body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function intercept(request) {
  const { pathname } = new URL(request.url())
  const method = request.method()
  if (!pathname.startsWith('/api/')) return request.continue()
  if (pathname === '/api/public/proposals/test-token') return json(request, { proposal: { id: 'public-test', client_id: client.id, title: 'Vehicle Management & ERP Proposal', reference: 'PROP-TEST', html_content: html, status: 'viewed', version: 1 } })
  if (pathname === '/api/auth/me') return json(request, { user: { id: 'admin-test', email: 'admin@example.com', name: 'QA Admin', role: 'admin' } })
  if (pathname === '/api/communications/email-status') return json(request, { available: false })
  if (pathname === '/api/clients' && method === 'GET') return json(request, { items: clients, total: clients.length })
  if (pathname === '/api/clients' && method === 'POST') {
    const body = JSON.parse(request.postData() || '{}')
    const created = { ...body, id: 'client-new', created_at: date, updated_at: date }
    clients.unshift(created); writes.push({ pathname, body }); return json(request, { client: created }, 201)
  }
  if (pathname === `/api/clients/${client.id}/profile`) return json(request, { profile: { client, invoices: [], agreements: [], proposals: [proposals.find(item => item.id === 'proposal-linked')] } })
  if (pathname === '/api/proposals' && method === 'GET') return json(request, { items: proposals, total: proposals.length })
  if (pathname === '/api/proposals' && method === 'POST') {
    const body = JSON.parse(request.postData() || '{}')
    const linked = clients.find(item => String(item.id) === String(body.client_id))
    const created = { ...body, id: `proposal-${proposals.length + 1}`, public_id: `public-${proposals.length + 1}`, client_name: linked?.name, client_company: linked?.company, client_email: linked?.email, client_phone: linked?.phone, reference: body.reference || `PROP-QA-${proposals.length + 1}`, status: 'draft', version: 1, created_at: date, updated_at: date }
    proposals.unshift(created); writes.push({ pathname, body }); return json(request, { proposal: created }, 201)
  }
  const share = pathname.match(/^\/api\/proposals\/([^/]+)\/share$/)
  if (share && method === 'POST') return json(request, { share: { share_url: `${baseUrl}/proposal/token-${share[1]}` } })
  const proposal = pathname.match(/^\/api\/proposals\/([^/]+)$/)
  if (proposal && method === 'GET') {
    const found = proposals.find(item => String(item.id) === decodeURIComponent(proposal[1]))
    return found ? json(request, { proposal: found }) : json(request, { detail: 'Not found' }, 404)
  }
  return json(request, { detail: `Unhandled smoke route: ${method} ${pathname}` }, 500)
}

async function pageFor(browser) {
  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', request => { void intercept(request).catch(() => request.abort().catch(() => {})) })
  return page
}

async function clickText(page, selector, text, exact = true) {
  const matches = (value, target) => exact ? value === target : value.includes(target)
  await page.waitForFunction((selector, text, exact) => Array.from(document.querySelectorAll(selector)).some(element => (exact ? element.textContent?.replace(/\s+/g, ' ').trim() === text : element.textContent?.includes(text))), {}, selector, text, exact)
  const clicked = await page.$$eval(selector, (elements, text, exact) => {
    const target = elements.find(element => exact ? element.textContent?.replace(/\s+/g, ' ').trim() === text : element.textContent?.includes(text))
    target?.click(); return Boolean(target)
  }, text, exact)
  assert(clicked && matches(text, text))
}

async function fill(page, label, value) {
  assert(await page.evaluate((label, value) => {
    const field = Array.from(document.querySelectorAll('label.field')).find(item => item.querySelector('.field__label')?.textContent?.trim().startsWith(label))
    const control = field?.querySelector('input, textarea') || (label === 'Complete proposal HTML' ? document.querySelector('textarea[aria-label="Complete proposal HTML"]') : null)
    if (!control) return false
    const proto = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true })); return true
  }, label, value), `Missing field: ${label}`)
}

async function publicCheck(browser, width, height) {
  const page = await pageFor(browser)
  await page.setViewport({ width, height })
  await page.goto(`${baseUrl}/proposal/test-token`, { waitUntil: 'networkidle0' })
  const frame = await (await page.waitForSelector('.proposal-public-viewer iframe')).contentFrame()
  await frame.waitForSelector('h1')
  const result = await frame.evaluate(() => {
    let parentAccessible = true
    try { void window.parent.document.body } catch { parentAccessible = false }
    return { heading: document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim(), viewport: document.querySelector('meta[name="viewport"]')?.content, logoLoaded: Array.from(document.images).some(image => /hich/i.test(image.alt) && image.naturalWidth > 0), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, parentAccessible, bodyHeight: document.body.scrollHeight }
  })
  await page.close(); return result
}

async function adminCheck(browser) {
  const page = await pageFor(browser)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${baseUrl}/admin/proposals`, { waitUntil: 'networkidle0' })
  await clickText(page, 'button', 'New proposal')
  await clickText(page, '.proposal-client-option', client.name, false)
  await page.waitForSelector('.proposal-selected-client')
  await clickText(page, '.proposal-client-mode button', 'Existing client')
  assert.strictEqual(await page.$eval('.proposal-selected-client strong', element => element.textContent), client.name)
  await fill(page, 'Proposal title', 'Existing client quotation')
  await fill(page, 'Complete proposal HTML', '<!doctype html><html><body><h1>Existing quotation</h1></body></html>')
  await clickText(page, 'button', 'Save & create link')
  await page.waitForFunction(() => document.querySelector('.modal h2')?.textContent === 'Send proposal & quotation')
  assert.strictEqual(writes.find(item => item.pathname === '/api/proposals')?.body.client_id, client.id)
  await page.click('.modal-shell [aria-label="Close dialog"]')

  await clickText(page, 'button', 'New proposal')
  await clickText(page, '.proposal-client-mode button', 'New client')
  await fill(page, 'Client name', 'Nimal Perera')
  await fill(page, 'Proposal title', 'New client quotation')
  await fill(page, 'Complete proposal HTML', '<!doctype html><html><body><h1>New quotation</h1></body></html>')
  await clickText(page, 'button', 'Save & create link')
  await page.waitForFunction(() => document.querySelector('.modal h2')?.textContent === 'Send proposal & quotation')
  assert(writes.some(item => item.pathname === '/api/clients' && item.body.name === 'Nimal Perera'))
  assert.strictEqual(writes.filter(item => item.pathname === '/api/proposals').at(-1).body.client_id, 'client-new')
  await page.click('.modal-shell [aria-label="Close dialog"]')

  await page.goto(`${baseUrl}/admin/clients?client=${client.id}`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => document.body.textContent.includes('Proposals & quotations (1)'))
  await clickText(page, 'a', 'Open proposal')
  await page.waitForFunction(() => location.search.includes('proposal=proposal-linked') && document.querySelector('.modal h2')?.textContent === 'Edit proposal & quotation')
  assert.strictEqual(await page.$eval('.proposal-selected-client strong', element => element.textContent), client.name)
  await page.click('.modal-shell [aria-label="Close dialog"]')

  await page.setViewport({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/admin/proposals`, { waitUntil: 'networkidle0' })
  await clickText(page, 'button', 'New proposal')
  await new Promise(resolve => setTimeout(resolve, 300))
  const mobile = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, touchTargets: Array.from(document.querySelectorAll('.proposal-client-mode button')).map(item => item.getBoundingClientRect().height), clients: document.querySelectorAll('.proposal-client-option').length }))
  assert(!mobile.overflow && mobile.touchTargets.every(height => height >= 44) && mobile.clients >= 2, JSON.stringify(mobile))
  assert.deepStrictEqual(errors, [])
  await page.close()
  return { existingAndNewClientLinking: true, exactProfileDeepLink: true, mobile }
}

async function run() {
  const browser = await puppeteer.launch({ headless: true })
  try {
    const desktop = await publicCheck(browser, 1440, 900)
    const mobile = await publicCheck(browser, 390, 844)
    assert(desktop.heading && mobile.heading && desktop.logoLoaded && mobile.logoLoaded)
    assert(!desktop.horizontalOverflow && !mobile.horizontalOverflow && !desktop.parentAccessible && !mobile.parentAccessible)
    const admin = await adminCheck(browser)
    process.stdout.write(`${JSON.stringify({ public: { desktop, mobile }, admin }, null, 2)}\n`)
  } finally { await browser.close() }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
