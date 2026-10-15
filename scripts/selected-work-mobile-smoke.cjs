/* Selected Work layout checks with an intercepted portfolio API. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5174';
const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'hich-selected-work-'));

function image(width, height, label, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color}"/><rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#142725" stroke-width="16"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-size="40" fill="#142725">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const portrait = image(480, 800, 'PORTRAIT', '#eacb9d');
const landscape = image(960, 540, 'LANDSCAPE', '#a7d2c8');
const projects = [
  {
    id: 'portrait-project', title: 'Portrait Project', category: 'Web design',
    published: true, featured: true, sort_order: 0,
    main_description: 'A portrait case study with a long enough description to exercise the mobile dialog layout.',
    sub_description: 'A tall visual with every edge visible.', images: [portrait, landscape],
  },
  {
    id: 'landscape-project', title: 'Landscape Project', category: 'Commerce',
    published: true, sort_order: 1,
    main_description: 'A wide case study with all image edges visible.', images: [landscape],
  },
];

async function noHorizontalOverflow(page, label) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(size.document <= size.viewport + 1 && size.body <= size.viewport + 1, `${label}: horizontal overflow ${JSON.stringify(size)}`);
}

async function assertUncropped(page, selector, label) {
  const images = await page.$$eval(selector, nodes => nodes.map(image => {
    const clip = image.parentElement.getBoundingClientRect();
    const box = image.getBoundingClientRect();
    const fit = getComputedStyle(image).objectFit;
    const naturalRatio = image.naturalWidth / image.naturalHeight;
    const boxRatio = box.width / box.height;
    return {
      complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      fit, naturalRatio, boxRatio,
      clip: { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom, width: clip.width, height: clip.height },
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      contained: box.left >= clip.left - 1 && box.top >= clip.top - 1 && box.right <= clip.right + 1 && box.bottom <= clip.bottom + 1,
    };
  }));
  assert.ok(images.length, `${label}: no project images found`);
  for (const [index, image] of images.entries()) {
    assert.ok(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0, `${label} image ${index + 1} did not load`);
    assert.ok(image.contained, `${label} image ${index + 1} extends outside its frame: ${JSON.stringify(image)}`);
    const naturalShapeMatchesBox = Math.abs(image.naturalRatio - image.boxRatio) / image.naturalRatio < 0.025;
    assert.ok(['contain', 'scale-down'].includes(image.fit) || (['cover', 'fill'].includes(image.fit) && naturalShapeMatchesBox), `${label} image ${index + 1} is cropped or distorted: ${JSON.stringify(image)}`);
  }
}

async function assertCloseReachable(page, label) {
  const reachable = await page.$eval('[role="dialog"] [aria-label="Close dialog"]', button => {
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return rect.width >= 24 && rect.height >= 24 && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && button.contains(document.elementFromPoint(x, y));
  });
  assert.ok(reachable, `${label}: dialog close control is covered or outside the viewport`);
}

async function waitForSettledDialog(page) {
  await page.waitForFunction(() => {
    const modal = document.querySelector('.modal');
    const shell = document.querySelector('.modal-shell');
    return Boolean(modal && shell) && [modal, shell].every(element => element.getAnimations().every(animation => animation.playState !== 'running'));
  });
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const errors = [];
  const checks = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      if (url.pathname === '/api/public/portfolio') {
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects }) });
      }
      return request.respond({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'Unexpected test API request' }) });
    });

    for (const [width, height] of [[320, 640], [390, 844], [1440, 900]]) {
      const mobile = width < 760;
      await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
      await page.goto(`${base}/#work`, { waitUntil: 'networkidle0' });
      try {
        await page.waitForFunction(() => document.querySelectorAll('.project-card__visual img').length === 2, { timeout: 10_000 });
      } catch (error) {
        const state = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 1200), cards: document.querySelectorAll('.project-card').length }));
        throw new Error(`Portfolio cards did not appear: ${JSON.stringify(state)}`, { cause: error });
      }
      for (const cardImage of await page.$$('.project-card__visual img')) {
        await cardImage.evaluate(image => image.scrollIntoView({ block: 'center' }));
      }
      try {
        await page.waitForFunction(() => [...document.querySelectorAll('.project-card__visual img')].every(image => image.complete && image.naturalWidth > 0), { timeout: 10_000 });
      } catch (error) {
        const state = await page.$$eval('.project-card__visual img', images => images.map(image => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, src: image.currentSrc.slice(0, 100) })));
        throw new Error(`Portfolio images did not decode: ${JSON.stringify(state)}`, { cause: error });
      }
      await noHorizontalOverflow(page, `Selected Work ${width}px`);
      if (mobile) await assertUncropped(page, '.project-card__visual img', `Selected Work ${width}px`);
      // Element screenshots stitch a tall section across scroll positions. Hide
      // the sticky header only while capturing, so it does not appear midway.
      const screenshotStyle = await page.addStyleTag({ content: '.public-nav { visibility: hidden !important; }' });
      await (await page.$('#work')).screenshot({ path: path.join(screenshots, `selected-work-${width}.png`) });
      await screenshotStyle.evaluate(style => style.remove());

      await page.click('[aria-label="View Portrait Project project"]');
      await page.waitForSelector('[role="dialog"] .case-study__image img');
      await waitForSettledDialog(page);
      await assertCloseReachable(page, `Portrait dialog ${width}px`);
      await noHorizontalOverflow(page, `Portrait dialog ${width}px`);
      await assertUncropped(page, '.case-study__image img', `Portrait dialog ${width}px`);
      await page.screenshot({ path: path.join(screenshots, `project-dialog-portrait-${width}.png`) });

      await page.click('[aria-label="Next image"]');
      await page.waitForFunction(() => document.querySelector('.case-study__image img')?.alt.includes('image 2 of 2'));
      await assertUncropped(page, '.case-study__image img', `Landscape gallery image ${width}px`);
      await page.click('[aria-label="Previous image"]');
      await page.waitForFunction(() => document.querySelector('.case-study__image img')?.alt.includes('image 1 of 2'));
      await page.click('.case-study__project-nav button:last-child');
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('Landscape Project'));
      await waitForSettledDialog(page);
      await assertUncropped(page, '.case-study__image img', `Landscape project dialog ${width}px`);
      await page.screenshot({ path: path.join(screenshots, `project-dialog-landscape-${width}.png`) });
      await page.click('.case-study__project-nav button:first-child');
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('Portrait Project'));
      await page.click('[role="dialog"] [aria-label="Close dialog"]');
      await page.waitForSelector('[role="dialog"]', { hidden: true });
      await page.click('[aria-label="View Landscape Project project"]');
      await page.waitForSelector('[role="dialog"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="dialog"]', { hidden: true });
      checks.push(`${width}px: no overflow; dialog images uncropped; gallery, project navigation, close, Escape${mobile ? '; mobile cards uncropped' : ''}`);
    }

    assert.deepEqual(errors, [], `Browser errors: ${JSON.stringify(errors)}`);
    console.log(JSON.stringify({ checks, screenshots, browserErrors: errors }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
