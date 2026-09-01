/**
 * Renders the storefront at three viewports and reports layout problems that
 * only show up in a real browser: horizontal overflow, console errors, failed
 * image loads, and elements spilling outside the viewport.
 *
 *   npx playwright install chromium
 *   node scripts/visual-check.mjs [--shots <dir>]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex > -1 ? process.argv[shotsIndex + 1] : null;

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'mobile', width: 390, height: 844 },
];

// A hardcoded slug becomes a 404 the moment the catalogue changes, and a 404
// still renders cleanly — so the check went on passing while testing nothing.
// Ask the API which product actually exists.
const firstProduct = await fetch(`${BASE}/api/products?limit=1`)
  .then((r) => r.json())
  .then((j) => j.products?.[0]?.slug)
  .catch(() => null);
if (!firstProduct) {
  console.error('Could not resolve a product slug from /api/products — is the server up?');
  process.exit(1);
}

const PAGES = [
  // `/` is the agent experience and deliberately carries none of the
  // storefront shell, so the shell assertions below run against /products.
  ['home', '/'],
  ['products', '/products'],
  [`product`, `/products/${firstProduct}`],
  ['categories', '/categories'],
  ['category', '/categories/laptops'],
  ['search', '/search?q=gaming+laptop'],
  ['cart', '/cart'],
  ['login', '/login'],
];

let problems = 0;
const report = [];

function flag(message) {
  problems++;
  report.push(message);
  console.log(`  [31m✗[0m ${message}`);
}

async function main() {
  if (SHOTS) await mkdir(SHOTS, { recursive: true });

  const browser = await chromium.launch();

  for (const viewport of VIEWPORTS) {
    console.log(`\n[1m${viewport.name} (${viewport.width}×${viewport.height})[0m`);
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });

    for (const [label, path] of PAGES) {
      const page = await context.newPage();
      const consoleErrors = [];
      const failedRequests = [];

      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('requestfailed', (request) => {
        failedRequests.push(`${request.url()} (${request.failure()?.errorText})`);
      });
      page.on('response', (response) => {
        if (response.status() >= 400 && response.request().resourceType() === 'image') {
          failedRequests.push(`image ${response.url()} → ${response.status()}`);
        }
      });

      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(400);

      // 1. Horizontal overflow — the body must never scroll sideways.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1) {
        flag(`${viewport.name}/${label}: page scrolls horizontally by ${overflow}px`);

        const culprits = await page.evaluate((limit) => {
          const out = [];
          for (const el of document.querySelectorAll('*')) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.right > limit + 1) {
              out.push(
                `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''} right=${Math.round(rect.right)}`,
              );
            }
            if (out.length >= 4) break;
          }
          return out;
        }, viewport.width);
        for (const culprit of culprits) console.log(`      → ${culprit}`);
      }

      // 2. Console errors.
      const realErrors = consoleErrors.filter(
        (text) => !text.includes('favicon') && !text.includes('Download the React DevTools'),
      );
      if (realErrors.length > 0) {
        flag(`${viewport.name}/${label}: ${realErrors.length} console error(s)`);
        for (const error of realErrors.slice(0, 3)) console.log(`      → ${error.slice(0, 160)}`);
      }

      // 3. Failed requests / broken images.
      if (failedRequests.length > 0) {
        flag(`${viewport.name}/${label}: ${failedRequests.length} failed request(s)`);
        for (const request of failedRequests.slice(0, 3)) console.log(`      → ${request.slice(0, 160)}`);
      }

      // 4. Every product image actually decoded.
      const brokenImages = await page.evaluate(() =>
        Array.from(document.images)
          .filter((img) => img.complete && img.naturalWidth === 0)
          .map((img) => img.currentSrc || img.src)
          .slice(0, 3),
      );
      if (brokenImages.length > 0) {
        flag(`${viewport.name}/${label}: ${brokenImages.length} image(s) failed to decode`);
        for (const src of brokenImages) console.log(`      → ${src.slice(0, 140)}`);
      }

      // 5. Design fidelity: the page must actually be black with Geist on it.
      if (label === 'home') {
        const styles = await page.evaluate(() => {
          const body = getComputedStyle(document.body);
          const h1 = document.querySelector('h1');
          return {
            background: body.backgroundColor,
            font: body.fontFamily,
            headingSize: h1 ? getComputedStyle(h1).fontSize : null,
          };
        });
        if (styles.background !== 'rgb(0, 0, 0)') {
          flag(`${viewport.name}/home: body background is ${styles.background}, expected rgb(0, 0, 0)`);
        }
        if (!/Geist/i.test(styles.font)) {
          flag(`${viewport.name}/home: font stack is "${styles.font}", expected Geist`);
        }
        console.log(
          `  [32m✓[0m home: bg ${styles.background}, h1 ${styles.headingSize}, font ${styles.font.split(',')[0]}`,
        );
      }

      // 6. Mobile: the bottom nav must be present; desktop: the FAB.
      //
      // Asserted on /products, not /: the front door is the agent experience
      // and deliberately carries none of the storefront shell.
      if (label === 'products') {
        const hasMobileNav = await page.locator('nav[aria-label="Primary"]').isVisible().catch(() => false);
        const hasFab = await page
          .locator('button[aria-label="Ask ShopiQ"]')
          .first()
          .isVisible()
          .catch(() => false);

        if (viewport.name === 'mobile' && !hasMobileNav) {
          flag('mobile/products: bottom navigation is not visible');
        }
        if (viewport.name === 'desktop' && !hasFab) {
          flag('desktop/products: Ask ShopiQ floating button is not visible');
        }
      }

      if (SHOTS) {
        await page.screenshot({
          path: `${SHOTS}/${viewport.name}-${label}.png`,
          fullPage: false,
        });
      }

      if (problems === report.length - 0 && report.length === 0) {
        // no-op, keeps output tidy
      }
      console.log(`  [32m✓[0m ${label}`);
      await page.close();
    }

    await context.close();
  }

  // Interaction check: the AI panel opens and says what it should.
  console.log('\n[1mAI entry point behaviour[0m');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.locator('button[aria-label="Ask the ShopiQ AI assistant"]').first().click();
  await page.waitForTimeout(400);

  // Phase 2 replaced the placeholder panel with the live assistant, so this
  // now checks that the conversation surface is present and usable.
  const panel = page.locator('aside[aria-label="ShopiQ AI assistant"]');
  if (!(await panel.isVisible())) {
    flag('AI panel did not open');
  } else {
    const hasInput = await panel.locator('input[aria-label="Message ShopiQ"]').isVisible();
    if (!hasInput) {
      flag('AI panel has no message input');
    } else {
      console.log('  [32m✓[0m panel opens with a live conversation input');
    }
    if (/coming soon|next phase|isn't live yet/i.test(await panel.innerText())) {
      flag('AI panel still shows the Phase 1 placeholder copy');
    }
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (await panel.isVisible()) flag('AI panel does not close on Escape');
  else console.log('  [32m✓[0m closes on Escape');

  // Add to cart from a product card updates the header badge.
  console.log('\n[1mAdd to cart from a card[0m');
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  const addButton = page.locator('button', { hasText: 'Add to Cart' }).first();
  await addButton.click();
  await page.waitForTimeout(2500);
  const badge = await page
    .locator('a[href="/cart"] span')
    .first()
    .innerText()
    .catch(() => '');
  if (!badge.trim()) flag('cart badge did not appear after adding an item');
  else console.log(`  [32m✓[0m cart badge shows "${badge.trim()}"`);

  await context.close();
  await browser.close();

  console.log(`\n${'='.repeat(52)}`);
  if (problems === 0) {
    console.log('[32mNo layout, console or image problems found.[0m');
  } else {
    console.log(`[31m${problems} problem(s):[0m`);
    for (const item of report) console.log(`  · ${item}`);
  }
  process.exit(problems > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Visual check crashed:', error);
  process.exit(1);
});
