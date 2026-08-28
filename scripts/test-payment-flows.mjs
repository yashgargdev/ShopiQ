/**
 * Phase 4 flow tests — the success path and every failure the spec names.
 *
 *   npm run dev
 *   node -r dotenv/config scripts/test-payment-flows.mjs dotenv_config_path=.env.local
 *
 * Split from test-payments.mjs (which covers the authorization gate) so each
 * file stays readable. This one walks a payment all the way to an order, then
 * proves the failure paths leave money, stock and the cart in a safe state:
 * failed payment, price change, cart change, expiry, out of stock, duplicate
 * webhook, forged webhook, and another customer trying to use the
 * confirmation.
 */
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Must match lib/payments/mock.ts. The mock implements Razorpay's documented
// HMAC, so signing here exercises the real verification code.
const MOCK_SECRET = 'shopiq_mock_secret_not_a_real_key';
const sign = (orderId, paymentId) =>
  createHmac('sha256', MOCK_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const signBody = (body) => createHmac('sha256', MOCK_SECRET).update(body).digest('hex');

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

function session() {
  const jar = new Map();
  const self = {
    async http(path, init = {}) {
      const cookie = Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
      const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(init.headers ?? {}),
        },
        redirect: 'manual',
      });
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return { status: response.status, payload: await response.json().catch(() => null) };
    },
    async signIn(email, password) {
      const anon = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        { auth: { persistSession: false } },
      );
      const { data, error } = await anon.auth.signInWithPassword({ email, password });
      if (error) throw new Error(`sign-in failed: ${error.message}`);
      const ref = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
      const payload = Buffer.from(
        JSON.stringify({
          access_token: data.session.access_token,
          token_type: 'bearer',
          expires_at: data.session.expires_at,
          expires_in: data.session.expires_in,
          refresh_token: data.session.refresh_token,
          user: data.session.user,
        }),
      ).toString('base64');
      jar.set(`sb-${ref}-auth-token`, `base64-${payload}`);
    },
  };
  return self;
}

const state = { userId: null, intruderId: null, productId: null, originalPrice: null };

async function purge(userId) {
  if (!userId) return;
  await admin.from('payment_events').delete().eq('customer_id', userId);
  await admin.from('payments').delete().eq('customer_id', userId);
  await admin.from('purchase_confirmations').delete().eq('customer_id', userId);
  const { data: orders } = await admin.from('orders').select('id').eq('customer_id', userId);
  for (const order of orders ?? []) await admin.from('order_items').delete().eq('order_id', order.id);
  await admin.from('orders').delete().eq('customer_id', userId);
  const { data: carts } = await admin.from('carts').select('id').eq('customer_id', userId);
  for (const cart of carts ?? []) await admin.from('cart_items').delete().eq('cart_id', cart.id);
  await admin.from('carts').delete().eq('customer_id', userId);
  await admin.from('conversations').delete().eq('customer_id', userId);
  await admin.auth.admin.deleteUser(userId).catch(() => {});
}

async function cleanup() {
  if (state.productId && state.originalPrice != null) {
    await admin
      .from('products')
      .update({ price: state.originalPrice })
      .eq('id', state.productId);
    await admin
      .from('inventory')
      .update({ quantity: 50, reserved_quantity: 0 })
      .eq('product_id', state.productId);
  }
  await purge(state.userId);
  await purge(state.intruderId);
  await admin.from('webhook_events').delete().like('event_id', 'test_evt_%');
}

process.on('uncaughtException', async (error) => {
  console.error('\nUNCAUGHT:', error);
  await cleanup();
  process.exit(1);
});

