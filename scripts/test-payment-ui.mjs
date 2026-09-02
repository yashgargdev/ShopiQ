/**
 * Phase 4 browser test — the §48 conversation, end to end, in a real browser.
 *
 *   npm run dev
 *   node -r dotenv/config scripts/test-payment-ui.mjs dotenv_config_path=.env.local [--shots <dir>]
 *
 * Signs in a throwaway customer, shops by conversation, approves an exact
 * total on the confirmation card, pays, and checks that the order confirmation
 * the panel shows matches the order actually written to the database.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex > -1 ? process.argv[shotsIndex + 1] : null;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

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
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const state = { userId: null };

async function cleanup() {
  if (!state.userId) return;
  await admin.from('payment_events').delete().eq('customer_id', state.userId);
  await admin.from('payments').delete().eq('customer_id', state.userId);
  await admin.from('purchase_confirmations').delete().eq('customer_id', state.userId);
  const { data: orders } = await admin.from('orders').select('id').eq('customer_id', state.userId);
  for (const order of orders ?? []) await admin.from('order_items').delete().eq('order_id', order.id);
  await admin.from('orders').delete().eq('customer_id', state.userId);
  const { data: carts } = await admin.from('carts').select('id').eq('customer_id', state.userId);
  for (const cart of carts ?? []) await admin.from('cart_items').delete().eq('cart_id', cart.id);
  await admin.from('carts').delete().eq('customer_id', state.userId);
  await admin.from('conversations').delete().eq('customer_id', state.userId);
  await admin.auth.admin.deleteUser(state.userId).catch(() => {});
}

const browser = await chromium.launch();
if (SHOTS) await mkdir(SHOTS, { recursive: true });

try {
  // --------------------------------------------------------------- fixture
  section('Setup');

  const email = `ui-pay-${Date.now()}@shopiq.test`;
  const password = `Pw!${randomUUID().slice(0, 12)}`;
  const { data: user, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  state.userId = user.user.id;
  await admin.from('customers').upsert({ id: state.userId, email, full_name: 'UI Pay Tester' });

  // Nothing is quoted until we know where it ships, so a customer with no
  // saved address is blocked BEFORE the quote — correctly. This fixture is a
  // customer ready to buy, which means one with somewhere to send it.
  await admin.from('customer_addresses').insert({
    customer_id: state.userId,
    label: 'Home',
    full_name: 'UI Pay Tester',
    phone: '9876543210',
    line1: '12 Test Lane',
    city: 'Bengaluru',
    state: 'Karnataka',
    postal_code: '560001',
    country: 'IN',
    is_default: true,
  });
  check('a test customer exists', Boolean(state.userId));

  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().includes('favicon') &&
      !message.text().includes('429')
    ) {
      consoleErrors.push(message.text());
    }
  });

  // Sign in through the real form, so the session is a real session.
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  check('signed in', !page.url().includes('/login'), page.url());

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
    if (response.status() === 429 && attempt < 2) {
      const retryAfter = Number(response.headers()['retry-after'] ?? 30);
      await page.waitForTimeout((retryAfter + 2) * 1000);
      return say(text, attempt + 1);
    }
    await page.waitForTimeout(1500);
    return response;
  }

  let lastPayload = null;
  page.on('response', async (response) => {
    if (response.url().includes('/api/ai/chat') && response.request().method() === 'POST') {
      lastPayload = await response.json().catch(() => null);
    }
  });

  // The storefront shell — header button, mobile nav, FAB — lives on the
  // catalogue routes. `/` is the agent experience and carries none of it, so
  // every shell interaction below is driven from /products.
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.locator('button[aria-label="Ask the ShopiQ AI assistant"]').first().click();
  await page.waitForTimeout(600);
  check('the assistant opens', await panel.isVisible());

  // ------------------------------------------------------- the §48 flow
  section('Shopping by conversation');

  await say('Mujhe programming aur gaming ke liye laptop chahiye, 80 hazaar ke andar.');
  check('products come back', (lastPayload?.products?.length ?? 0) > 0);

  await say('First wala cart mein daal do.');
  check('the item went in the cart', (lastPayload?.cart?.items?.length ?? 0) >= 1, lastPayload?.outcome);

  await say("What's my total?");
  const cartTotal = lastPayload?.cart?.total;
  check('a total comes back', typeof cartTotal === 'number', String(cartTotal));

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pay-01-cart.png` });

  // ------------------------------------------------------ the quote
  section('The exact total is quoted for approval');

  await say("I'm ready to buy.");
  check(
    'the turn awaits purchase confirmation',
    lastPayload?.outcome === 'awaiting_purchase_confirmation',
    lastPayload?.outcome,
  );
  const purchase = lastPayload?.purchase;
  check('a purchase payload came back', Boolean(purchase?.confirmationId));
  check(
    'the quoted amount matches the cart total',
    purchase?.amountMinor === Math.round(cartTotal * 100),
    `${purchase?.amountMinor} vs ${Math.round(cartTotal * 100)}`,
  );

  const panelText = await panel.innerText();
  check('the checkout card renders', /ShopiQ Checkout/i.test(panelText));
  check('the total is shown', panelText.includes(purchase.amountDisplay), purchase.amountDisplay);
  check('a Proceed to Payment button is offered', /Proceed to Payment/i.test(panelText));
  check(
    'the card states ShopiQ never sees card details',
    /never sees your card/i.test(panelText),
  );

  // The database must agree that nothing is confirmed yet.
  const { data: pendingRow } = await admin
    .from('purchase_confirmations')
    .select('status')
    .eq('id', purchase.confirmationId)
    .single();
  check('the confirmation is still pending', pendingRow.status === 'pending', pendingRow.status);

  const { count: paymentsBefore } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.userId);
  check('no payment exists before approval', paymentsBefore === 0, String(paymentsBefore));

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pay-02-confirm.png` });

  // ------------------------------------------------------------- pay
  section('Paying');

  // Arm the waiters BEFORE clicking: these calls can complete in a few
  // milliseconds, and a waiter attached afterwards would miss them entirely.
  const createWaiter = page.waitForResponse(
    (r) => r.url().includes('/api/payments/create') && r.request().method() === 'POST',
    { timeout: 45_000 },
  );
  const settleWaiter = page.waitForResponse(
    (r) => r.url().includes('/api/payments/mock-complete') || r.url().includes('/api/payments/verify'),
    { timeout: 45_000 },
  );

  await panel.locator('button', { hasText: 'Proceed to Payment' }).last().click();

  const createResponse = await createWaiter;
  check('the payment create call succeeds', createResponse.status() === 200, String(createResponse.status()));

  // Everything past this point needs the payment to SETTLE, and only the mock
  // provider settles without a human. Against real Razorpay keys the click
  // opens Razorpay's own checkout, nothing calls back, and the suite hung for
  // 45 seconds and then died with a TimeoutError that reads like a product
  // bug. test:payment-flows already skips for the same reason; this one did
  // not, so a configuration difference looked like a regression.
  const createdPayment = await createResponse.json().catch(() => null);
  const provider = createdPayment?.payment?.provider;
  if (provider && provider !== 'mock') {
    console.log(
      `\n  \x1b[33mSKIP\x1b[0m  the server is running the "${provider}" provider.` +
        '\n        Completing a payment in the browser needs the mock provider:' +
        '\n          npm run dev:mock-https' +
        '\n        Everything up to the payment hand-off has been checked above.\n',
    );
    // settleWaiter is already armed and will never resolve. Closing the browser
    // rejects it, and an unhandled rejection would kill the process with a
    // stack trace — turning a clean skip back into something that looks broken.
    settleWaiter.catch(() => {});
    await browser.close();
    process.exit(0);
  }

  const settleResponse = await settleWaiter;
  check('the payment is settled server-side', settleResponse.status() === 200, String(settleResponse.status()));
  await page.waitForTimeout(2500);

  const afterPay = await panel.innerText();
  check('the order confirmation card renders', /Order confirmed/i.test(afterPay), afterPay.slice(-220));
  check('it shows the payment as paid', /\bPaid\b/.test(afterPay));
  check('an order number is shown', /SQ-\d{4}-\d+/.test(afterPay), (afterPay.match(/SQ-\d{4}-\d+/) ?? [])[0]);
  check('a View Order link is offered', (await panel.locator('a', { hasText: 'View Order' }).count()) > 0);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pay-03-confirmed.png` });

  // ----------------------------------------------- the database agrees
  section('The database agrees with the panel');

  const { data: order } = await admin
    .from('orders')
    .select('id, order_number, payment_status, total')
    .eq('customer_id', state.userId)
    .single();
  check('exactly one order exists', Boolean(order?.id));
  check('it is marked paid', order.payment_status === 'paid', order.payment_status);
  check(
    'the panel shows the same order number',
    afterPay.includes(order.order_number),
    order.order_number,
  );
  check(
    'the charged total matches the quoted total',
    Math.round(Number(order.total) * 100) === purchase.amountMinor,
    `${order.total} vs ${purchase.amountMinor / 100}`,
  );

  const { data: cartAfter } = await admin
    .from('carts')
    .select('id')
    .eq('customer_id', state.userId)
    .eq('status', 'active')
    .maybeSingle();
  check('the cart was cleared after success', cartAfter === null);

  // ---------------------------------------------- the assistant knows
  section('The assistant can answer about it');

  await say('Did my payment go through?');
  check(
    'it confirms the payment',
    /went through/i.test(lastPayload?.message ?? ''),
    lastPayload?.message?.slice(0, 80),
  );

  await say('What was my order number?');
  check(
    'it quotes the real order number',
    (lastPayload?.message ?? '').includes(order.order_number),
    lastPayload?.message?.slice(0, 80),
  );

  // -------------------------------------------------- the order page
  section('The order page');

  const orderPage = await context.newPage();
  await orderPage.goto(`${BASE}/orders/${order.id}`, { waitUntil: 'networkidle' });
  const orderText = await orderPage.innerText('body');
  check('the order page shows the order number', orderText.includes(order.order_number));
  check('and the payment status', /paid/i.test(orderText));
  if (SHOTS) await orderPage.screenshot({ path: `${SHOTS}/pay-04-order.png` });
  await orderPage.close();

  check('no console errors throughout', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await context.close();

  console.log(`\n${'='.repeat(56)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  · ${f}`);
  }
} finally {
  await browser.close();
  console.log('\nCleaning up…');
  await cleanup();
}

process.exit(failed > 0 ? 1 : 0);
