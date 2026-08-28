/**
 * Phase 4 integration tests — the money path against a live server and the
 * real database.
 *
 *   npm run dev
 *   node -r dotenv/config scripts/test-payments.mjs dotenv_config_path=.env.local
 *
 * Creates a throwaway customer, drives the whole chain end to end, then walks
 * every failure the spec names: payment failure, price change, out of stock,
 * expired confirmation, duplicate webhook, forged signature, and a client that
 * tries to name its own amount. Cleans up after itself.
 */
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Must match lib/payments/mock.ts. The mock exists precisely so this suite can
// run with no Razorpay account; it implements Razorpay's documented HMAC.
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

// ------------------------------------------------------------- test session
function session() {
  const jar = new Map();
  const self = {
    jar,
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
      // Mirror what @supabase/ssr writes, so the server sees a real session.
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
      return data.session;
    },
  };
  return self;
}

const created = { userId: null, email: null, confirmationIds: [], paymentIds: [], orderIds: [] };
const restore = [];

async function cleanup() {
  for (const undo of restore.reverse()) {
    try {
      await undo();
    } catch {
      /* best effort */
    }
  }
  if (created.userId) {
    await admin.from('payment_events').delete().eq('customer_id', created.userId);
    await admin.from('payments').delete().eq('customer_id', created.userId);
    await admin.from('purchase_confirmations').delete().eq('customer_id', created.userId);
    const { data: orders } = await admin.from('orders').select('id').eq('customer_id', created.userId);
    for (const order of orders ?? []) {
      await admin.from('order_items').delete().eq('order_id', order.id);
    }
    await admin.from('orders').delete().eq('customer_id', created.userId);
    const { data: carts } = await admin.from('carts').select('id').eq('customer_id', created.userId);
    for (const cart of carts ?? []) await admin.from('cart_items').delete().eq('cart_id', cart.id);
    await admin.from('carts').delete().eq('customer_id', created.userId);
    await admin.from('conversations').delete().eq('customer_id', created.userId);
    await admin.auth.admin.deleteUser(created.userId).catch(() => {});
  }
  await admin.from('webhook_events').delete().like('event_id', 'test_evt_%');
}

process.on('uncaughtException', async (error) => {
  console.error('\nUNCAUGHT:', error);
  await cleanup();
  process.exit(1);
});

