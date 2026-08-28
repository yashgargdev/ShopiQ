/**
 * Phase 7 tests — the /Agent-purchase guest voice checkout.
 *
 *   npm run dev
 *   node -r dotenv/config scripts/test-agent.mjs dotenv_config_path=.env.local
 *
 * The property being protected: a customer can shop and pay without an account,
 * and NONE of the Phase 4 payment guarantees are softened to allow it. Guest
 * identity comes from the httpOnly cart cookie, exactly as authenticated
 * identity comes from the session — never from a request parameter.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-loader.mjs', pathToFileURL(`${import.meta.dirname}/`));

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const { missingDetails, looksLikeEmail, normalisePhone } = await import('@/lib/checkout/guest');
const { reverseGeocode } = await import('@/lib/geo/reverse');

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
  return {
    jar,
    async req(path, body, method = 'POST') {
      const cookie = Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return { status: response.status, p: await response.json().catch(() => null) };
    },
  };
}

const made = { emails: [], userIds: [], orderIds: [], cartIds: [] };

async function cleanup() {
  for (const email of made.emails) {
    const { data: customer } = await admin.from('customers').select('id').ilike('email', email).maybeSingle();
    if (customer) made.userIds.push(customer.id);
    await admin.from('email_outbox').delete().eq('to_email', email);
  }
  for (const id of [...new Set(made.userIds)]) {
    await admin.from('payment_events').delete().eq('customer_id', id);
    const { data: orders } = await admin.from('orders').select('id').eq('customer_id', id);
    for (const order of orders ?? []) {
      await admin.from('ai_recommendations').delete().eq('order_id', order.id);
      await admin.from('email_outbox').delete().eq('order_id', order.id);
      await admin.from('order_items').delete().eq('order_id', order.id);
    }
    await admin.from('payments').delete().eq('customer_id', id);
    await admin.from('orders').delete().eq('customer_id', id);
    await admin.from('purchase_confirmations').delete().eq('customer_id', id);
    await admin.from('carts').delete().eq('customer_id', id);
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  for (const cartId of made.cartIds) {
    await admin.from('guest_checkout_sessions').delete().eq('cart_id', cartId);
    await admin.from('cart_items').delete().eq('cart_id', cartId);
    await admin.from('carts').delete().eq('id', cartId);
  }
}

process.on('uncaughtException', async (error) => {
  console.error('\nUNCAUGHT:', error);
  await cleanup();
  process.exit(1);
});

try {
  // ============================================================ pure logic
  section('Detail validation');

  check('a plain address is an email', looksLikeEmail('yash@example.com'));
  check('no domain is not', !looksLikeEmail('yash@example'));
  check('no at-sign is not', !looksLikeEmail('yash.example.com'));
  check('an STT run-together is not', !looksLikeEmail('yash at example dot com'));

  check('10 digits normalise', normalisePhone('9876543210') === '+919876543210');
  check('spaced digits normalise', normalisePhone('98765 43210') === '+919876543210');
  check('a 91 prefix normalises', normalisePhone('919876543210') === '+919876543210');
  check('a leading zero normalises', normalisePhone('09876543210') === '+919876543210');
  check('too few digits are refused', normalisePhone('98765') === null);
  check('words are refused', normalisePhone('nine eight seven') === null);

  check('nothing collected means everything missing', missingDetails(null).length === 4);
  check(
    'a complete session is missing nothing',
    missingDetails({
      fullName: 'Yash Garg',
      email: 'y@x.com',
      phone: '+919876543210',
      address: { line1: '42 MG Road', city: 'Bengaluru' },
    }).length === 0,
  );
  check(
    'an address without a city is incomplete',
    missingDetails({
      fullName: 'Y',
      email: 'y@x.com',
      phone: '+91987',
      address: { line1: '42 MG Road', city: '' },
    }).includes('address'),
  );

  // ============================================================ geocoding
  section('Reverse geocoding');

  const badCoords = await reverseGeocode(999, 999);
  check('impossible coordinates are refused', !badCoords.ok && badCoords.reason === 'invalid_coordinates');

  const sea = await reverseGeocode(0, 0);
  check('open ocean yields no address', !sea.ok, sea.reason);

  // A real lookup, but a failure here is the network's fault rather than
  // ShopiQ's — so it is reported, not failed.
  const known = await reverseGeocode(12.9716, 77.5946);
  if (known.ok) {
    check('a known location resolves', Boolean(known.address?.city), known.address?.city);
    check('and never returns a partial address', Boolean(known.address?.line1 && known.address?.city));
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m  geocoder unreachable (${known.reason}) — fallback path still tested above`);
  }

  // ==================================================== guest shopping
  section('A guest shops with no account');

  const guest = session();
  // Phones, not laptops: the cheapest laptop in the catalogue is ₹1,49,999, so
  // a ₹90,000 laptop request correctly finds nothing and this flow would be
  // testing the empty-result path rather than the guest checkout it is for.
  const search = await guest.req('/api/ai/chat', {
    message: 'Mujhe 90 hazaar ke andar phone chahiye',
    inputMode: 'voice',
  });
  const conversationId = search.p?.conversationId;
  check('a guest can search', search.status === 200 && (search.p?.products?.length ?? 0) > 0);
  check('no sign-in was demanded', search.status !== 401);

  let added = await guest.req('/api/ai/chat', {
    conversationId,
    message: 'pehla wala cart mein daal do',
    inputMode: 'voice',
  });
  // A product sold in several colours asks which one before it is added. That
  // is intended, so answer it — by voice, like the rest of this flow.
  if (added.p?.outcome === 'clarify' && /colou?rs?|rang/i.test(added.p?.message ?? '')) {
    added = await guest.req('/api/ai/chat', {
      conversationId,
      message: 'koi bhi',
      inputMode: 'voice',
    });
  }
  check('a guest can add to cart by voice', added.p?.outcome === 'cart_updated', added.p?.outcome);
  check('the cart has a line', (added.p?.cart?.items?.length ?? 0) === 1);

  const { data: guestCart } = await admin
    .from('carts')
    .select('id')
    .is('customer_id', null)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (guestCart) made.cartIds.push(guestCart.id);

  // =========================================== conversational collection
  section('Details are collected conversationally');

  const before = await guest.req('/api/agent/checkout', { action: 'status', conversationId });
  check('the session is a guest one', before.p?.isGuest === true);
  check('everything is missing at first', (before.p?.missing ?? []).length === 4);

  const earlyQuote = await guest.req('/api/agent/checkout', { action: 'quote', conversationId });
  check('a total is refused before details', earlyQuote.p?.ok === false, earlyQuote.p?.reason);
  check('and says what is missing', (earlyQuote.p?.missing ?? []).length > 0);

  const badEmail = await guest.req('/api/agent/checkout', {
    action: 'collect',
    conversationId,
    email: 'not an address',
  });
  check('a misheard email is rejected', (badEmail.p?.rejected ?? []).includes('email'));
  check('and email stays missing', (badEmail.p?.missing ?? []).includes('email'));

  const email = `agent-${Date.now()}@shopiq.test`;
  made.emails.push(email);

  for (const [field, value, label] of [
    ['fullName', 'Yash Garg', 'name'],
    ['email', email, 'email'],
    ['phone', '9876543210', 'phone'],
  ]) {
    const result = await guest.req('/api/agent/checkout', { action: 'collect', conversationId, [field]: value });
    check(`${label} is accepted`, !(result.p?.missing ?? []).includes(label), JSON.stringify(result.p?.missing));
  }

  const withAddress = await guest.req('/api/agent/checkout', {
    action: 'collect',
    conversationId,
    address: { line1: '42 MG Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: 'India' },
  });
  check('the address completes the set', (withAddress.p?.missing ?? []).length === 0, JSON.stringify(withAddress.p?.missing));

  const badLocate = await guest.req('/api/agent/checkout', { action: 'locate', conversationId });
  check('locate with no coordinates fails softly', badLocate.p?.ok === false && badLocate.status === 200);
  check('and offers the manual fallback', /address/i.test(badLocate.p?.message ?? ''));

  // =================================================== authoritative total
  section('The total comes from the server');

  const quote = await guest.req('/api/agent/checkout', { action: 'quote', conversationId });
  check('a guest gets a quote', quote.p?.ok === true, quote.p?.reason);
  const confirmationId = quote.p?.confirmation?.id;
  check('with a confirmation', Boolean(confirmationId));
  check('and an exact amount in paise', Number.isInteger(quote.p?.confirmation?.amount_minor));
  check('a delivery estimate is configured, not invented', Boolean(quote.p?.deliveryEstimate));

  const { data: cartRows } = await admin
    .from('cart_items')
    .select('quantity, products(price)')
    .eq('cart_id', guestCart.id);
  const expected = Math.round(
    (cartRows ?? []).reduce((sum, row) => sum + Number(row.products.price) * row.quantity, 0) * 100,
  );
  const shipping = quote.p?.confirmation?.shipping_minor ?? 0;
  check(
    'the quoted total matches the catalogue exactly',
    quote.p?.confirmation?.amount_minor === expected + shipping,
    `${quote.p?.confirmation?.amount_minor} vs ${expected + shipping}`,
  );

  // ===================================================== payment safety
  section('Payment safety is unchanged for guests');

  const beforeConfirm = await guest.req('/api/payments/create', { confirmationId, conversationId });
  check(
    'payment before the yes is blocked',
    beforeConfirm.status !== 200,
    `${beforeConfirm.status} ${beforeConfirm.p?.error?.details?.reason}`,
  );
  check(
    'for a confirmation reason',
    ['CONFIRMATION_NOT_CONFIRMED', 'NO_CONFIRMATION'].includes(
      beforeConfirm.p?.error?.details?.reason,
    ),
    beforeConfirm.p?.error?.details?.reason,
  );

  const clientAmount = await guest.req('/api/payments/create', { confirmationId, amount: 1, total: 1 });
  check('a guest cannot set the amount', clientAmount.status === 400, String(clientAmount.status));

  const forgedQuote = await guest.req('/api/agent/checkout', {
    action: 'quote',
    conversationId,
    amount: 1,
  });
  check('the checkout endpoint takes no amount', forgedQuote.status === 400, String(forgedQuote.status));

  // A different browser must not be able to use this confirmation.
  const stranger = session();
  const steal = await stranger.req('/api/payments/create', { confirmationId });
  check("a stranger cannot use the guest's confirmation", steal.status !== 200, String(steal.status));
  const strangerConfirm = await stranger.req('/api/agent/checkout', {
    action: 'confirm',
    confirmationId,
  });
  check("a stranger cannot grant it either", strangerConfirm.p?.ok === false, JSON.stringify(strangerConfirm.p?.reason));

  const { data: stillPending } = await admin
    .from('purchase_confirmations')
    .select('status')
    .eq('id', confirmationId)
    .single();
  check('the confirmation is still pending after both attempts', stillPending.status === 'pending', stillPending.status);

  // Now the legitimate yes.
  const granted = await guest.req('/api/agent/checkout', { action: 'confirm', conversationId, confirmationId });
  check('the owner can confirm', granted.p?.ok === true);
  check('and it becomes confirmed', granted.p?.confirmation?.status === 'confirmed');

  const created = await guest.req('/api/payments/create', { confirmationId, conversationId });
  check('a guest can create a payment', created.status === 200, String(created.status));
  check('against a real provider order', Boolean(created.p?.payment?.provider_order_id));
  check(
    'with the server-computed amount',
    created.p?.payment?.amount === quote.p?.confirmation?.amount_minor,
    `${created.p?.payment?.amount} vs ${quote.p?.confirmation?.amount_minor}`,
  );
  check(
    'only the publishable key is returned',
    !/key_secret|webhook/i.test(JSON.stringify(created.p ?? {})),
  );

  // Cart changes after the yes must invalidate it. The product must be one
  // that is NOT already in the cart — adding a duplicate only bumps a
  // quantity, and removing it afterwards would empty the line instead of
  // restoring the confirmed cart.
  const { data: cartProductIds } = await admin
    .from('cart_items')
    .select('product_id')
    .eq('cart_id', guestCart.id);
  const inCart = new Set((cartProductIds ?? []).map((row) => row.product_id));

  const { data: candidates } = await admin
    .from('products')
    .select('id')
    .eq('is_active', true)
    .gt('price', 500)
    .limit(10);
  const anotherProduct = (candidates ?? []).find((row) => !inCart.has(row.id));
  check('a distinct second product exists to test with', Boolean(anotherProduct));
  await guest.req('/api/cart/items', { productId: anotherProduct.id, quantity: 1 });

  const afterChange = await guest.req('/api/payments/create', { confirmationId, conversationId });
  check(
    'a cart change after the yes blocks payment',
    afterChange.status !== 200,
    `${afterChange.status} ${afterChange.p?.error?.details?.reason}`,
  );

  // ================================================= finalization chain
  section('Finalization creates the account and the invoice');

  // A real Razorpay payment needs a human at a card form, so the verified
  // outcome is injected here and the SERVER-side consequences are asserted:
  // account creation, order, inventory, guest-session consumption, invoice.
  const { finalize } = await import('@/lib/payments/service');

  const { data: firstPayment } = await admin
    .from('payments')
    .select('id, guest_session_id, amount_minor')
    .eq('provider_order_id', created.p.payment.provider_order_id)
    .single();
  check('the payment row is owned by the guest session', Boolean(firstPayment.guest_session_id));

  // The cart change above invalidated the confirmation — correctly. The
  // customer's recovery is to be re-quoted and to say yes again, which is the
  // §50 price/cart-change path, so that is what happens here.
  const { data: invalidated } = await admin
    .from('purchase_confirmations')
    .select('status')
    .eq('id', confirmationId)
    .single();
  check('the changed cart invalidated the confirmation', invalidated.status === 'invalidated', invalidated.status);

  // Put the cart back to exactly what was confirmed. The extra product was
  // not in the cart before, so removing its line restores the original state —
  // and the RPC's own AMOUNT_MISMATCH guard will catch it if that is wrong.
  await admin
    .from('cart_items')
    .delete()
    .eq('cart_id', guestCart.id)
    .eq('product_id', anotherProduct.id);

  const { data: restored } = await admin
    .from('cart_items')
    .select('quantity, products(price)')
    .eq('cart_id', guestCart.id);
  const restoredMinor = Math.round(
    (restored ?? []).reduce((sum, row) => sum + Number(row.products.price) * row.quantity, 0) * 100,
  );
  check(
    'the cart is back to the confirmed contents',
    restoredMinor + shipping === Number(firstPayment.amount_minor),
    `${restoredMinor + shipping} vs ${firstPayment.amount_minor}`,
  );

  // Re-quote against the restored cart, confirm again, and pay against THAT.
  const requote = await guest.req('/api/agent/checkout', { action: 'quote', conversationId });
  check('the customer can be re-quoted after a change', requote.p?.ok === true, requote.p?.reason);
  check(
    'and the new total matches the restored cart',
    requote.p?.confirmation?.amount_minor === Number(firstPayment.amount_minor),
    `${requote.p?.confirmation?.amount_minor} vs ${firstPayment.amount_minor}`,
  );

  await guest.req('/api/agent/checkout', {
    action: 'confirm',
    conversationId,
    confirmationId: requote.p.confirmation.id,
  });
  const repaid = await guest.req('/api/payments/create', {
    confirmationId: requote.p.confirmation.id,
    conversationId,
  });
  check('a fresh payment can be created', repaid.status === 200, String(repaid.status));

  const { data: payment } = await admin
    .from('payments')
    .select('id, guest_session_id, amount_minor')
    .eq('provider_order_id', repaid.p.payment.provider_order_id)
    .single();

  const result = await finalize(payment.id, `pay_test_${randomUUID().slice(0, 12)}`, null, conversationId, payment.guest_session_id);

  if (!result.success) {
    // `finalize` records the underlying database error on the payment row;
    // surfacing it turns an opaque FINALIZATION_FAILED into something fixable.
    const { data: failed } = await admin
      .from('payments')
      .select('failure_reason, status')
      .eq('id', payment.id)
      .single();
    console.log(`        underlying: ${failed?.failure_reason ?? '(none recorded)'}`);
  }
  check('finalization succeeds', result.success === true, result.reason ?? result.message);
  check('an order number comes back', Boolean(result.orderNumber), result.orderNumber);
  check('with a configured delivery estimate', Boolean(result.deliveryEstimate), result.deliveryEstimate);
  if (result.orderId) made.orderIds.push(result.orderId);

  const { data: account } = await admin.from('customers').select('id, email, full_name').ilike('email', email).maybeSingle();
  check('an account was created for the guest', Boolean(account), email);
  check('with the collected name', account?.full_name === 'Yash Garg', account?.full_name);
  if (account) made.userIds.push(account.id);

  const { data: order } = await admin
    .from('orders')
    .select('id, customer_id, payment_status, total, contact_email')
    .eq('id', result.orderId)
    .single();
  check('the order belongs to the new account', order.customer_id === account?.id);
  check('and is marked paid', order.payment_status === 'paid', order.payment_status);
  check('with the collected email', order.contact_email === email, order.contact_email);
  check(
    'the charged amount matches the order total',
    Math.round(Number(order.total) * 100) === Number(payment.amount_minor),
    `${Math.round(Number(order.total) * 100)} vs ${payment.amount_minor}`,
  );

  const { data: guestSession } = await admin
    .from('guest_checkout_sessions')
    .select('status, order_id, customer_id')
    .eq('id', payment.guest_session_id)
    .single();
  check('the guest session is consumed', guestSession.status === 'consumed', guestSession.status);
  check('and linked to what it produced', guestSession.order_id === result.orderId);

  const { data: mails } = await admin
    .from('email_outbox')
    .select('kind, to_email, status, body_text')
    .eq('to_email', email);
  const kinds = new Set((mails ?? []).map((m) => m.kind));
  check('an invoice was queued', kinds.has('order_invoice'), [...kinds].join(','));
  check('an account-setup email was queued', kinds.has('account_setup'), [...kinds].join(','));
  check(
    'no email contains a password or a token',
    !(mails ?? []).some((m) => /password is|token=|secret/i.test(m.body_text)),
  );
  const invoice = (mails ?? []).find((m) => m.kind === 'order_invoice');
  check('the invoice names the order', invoice?.body_text.includes(result.orderNumber));

  // Re-finalising must not produce a second order.
  const replay = await finalize(payment.id, 'pay_replay', null, conversationId, payment.guest_session_id);
  const { count: orderCount } = await admin
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', account.id);
  check('re-finalising creates no second order', orderCount === 1, String(orderCount));
  check('and reports the same order', replay.orderNumber === result.orderNumber, replay.orderNumber);

  // ======================================== an existing account is reused
  section('An existing email is linked, not duplicated');

  const { ensureAccountForEmail } = await import('@/lib/email/service');
  const again = await ensureAccountForEmail({ email, fullName: 'Someone Else', phone: null });
  check('the existing account is reused', again.customerId === account.id);
  check('no new account is created', again.created === false);
  check('and no setup link is sent to it', again.setupEmailQueued === false);

  const { count: accountCount } = await admin
    .from('customers')
    .select('*', { count: 'exact', head: true })
    .ilike('email', email);
  check('exactly one account exists for that email', accountCount === 1, String(accountCount));

  // ============================================================== audit
  section('Audit trail');

  const { data: events } = await admin
    .from('payment_events')
    .select('event')
    .eq('order_id', result.orderId);
  const eventNames = new Set((events ?? []).map((e) => e.event));
  check('order creation is audited', eventNames.has('order_created'), [...eventNames].join(','));
  check('inventory finalization is audited', eventNames.has('inventory_finalized'));
  check('the cart clear is audited', eventNames.has('cart_cleared'));
  check(
    'the invoice outcome is audited',
    eventNames.has('invoice_sent') || eventNames.has('invoice_queued'),
    [...eventNames].join(','),
  );

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  · ${failure}`);
  }
} finally {
  console.log('\nCleaning up…');
  await cleanup();
}

process.exit(failed > 0 ? 1 : 0);
