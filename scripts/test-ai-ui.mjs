/**
 * Browser test for the AI panel.
 *
 *   npm run dev
 *   node scripts/test-ai-ui.mjs [--shots <dir>]
 *
 * Drives the real panel: opens it from the header entry point, sends a
 * Hinglish message, and checks that the rendered product cards agree with the
 * API response. Also verifies the Phase 1 storefront still works alongside it.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex > -1 ? process.argv[shotsIndex + 1] : null;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

const browser = await chromium.launch();
if (SHOTS) await mkdir(SHOTS, { recursive: true });

try {
  // ================================================================ desktop
  section('Desktop: opening the panel');

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon')) {
      consoleErrors.push(message.text());
    }
  });

  // The storefront shell — header button, mobile nav, FAB — lives on the
  // catalogue routes. `/` is the agent experience and carries none of it, so
  // every shell interaction below is driven from /products.
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });

  await page.locator('button[aria-label="Ask the ShopiQ AI assistant"]').first().click();
  await page.waitForTimeout(500);

  const panel = page.locator('aside[aria-label="ShopiQ AI assistant"]');
  check('the panel opens', await panel.isVisible());
  check(
    'the panel no longer says the assistant is coming later',
    !/next phase|coming soon|isn't live yet/i.test(await panel.innerText()),
  );
  check('an input field is present', await panel.locator('input[aria-label="Message ShopiQ"]').isVisible());
  check('suggestion chips are offered', (await panel.locator('button', { hasText: '₹' }).count()) > 0);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ai-panel-empty.png` });

  // ============================================================ a real turn
  section('A real conversation turn');

  // Capture what the API actually returned, to compare against the DOM.
  let apiPayload = null;
  page.on('response', async (response) => {
    if (response.url().includes('/api/ai/chat') && response.request().method() === 'POST') {
      apiPayload = await response.json().catch(() => null);
    }
  });

  const input = panel.locator('input[aria-label="Message ShopiQ"]');
  // Armed BEFORE the send: the reply can arrive before the next await,
  // and a waiter attached afterwards waits 45 seconds for something that
  // already happened, then blames the server.
  const chatTurn = page.waitForResponse(
    (response) => response.url().includes('/api/ai/chat') && response.request().method() === 'POST',
    { timeout: 90_000 },
  );
  await input.fill(
    'Mujhe college ke liye laptop chahiye. Programming aur thodi gaming karni hai. Budget 80 hazaar hai.',
  );
  await input.press('Enter');
  await chatTurn;
  await page.waitForTimeout(1500);

  const panelText = await panel.innerText();
  check('the user message is echoed', panelText.includes('college ke liye'));
  check('an assistant reply appears', (apiPayload?.message?.length ?? 0) > 20);
  check(
    'the reply text is rendered',
    panelText.includes((apiPayload?.message ?? '').slice(0, 40)),
  );

  const cards = panel.locator('article');
  const cardCount = await cards.count();
  check('product cards render', cardCount > 0, `${cardCount} cards`);
  check(
    'card count matches the API response',
    cardCount === (apiPayload?.products?.length ?? -1),
    `${cardCount} vs ${apiPayload?.products?.length}`,
  );

  // Every price shown must be the price the API sent — no client-side maths.
  const renderedPrices = await cards.evaluateAll((nodes) =>
    nodes.map((node) => {
      const match = node.textContent.match(/₹[\d,]+/);
      return match ? Number(match[0].replace(/[₹,]/g, '')) : null;
    }),
  );
  check(
    'every rendered price matches the API payload',
    renderedPrices.every((price, index) => price === apiPayload?.products?.[index]?.price),
    `${JSON.stringify(renderedPrices)} vs ${JSON.stringify(apiPayload?.products?.map((p) => p.price))}`,
  );
  check(
    'every rendered price is within the stated budget',
    renderedPrices.every((price) => price !== null && price <= 80000),
    JSON.stringify(renderedPrices),
  );

  check('match scores are shown', /\b(6[0-9]|7[0-9]|8[0-9]|9[0-9]|100)\b/.test(panelText));
  check('a match reason is shown', panelText.length > 400);
  check('stock status is shown', /In stock|Out of stock|Only \d+ left/.test(panelText));
  check('a "View product" link is offered', (await panel.locator('a', { hasText: 'View product' }).count()) > 0);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ai-panel-results.png` });

  // ============================================================== follow-up
  section('Follow-up keeps context');

  // Armed BEFORE the send: the reply can arrive before the next await,
  // and a waiter attached afterwards waits 45 seconds for something that
  // already happened, then blames the server.
  const followUpTurn = page.waitForResponse(
    (response) => response.url().includes('/api/ai/chat') && response.request().method() === 'POST',
    { timeout: 90_000 },
  );
  await input.fill('Thoda lightweight chahiye');
  await input.press('Enter');
  await followUpTurn;
  await page.waitForTimeout(1500);

  const afterFollowUp = await panel.locator('article').count();
  check('the follow-up returns products too', afterFollowUp > cardCount, `${afterFollowUp} total cards`);
  check(
    'the follow-up respected the remembered budget',
    (apiPayload?.products ?? []).every((product) => product.price <= 80000),
    (apiPayload?.products ?? []).map((p) => p.price).join(','),
  );

  // ============================================================= comparison
  section('Comparison renders');

  const compareButton = panel.locator('button', { hasText: 'Compare the top two' }).last();
  if (await compareButton.count()) {
    // Armed BEFORE the send: the reply can arrive before the next await,
    // and a waiter attached afterwards waits 45 seconds for something that
    // already happened, then blames the server.
    const compareTurn = page.waitForResponse(
      (response) => response.url().includes('/api/ai/chat') && response.request().method() === 'POST',
      { timeout: 90_000 },
    );
    await compareButton.click();
    await compareTurn;
    await page.waitForTimeout(1500);

    check('a comparison payload came back', apiPayload?.comparison != null);
    const comparisonText = await panel.innerText();
    check('comparison rows render', /Price|Memory|Weight|Rating/.test(comparisonText));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ai-panel-comparison.png` });
  } else {
    check('a comparison affordance is offered', false, 'no "Compare the top two" button found');
  }

  check('no console errors during the whole flow', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  // ================================================ panel closes on Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('the panel closes on Escape', !(await panel.isVisible()));

  await context.close();

  // ================================================================= mobile
  section('Mobile');

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${BASE}/products`, { waitUntil: 'networkidle' });

  await mobilePage.locator('nav[aria-label="Primary"] button[aria-label="Ask ShopiQ"]').click();
  await mobilePage.waitForTimeout(600);

  const mobilePanel = mobilePage.locator('aside[aria-label="ShopiQ AI assistant"]');
  check('the mobile nav opens the panel', await mobilePanel.isVisible());

  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('no horizontal overflow at 390px', overflow <= 1, `${overflow}px`);

  const mobileInput = mobilePanel.locator('input[aria-label="Message ShopiQ"]');
  // Armed BEFORE the send: the reply can arrive before the next await,
  // and a waiter attached afterwards waits 45 seconds for something that
  // already happened, then blames the server.
  const mobileTurn = mobilePage.waitForResponse(
    (response) => response.url().includes('/api/ai/chat') && response.request().method() === 'POST',
    { timeout: 90_000 },
  );
  await mobileInput.fill('headphones under 3000');
  await mobileInput.press('Enter');
  await mobileTurn;
  await mobilePage.waitForTimeout(1500);

  check('products render on mobile', (await mobilePanel.locator('article').count()) > 0);
  const mobileOverflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('still no overflow after results', mobileOverflow <= 1, `${mobileOverflow}px`);

  if (SHOTS) await mobilePage.screenshot({ path: `${SHOTS}/ai-panel-mobile.png` });
  await mobile.close();

  // ====================================== the storefront still works (§41)
  section('Phase 1 storefront is unaffected');

  const storefront = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const storefrontPage = await storefront.newPage();

  for (const [path, needle] of [
    ['/', 'Shop smarter'],
    ['/products', 'Products'],
    ['/categories', 'Categories'],
    ['/search?q=laptop', 'Search ShopiQ'],
    ['/cart', 'Your cart'],
  ]) {
    const response = await storefrontPage.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    const content = await storefrontPage.content();
    check(
      `${path} still renders`,
      response.status() === 200 && content.includes(needle),
      `status ${response.status()}`,
    );
  }

  // Add to cart from a product card — the Phase 1 path.
  await storefrontPage.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await storefrontPage.locator('button', { hasText: 'Add to Cart' }).first().click();
  await storefrontPage.waitForTimeout(2500);
  const badge = await storefrontPage
    .locator('a[href="/cart"] span')
    .first()
    .innerText()
    .catch(() => '');
  check('add to cart still works', badge.trim().length > 0, `badge "${badge.trim()}"`);

  await storefront.close();
} finally {
  await browser.close();
}

console.log(`\n${'='.repeat(56)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