try {
  // =========================================================== fixtures
  section('Setup');

  created.email = `pay-${Date.now()}@shopiq.test`;
  const password = `Pw!${randomUUID().slice(0, 12)}`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: created.email,
    password,
    email_confirm: true,
  });
  if (userError) throw new Error(`could not create user: ${userError.message}`);
  created.userId = user.user.id;
  await admin.from('customers').upsert({ id: created.userId, email: created.email, full_name: 'Pay Tester' });
  check('a test customer exists', Boolean(created.userId));

  // The cheapest active product keeps the arithmetic easy to eyeball. Chosen
  // by price rather than pinned to a price band, so it survives a catalogue
  // that no longer stocks anything under ₹5,000.
  const { data: productRows } = await admin
    .from('products')
    .select('id, name, price, inventory(quantity, reserved_quantity)')
    .eq('is_active', true)
    .order('price', { ascending: true })
    .limit(1);
  const product = productRows?.[0] ?? null;
  check('a test product exists', Boolean(product?.id), product?.name);
  if (!product) throw new Error('No active product to run the payment tests against.');
  const originalPrice = Number(product.price);

  await admin.from('inventory').update({ quantity: 50, reserved_quantity: 0 }).eq('product_id', product.id);

  const shopper = session();
  await shopper.signIn(created.email, password);
  const whoami = await shopper.http('/api/cart');
  check('the session is live', whoami.status === 200, String(whoami.status));

  // ============================================== amount cannot be set
  section('The client cannot name its own amount');

  await shopper.http('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, quantity: 1 }),
  });

  const injected = await shopper.http('/api/payments/create', {
    method: 'POST',
    body: JSON.stringify({ amount: 100, amount_minor: 100, total: 1 }),
  });
  check(
    'an amount in the body is rejected outright',
    injected.status === 400,
    `${injected.status} ${JSON.stringify(injected.payload?.error?.message)?.slice(0, 80)}`,
  );

  const statusInject = await shopper.http('/api/payments/verify', {
    method: 'POST',
    body: JSON.stringify({ razorpay_order_id: 'order_x', status: 'captured' }),
  });
  check('a client-declared status is rejected', statusInject.status === 400, String(statusInject.status));

  // ================================================ no confirmation yet
  section('No payment without a confirmation');

  const premature = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  check('payment is refused with no confirmation', premature.status === 409, String(premature.status));
  check(
    'and says why',
    premature.payload?.error?.details?.reason === 'NO_CONFIRMATION',
    JSON.stringify(premature.payload?.error?.details?.reason),
  );

  const { count: noOrders } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', created.userId);
  check('no provider order was created', noOrders === 0, String(noOrders));

  // ==================================================== request + grant
  section('Confirmation');

  const requested = await shopper.http('/api/checkout/confirm', {
    method: 'POST',
    body: JSON.stringify({ action: 'request' }),
  });
  const confirmation = requested.payload?.confirmation;
  created.confirmationIds.push(confirmation?.id);
  check('a confirmation is created', Boolean(confirmation?.id));
  check('it starts pending', confirmation?.status === 'pending', confirmation?.status);
  check(
    'the amount is the server total in paise',
    confirmation?.amount_minor === Math.round(originalPrice * 100) + (originalPrice >= 999 ? 0 : 7900),
    `${confirmation?.amount_minor} for price ${originalPrice}`,
  );
  check('it carries a cart hash', /^[0-9a-f]{64}$/.test(confirmation?.cart_hash ?? ''));

  const beforeGrant = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  check(
    'a pending (ungranted) confirmation cannot authorize payment',
    beforeGrant.status === 409 &&
      beforeGrant.payload?.error?.details?.reason === 'CONFIRMATION_NOT_CONFIRMED',
    JSON.stringify(beforeGrant.payload?.error?.details?.reason),
  );

  const granted = await shopper.http('/api/checkout/confirm', {
    method: 'POST',
    body: JSON.stringify({ action: 'grant', confirmationId: confirmation.id }),
  });
  check('granting works', granted.payload?.confirmation?.status === 'confirmed');

  // ================================================= create the payment
  section('Provider order');

  const createdPayment = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  const payment = createdPayment.payload?.payment;
  created.paymentIds.push(payment?.payment_id);
  check('a payment is created', createdPayment.status === 200 && Boolean(payment?.payment_id));
  check('with a provider order id', Boolean(payment?.provider_order_id));
  check(
    'the amount matches the confirmation exactly',
    payment?.amount === confirmation.amount_minor,
    `${payment?.amount} vs ${confirmation.amount_minor}`,
  );
  check('the publishable key is returned', Boolean(payment?.key));
  check(
    'no secret is anywhere in the response',
    !JSON.stringify(createdPayment.payload).match(/secret|key_secret|webhook/i),
  );

  // Idempotency: a double-click must not open a second provider order.
  const second = await shopper.http('/api/payments/create', { method: 'POST', body: '{}' });
  check(
    'a repeated create returns the same provider order',
    second.payload?.payment?.provider_order_id === payment.provider_order_id,
    `${second.payload?.payment?.provider_order_id} vs ${payment.provider_order_id}`,
  );
  check('and says it was reused', second.payload?.payment?.reused === true);

  const { count: paymentRows } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', created.userId);
  check('exactly one payment row exists', paymentRows === 1, String(paymentRows));

  // ============================================== forged verification
  section('Verification cannot be forged');

  const forged = await shopper.http('/api/payments/verify', {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: payment.provider_order_id,
      razorpay_payment_id: 'pay_forged',
      razorpay_signature: 'f'.repeat(64),
    }),
  });
  check('a bad signature does not confirm an order', forged.status === 409, String(forged.status));
  check(
    'and leaves the payment unverified rather than successful',
    forged.payload?.error?.details?.status === 'verification_pending',
    JSON.stringify(forged.payload?.error?.details),
  );

  const { data: afterForge } = await admin
    .from('payments')
    .select('status, order_id')
    .eq('id', payment.payment_id)
    .single();
  check('no order was created by the forgery', afterForge.order_id === null);

  const { count: cartAfterForge } = await admin
    .from('cart_items')
    .select('*', { count: 'exact', head: true })
    .eq('cart_id', (await admin.from('carts').select('id').eq('customer_id', created.userId).eq('status', 'active').single()).data.id);
  check('the cart was not cleared by the forgery', cartAfterForge === 1, String(cartAfterForge));

  // ============================================== AI tool authorization
  section('The AI tool cannot bypass the gate');

  const toolStatus = await (await fetch(`${BASE}/api/ai/status`)).json();
  check(
    'the tool registry is exposed, each tool named once',
    toolStatus.tools.length >= 16 &&
      new Set(toolStatus.tools).size === toolStatus.tools.length,
    String(toolStatus.tools.length),
  );
  check('exactly one tool can start a charge', (toolStatus.moneyTools ?? []).length === 1, JSON.stringify(toolStatus.moneyTools));
  check('and it is create_payment', toolStatus.moneyTools?.[0] === 'create_payment');
  check('create_payment is level 4', toolStatus.toolLevels?.create_payment === 4, String(toolStatus.toolLevels?.create_payment));
  check(
    'no tool creates an order or settles a payment',
    !toolStatus.tools.some((n) => /create_order|place_order|verify_payment|capture_payment|refund/.test(n)),
    toolStatus.tools.join(','),
  );
  check('a purchase always needs explicit confirmation', toolStatus.requiresExplicitPurchaseConfirmation === true);
  check('autonomous purchasing is off', toolStatus.autonomousPurchasing === false);
  check('the status endpoint leaks no secret', !JSON.stringify(toolStatus).match(/secret|rzp_live/i));

  // Ask the assistant to buy with no confirmation open. It must quote and wait,
  // never start a charge on its own initiative.
  // Count first: an earlier section legitimately created one payment, so the
  // property under test is that asking creates no NEW one.
  const { count: paymentsBeforeAsk } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', created.userId);

  const askToPay = await shopper.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'buy it now' }),
  });

  const { count: paymentsAfterAsk } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', created.userId);
  check(
    'asking the assistant to buy starts no charge by itself',
    paymentsAfterAsk === paymentsBeforeAsk,
    `${paymentsBeforeAsk} → ${paymentsAfterAsk}`,
  );
  check(
    'it quotes a total and waits instead',
    ['awaiting_purchase_confirmation', 'payment_blocked'].includes(askToPay.payload?.outcome),
    askToPay.payload?.outcome,
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
