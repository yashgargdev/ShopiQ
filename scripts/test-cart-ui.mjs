/**
 * Browser test for the Phase 3 agentic cart UI.
 *
 *   npm run dev
 *   node scripts/test-cart-ui.mjs [--shots <dir>]
 *
 * Drives the real panel: adds a product by voice-of-the-shopper, checks the
 * cart card renders the same numbers the API returned, confirms the website's
 * own cart badge picks the change up, and walks the clear-cart confirmation.
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    // 429s are expected when the suites run back to back against one IP; the
    // helper below waits them out, so they are not a product defect.
    if (
      message.type() === 'error' &&
      !message.text().includes('favicon') &&
      !message.text().includes('429')
    ) {
      consoleErrors.push(message.text());
    }
  });

  let lastPayload = null;
  page.on('response', async (response) => {
    if (response.url().includes('/api/ai/chat') && response.request().method() === 'POST') {
      lastPayload = await response.json().catch(() => null);
    }
  });

  const panel = page.locator('aside[aria-label="ShopiQ AI assistant"]');
  const input = panel.locator('input[aria-label="Message ShopiQ"]');

  async function say(text, attempt = 0) {
    // The composer is disabled while a turn is in flight, and fill() on a
    // disabled input silently does nothing — so Enter never submits and the
    // response wait times out with an empty log. Waiting for it to be editable
    // is the difference between a real failure and a chain-order race.
    await input.waitFor({ state: 'visible', timeout: 30_000 });
    for (let waited = 0; waited < 60_000 && !(await input.isEnabled()); waited += 250) {
      await page.waitForTimeout(250);
    }
    await input.fill(text);
    await input.press('Enter');
    const response = await page.waitForResponse(
      (r) => r.url().includes('/api/ai/chat') && r.request().method() === 'POST',
      { timeout: 45_000 },
    );

    // Shared-IP rate limiting: wait the window out and send again rather than
    // reporting a false failure.
    if (response.status() === 429 && attempt < 2) {
      const retryAfter = Number(response.headers()['retry-after'] ?? 30);
      await page.waitForTimeout((retryAfter + 2) * 1000);
      return say(text, attempt + 1);
    }

    await page.waitForTimeout(1400);
    return response;
  }

  // ============================================================== setup
  section('Opening the assistant');

  // The storefront shell — header button, mobile nav, FAB — lives on the
  // catalogue routes. `/` is the agent experience and carries none of it, so
  // every shell interaction below is driven from /products.
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.locator('button[aria-label="Ask the ShopiQ AI assistant"]').first().click();
  await page.waitForTimeout(500);
  check('panel opens', await panel.isVisible());

  // ======================================================== product cards
  section('Product cards offer Add to Cart');

  await say('laptop for programming and gaming under 80000');
  check('products returned', (lastPayload?.products?.length ?? 0) > 0);

  const addButtons = panel.locator('button', { hasText: 'Add to Cart' });
  check('every card has an Add to Cart button', (await addButtons.count()) > 0);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cart-01-products.png` });

  // ============================================================ add by chat
  section('Adding by conversation');

  await say('add the first one');

  check('intent routed to cart_add', lastPayload?.intent === 'cart_add', lastPayload?.intent);
  check('outcome is cart_updated', lastPayload?.outcome === 'cart_updated', lastPayload?.outcome);
  check('a cart payload came back', Boolean(lastPayload?.cart));
  check('cart has one line', lastPayload?.cart?.items?.length === 1);

  const panelText = await panel.innerText();
  check('the cart card renders', /Your ShopiQ cart/i.test(panelText));

  // The rendered total must equal the API's total exactly — no client maths.
  const apiTotal = lastPayload?.cart?.total;
  const renderedTotals = await panel
    .locator('text=/^₹[\\d,]+$/')
    .allInnerTexts()
    .catch(() => []);
  const renderedNumbers = renderedTotals.map((t) => Number(t.replace(/[₹,]/g, '')));
  check(
    'the rendered total matches the API total',
    renderedNumbers.includes(apiTotal),
    `api ${apiTotal} vs rendered ${JSON.stringify(renderedNumbers)}`,
  );

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cart-02-added.png` });

  // ==================================================== website cart sync
  section('The website cart is the same cart');

  const badge = await page
    .locator('a[href="/cart"] span')
    .first()
    .innerText()
    .catch(() => '');
  check('header badge updated', badge.trim() === String(lastPayload.cart.itemCount), `badge "${badge.trim()}"`);

  const cartPage = await context.newPage();
  await cartPage.goto(`${BASE}/cart`, { waitUntil: 'networkidle' });
  const cartPageText = await cartPage.innerText('body');
  const addedName = lastPayload.cart.items[0].name;
  check(
    'the /cart page shows what the AI added',
    cartPageText.includes(addedName),
    addedName,
  );
  await cartPage.close();

  // ============================================================== quantity
  section('Quantity through conversation');

  await say('make it two');
  check('quantity is now 2', lastPayload?.cart?.items?.[0]?.quantity === 2, String(lastPayload?.cart?.items?.[0]?.quantity));

  await say('actually remove one');
  check('quantity back to 1', lastPayload?.cart?.items?.[0]?.quantity === 1, String(lastPayload?.cart?.items?.[0]?.quantity));

  // ============================================================== checkout
  section('Checkout preview');

  // This session is a GUEST. Asking to buy no longer produces a checkout
  // summary: the assistant signs the customer in first, because an order
  // taken against no account is an order nobody can look up afterwards.
  await say("I'm ready to buy");
  const checkoutText = await panel.innerText();

  check(
    'a guest is asked to sign in before checkout',
    /email/i.test(checkoutText),
    lastPayload?.outcome,
  );
  check(
    'no purchase is quoted to a signed-out visitor',
    !lastPayload?.purchase,
    JSON.stringify(lastPayload?.purchase ?? null),
  );
  // The sign-in reply carries no cart payload — that is the shape of the
  // reply, not the state of the cart. The header badge reads the real thing.
  const badgeAfterSignInPrompt = await page
    .locator('a[href="/cart"] span')
    .first()
    .innerText()
    .catch(() => '');
  check(
    'the cart survives being asked to sign in',
    badgeAfterSignInPrompt.trim() === '1',
    `badge "${badgeAfterSignInPrompt.trim()}"`,
  );

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cart-03-checkout.png` });

  // ========================================================== confirmation
  section('Clear cart requires confirmation');

  await say('clear my cart');
  check('outcome is awaiting_confirmation', lastPayload?.outcome === 'awaiting_confirmation', lastPayload?.outcome);
  check('a pending action came back', lastPayload?.pendingAction?.action === 'clear_cart');

  const confirmText = await panel.innerText();
  check('a confirmation card renders', /Yes, do it/i.test(confirmText));

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cart-04-confirm.png` });

  // Cancel via the button.
  await panel.locator('button', { hasText: 'Keep it' }).last().click();
  await page.waitForResponse(
    (r) => r.url().includes('/api/ai/chat') && r.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await page.waitForTimeout(1200);
  check('cancelling leaves the cart alone', lastPayload?.outcome === 'cancelled', lastPayload?.outcome);

  await say('what is in my cart');
  check('the cart survived the cancel', (lastPayload?.cart?.items?.length ?? 0) === 1);

  // Now actually confirm.
  await say('clear my cart');
  check('confirmation is asked again', lastPayload?.outcome === 'awaiting_confirmation');

  await panel.locator('button', { hasText: 'Yes, do it' }).last().click();
  await page.waitForResponse(
    (r) => r.url().includes('/api/ai/chat') && r.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await page.waitForTimeout(1200);
  check('the cart is cleared after a yes', (lastPayload?.cart?.items?.length ?? -1) === 0, JSON.stringify(lastPayload?.cart?.items));

  check('no console errors throughout', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await context.close();

  // ================================================================ mobile
  section('Mobile');

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await mobilePage.locator('nav[aria-label="Primary"] button[aria-label="Ask ShopiQ"]').click();
  await mobilePage.waitForTimeout(600);

  const mobilePanel = mobilePage.locator('aside[aria-label="ShopiQ AI assistant"]');
  const mobileInput = mobilePanel.locator('input[aria-label="Message ShopiQ"]');

  await mobileInput.fill('headphones under 3000');
  await mobileInput.press('Enter');
  await mobilePage.waitForResponse(
    (r) => r.url().includes('/api/ai/chat') && r.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await mobilePage.waitForTimeout(1200);

  await mobileInput.fill('add the first one');
  await mobileInput.press('Enter');
  await mobilePage.waitForResponse(
    (r) => r.url().includes('/api/ai/chat') && r.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await mobilePage.waitForTimeout(1400);

  check('cart card renders on mobile', /Your ShopiQ cart/i.test(await mobilePanel.innerText()));

  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('no horizontal overflow at 390px', overflow <= 1, `${overflow}px`);

  if (SHOTS) await mobilePage.screenshot({ path: `${SHOTS}/cart-05-mobile.png` });
  await mobile.close();
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