try {
  // ================================================================ setup
  section('Setup');

  const email = `flow-${Date.now()}@shopiq.test`;
  const password = `Pw!${randomUUID().slice(0, 12)}`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw new Error(userError.message);
  state.userId = user.user.id;
  await admin.from('customers').upsert({ id: state.userId, email, full_name: 'Flow Tester' });

  const { data: product } = await admin
    .from('products')
    .select('id, name, price')
    .eq('is_active', true)
    .gt('price', 1500)
    .lt('price', 9000)
    .limit(1)
    .single();
  state.productId = product.id;
  state.originalPrice = Number(product.price);
  await admin
    .from('inventory')
    .update({ quantity: 50, reserved_quantity: 0 })
    .eq('product_id', product.id);
  check('fixtures ready', Boolean(state.userId && state.productId), product?.name);

  const shopper = session();
  await shopper.signIn(email, password);

  const expectedShipping = state.originalPrice >= 999 ? 0 : 79;
  const expectedTotalMinor = Math.round((state.originalPrice + expectedShipping) * 100);

  async function freshConfirmation() {
    const requested = await shopper.http('/api/checkout/confirm', {
      method: 'POST',
      body: JSON.stringify({ action: 'request' }),
    });
    const id = requested.payload?.confirmation?.id;
    if (id) {
      await shopper.http('/api/checkout/confirm', {
        method: 'POST',
        body: JSON.stringify({ action: 'grant', confirmationId: id }),
      });
    }
    return requested.payload?.confirmation ?? null;
  }

  // ================================================== the happy path
  section('Successful payment, end to end');

  await shopper.http('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, quantity: 1 }),
  });

  const confirmation = await freshConfirmation();
  check(
    'the confirmed total is the server total',
    confirmation?.amount_minor === expectedTotalMinor,
    `${confirmation?.amount_minor} vs ${expectedTotalMinor}`,
  );

  const createdPayment = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  const payment = createdPayment.payload?.payment;
  check('a provider order exists', Boolean(payment?.provider_order_id));

  // This suite forges Razorpay signatures, which only the mock provider will
  // accept — and that is the point: against real keys, signature verification
  // MUST reject them. So the run is meaningless unless the server was started
  // in mock mode, and saying so beats failing halfway through with a
  // TypeError that looks like a product bug.
  if (payment?.provider && payment.provider !== 'mock') {
    console.log(
      `\n  \x1b[33mSKIP\x1b[0m  the server is running the "${payment.provider}" provider.` +
        '\n        These tests forge signatures, so they need the mock provider:' +
        '\n          npm run dev:mock-https' +
        '\n        Real-key signature rejection is covered by test:security.\n',
    );
    process.exit(0);
  }
  check('for the exact confirmed amount', payment?.amount === expectedTotalMinor);

  const okPaymentId = `pay_ok_${payment.provider_order_id}`;
  const verified = await shopper.http('/api/payments/verify', {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: payment.provider_order_id,
      razorpay_payment_id: okPaymentId,
      razorpay_signature: sign(payment.provider_order_id, okPaymentId),
    }),
  });

  check('verification succeeds', verified.status === 200, JSON.stringify(verified.payload).slice(0, 150));
  const order = verified.payload?.payment?.order;
  check('an order number comes back', /^SQ-\d{4}-\d+$/.test(order?.order_number ?? ''), order?.order_number);
  check('the order total equals the charge', order?.total_minor === expectedTotalMinor);

  const { data: paidRow } = await admin
    .from('payments')
    .select('status, order_id')
    .eq('id', payment.payment_id)
    .single();
  check('the payment is captured', paidRow.status === 'captured', paidRow.status);
  check('and is linked to the order', paidRow.order_id === order.id);

  const { data: orderRow } = await admin
    .from('orders')
    .select('payment_status, payment_method, payment_reference, total')
    .eq('id', order.id)
    .single();
  check('the order is marked paid', orderRow.payment_status === 'paid', orderRow.payment_status);
  check('the payment reference is stored', orderRow.payment_reference === okPaymentId);
  check(
    'the order stores the historical total',
    Number(orderRow.total) === state.originalPrice + expectedShipping,
    String(orderRow.total),
  );

  const { data: confRow } = await admin
    .from('purchase_confirmations')
    .select('status')
    .eq('id', confirmation.id)
    .single();
  check('the confirmation is consumed', confRow.status === 'consumed', confRow.status);

  const { data: activeCart } = await admin
    .from('carts')
    .select('id')
    .eq('customer_id', state.userId)
    .eq('status', 'active')
    .maybeSingle();
  check('the cart was cleared only after success', activeCart === null);

  const { data: inv } = await admin
    .from('inventory')
    .select('reserved_quantity')
    .eq('product_id', product.id)
    .single();
  check('stock was finalized exactly once', inv.reserved_quantity === 1, String(inv.reserved_quantity));

  const replayed = await shopper.http('/api/payments/verify', {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: payment.provider_order_id,
      razorpay_payment_id: okPaymentId,
      razorpay_signature: sign(payment.provider_order_id, okPaymentId),
    }),
  });
  check('a replayed callback is safe', replayed.status === 200);
  check(
    'and returns the same order',
    replayed.payload?.payment?.order?.order_number === order.order_number,
  );

  const { count: orderCount } = await admin
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.userId);
  check('exactly one order exists', orderCount === 1, String(orderCount));

  // ============================================ the assistant reads back
  section('The assistant answers from the database');

  const payQ = await shopper.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'did my payment go through?' }),
  });
  check('payment question routes correctly', payQ.payload?.intent === 'payment_status', payQ.payload?.intent);
  check(
    'and reports the real outcome',
    /went through/i.test(payQ.payload?.message ?? ''),
    payQ.payload?.message?.slice(0, 80),
  );

  const orderQ = await shopper.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: payQ.payload.conversationId,
      message: 'what was my order number?',
    }),
  });
  check('order question routes correctly', orderQ.payload?.intent === 'order_status', orderQ.payload?.intent);
  check(
    'and quotes the real order number',
    (orderQ.payload?.message ?? '').includes(order.order_number),
    orderQ.payload?.message?.slice(0, 80),
  );

  // ============================================================ webhooks
  section('Webhooks');

  const evtId = `test_evt_${randomUUID()}`;
  const hookBody = JSON.stringify({
    id: evtId,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: okPaymentId,
          order_id: payment.provider_order_id,
          amount: expectedTotalMinor,
          status: 'captured',
        },
      },
    },
  });

  const forgedHook = await fetch(`${BASE}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
    body: hookBody,
  });
  check('an unsigned webhook is refused', forgedHook.status === 403, String(forgedHook.status));

  const hookHeaders = {
    'Content-Type': 'application/json',
    'x-razorpay-signature': signBody(hookBody),
    'x-razorpay-event-id': evtId,
  };
  const hook1 = await fetch(`${BASE}/api/payments/webhook`, {
    method: 'POST',
    headers: hookHeaders,
    body: hookBody,
  });
  check('a signed webhook is accepted', hook1.status === 200, String(hook1.status));

  const hook2 = await fetch(`${BASE}/api/payments/webhook`, {
    method: 'POST',
    headers: hookHeaders,
    body: hookBody,
  });
  const hook2Body = await hook2.json();
  check('a duplicate webhook is detected', hook2Body?.duplicate === true, JSON.stringify(hook2Body));

  const { count: ordersAfterHooks } = await admin
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.userId);
  check('duplicate webhooks created no second order', ordersAfterHooks === 1, String(ordersAfterHooks));

  const { data: invAfterHooks } = await admin
    .from('inventory')
    .select('reserved_quantity')
    .eq('product_id', product.id)
    .single();
  check(
    'and did not reserve stock twice',
    invAfterHooks.reserved_quantity === 1,
    String(invAfterHooks.reserved_quantity),
  );

  // ======================================================== price change
  section('A price change blocks payment');

  await shopper.http('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, quantity: 1 }),
  });
  const priceConfirmation = await freshConfirmation();
  check('a fresh confirmation exists', Boolean(priceConfirmation?.id));

  // compare_at_price has a CHECK constraint against price, so clear it first —
  // otherwise the UPDATE is silently rejected and the test proves nothing.
  await admin.from('products').update({ compare_at_price: null }).eq('id', product.id);
  const { error: priceError } = await admin
    .from('products')
    .update({ price: state.originalPrice + 3000 })
    .eq('id', product.id);
  check('the test could actually change the price', !priceError, priceError?.message);

  const afterPriceChange = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  check('payment is blocked', afterPriceChange.status === 409, String(afterPriceChange.status));
  check(
    'and reported as a price change',
    afterPriceChange.payload?.error?.details?.reason === 'PRICE_CHANGED',
    JSON.stringify(afterPriceChange.payload?.error?.details?.reason),
  );
  check(
    'quoting the old and the new total',
    afterPriceChange.payload?.error?.details?.old_total_minor !==
      afterPriceChange.payload?.error?.details?.new_total_minor,
    JSON.stringify(afterPriceChange.payload?.error?.details),
  );

  const { data: invalidated } = await admin
    .from('purchase_confirmations')
    .select('status')
    .eq('id', priceConfirmation.id)
    .single();
  check('the stale confirmation is invalidated', invalidated.status === 'invalidated', invalidated.status);

  const { count: paymentsAfterPrice } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.userId);
  check('no provider order was created for the stale total', paymentsAfterPrice === 1, String(paymentsAfterPrice));

  await admin.from('products').update({ price: state.originalPrice }).eq('id', product.id);

  // ========================================================= cart change
  section('A cart change blocks payment');

  const cartConfirmation = await freshConfirmation();
  check('a fresh confirmation exists', Boolean(cartConfirmation?.id));
  await shopper.http('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, quantity: 1 }),
  });

  const afterCartChange = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  check('payment is blocked', afterCartChange.status === 409, String(afterCartChange.status));
  check(
    'and reported as a cart change',
    afterCartChange.payload?.error?.details?.reason === 'CART_CHANGED',
    JSON.stringify(afterCartChange.payload?.error?.details?.reason),
  );

  // ============================================================= expiry
  section('An expired confirmation cannot pay');

  const expiring = await freshConfirmation();
  await admin
    .from('purchase_confirmations')
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('id', expiring.id);

  const afterExpiry = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  check('an expired confirmation is refused', afterExpiry.status === 409, String(afterExpiry.status));
  check(
    'and says so',
    afterExpiry.payload?.error?.details?.reason === 'CONFIRMATION_EXPIRED',
    JSON.stringify(afterExpiry.payload?.error?.details?.reason),
  );
  const { data: expiredRow } = await admin
    .from('purchase_confirmations')
    .select('status')
    .eq('id', expiring.id)
    .single();
  check('the row is marked expired', expiredRow.status === 'expired', expiredRow.status);

  // ======================================================= out of stock
  section('Out of stock blocks payment');

  await admin
    .from('inventory')
    .update({ quantity: 1, reserved_quantity: 1 })
    .eq('product_id', product.id);

  const oosRequest = await shopper.http('/api/checkout/confirm', {
    method: 'POST',
    body: JSON.stringify({ action: 'request' }),
  });
  check(
    'no confirmation is offered for an unbuyable cart',
    oosRequest.payload?.confirmation === null,
    JSON.stringify(oosRequest.payload?.confirmation)?.slice(0, 70),
  );

  const oosPayment = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  check('payment is blocked', oosPayment.status === 409, String(oosPayment.status));
  check(
    'for a stock or confirmation reason',
    ['OUT_OF_STOCK', 'INSUFFICIENT_STOCK', 'NO_CONFIRMATION'].includes(
      oosPayment.payload?.error?.details?.reason,
    ),
    JSON.stringify(oosPayment.payload?.error?.details?.reason),
  );

  const { count: paymentsAfterOos } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.userId);
  check('no Razorpay order was created', paymentsAfterOos === 1, String(paymentsAfterOos));

  await admin
    .from('inventory')
    .update({ quantity: 50, reserved_quantity: 1 })
    .eq('product_id', product.id);

  // ====================================================== failed payment
  section('A failed payment leaves everything safe');

  const failConfirmation = await freshConfirmation();
  check('a fresh confirmation exists', Boolean(failConfirmation?.id));

  const failCreate = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  const failOrderId = failCreate.payload?.payment?.provider_order_id;
  check('a provider order was created', Boolean(failOrderId));

  const failPaymentId = `pay_fail_${failOrderId}`;
  const failResult = await shopper.http('/api/payments/verify', {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: failOrderId,
      razorpay_payment_id: failPaymentId,
      razorpay_signature: sign(failOrderId, failPaymentId),
    }),
  });
  check('a failed payment is not a success', failResult.status === 409, String(failResult.status));
  check(
    'the customer is told the cart is safe',
    /cart is still safe/i.test(failResult.payload?.error?.message ?? ''),
    failResult.payload?.error?.message?.slice(0, 70),
  );

  const { data: failedRow } = await admin
    .from('payments')
    .select('status, order_id')
    .eq('id', failCreate.payload.payment.payment_id)
    .single();
  check('the payment is marked failed', failedRow.status === 'failed', failedRow.status);
  check('no order was created', failedRow.order_id === null);

  const { data: cartStillThere } = await admin
    .from('carts')
    .select('id')
    .eq('customer_id', state.userId)
    .eq('status', 'active')
    .maybeSingle();
  check('the cart was NOT cleared', Boolean(cartStillThere?.id));

  const { count: ordersAfterFailure } = await admin
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.userId);
  check('still exactly one order overall', ordersAfterFailure === 1, String(ordersAfterFailure));

  // A failed payment is terminal — a later "success" callback must not revive it.
  const revive = await shopper.http('/api/payments/verify', {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: failOrderId,
      razorpay_payment_id: `pay_ok_${failOrderId}`,
      razorpay_signature: sign(failOrderId, `pay_ok_${failOrderId}`),
    }),
  });
  const { data: stillFailed } = await admin
    .from('payments')
    .select('status, order_id')
    .eq('id', failCreate.payload.payment.payment_id)
    .single();
  check(
    'a failed payment cannot be revived into an order',
    stillFailed.order_id === null,
    `${revive.status} / ${stillFailed.status}`,
  );

  // ==================================================== cross-customer
  section('Another customer cannot use this confirmation');

  const intruderEmail = `intruder-${Date.now()}@shopiq.test`;
  const intruderPassword = `Pw!${randomUUID().slice(0, 12)}`;
  const { data: intruder } = await admin.auth.admin.createUser({
    email: intruderEmail,
    password: intruderPassword,
    email_confirm: true,
  });
  state.intruderId = intruder.user.id;
  await admin
    .from('customers')
    .upsert({ id: state.intruderId, email: intruderEmail, full_name: 'Intruder' });

  const thief = session();
  await thief.signIn(intruderEmail, intruderPassword);

  const steal = await thief.http('/api/payments/create', {
    method: 'POST',
    body: JSON.stringify({ confirmationId: failConfirmation.id }),
  });
  check(
    "another customer's confirmation cannot authorize a payment",
    steal.status === 409,
    `${steal.status} ${JSON.stringify(steal.payload?.error?.details?.reason)}`,
  );

  const { count: intruderPayments } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.intruderId);
  check('and creates nothing on their account', intruderPayments === 0, String(intruderPayments));

  // ========================================================= audit trail
  section('Audit trail');

  const { data: events } = await admin
    .from('payment_events')
    .select('event, detail')
    .eq('customer_id', state.userId);
  const seen = new Set((events ?? []).map((row) => row.event));

  for (const expected of [
    'checkout_prepared',
    'confirmation_requested',
    'confirmation_granted',
    'provider_order_created',
    'payment_verified',
    'order_created',
    'inventory_finalized',
    'cart_cleared',
    'confirmation_expired',
    'confirmation_invalidated',
    'payment_failed',
  ]) {
    check(`"${expected}" is recorded`, seen.has(expected), [...seen].join(',').slice(0, 90));
  }

  const serialized = JSON.stringify(events);
  check(
    'no provider secret is in the audit trail',
    !/shopiq_mock_secret|key_secret|RAZORPAY_/i.test(serialized),
  );
  check(
    'no signature is in the audit trail',
    !/"signature"/i.test(serialized),
  );

  console.log(`\n${'='.repeat(56)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  · ${f}`);
  }
} finally {
  console.log('\nCleaning up…');
  await cleanup();
}

process.exit(failed > 0 ? 1 : 0);
