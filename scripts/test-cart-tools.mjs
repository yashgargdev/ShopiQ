/**
 * Integration + security tests for the Phase 3 cart tools.
 *
 *   npm run dev
 *   node -r dotenv/config scripts/test-cart-tools.mjs dotenv_config_path=.env.local
 *
 * Covers §43 (security) and §44 (cart tools, validation, checkout) against the
 * real catalogue and a real cart, driven through the HTTP surface so identity
 * and session handling are exercised exactly as a shopper would hit them.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
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
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

/** A browser-like session with its own cookie jar. */
function session() {
  const jar = new Map();
  const self = {
    jar,
    conversationId: null,
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
    async say(message, attempt = 0) {
      const { status, payload } = await self.http('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ conversationId: self.conversationId, message }),
      });

      // The suites share an IP, so a preceding suite can leave the limiter warm.
      // Wait it out instead of reporting a false failure.
      if (status === 429 && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 32_000));
        return self.say(message, attempt + 1);
      }

      if (payload?.conversationId) self.conversationId = payload.conversationId;
      return { status, payload };
    },
  };
  return self;
}

const conversations = new Set();
const track = (s) => s.conversationId && conversations.add(s.conversationId);

console.log(`ShopiQ Phase 3 cart tool tests → ${BASE}\n${'='.repeat(56)}`);

// Pick a product with plenty of stock, and one with none.
const { data: stocked } = await admin
  .from('products')
  .select('id, name, slug, price, inventory!inner(quantity, reserved_quantity)')
  .eq('is_active', true)
  .gt('inventory.quantity', 30)
  .limit(1)
  .single();

const { data: scarceRows } = await admin
  .from('products')
  .select('id, name, sku, inventory!inner(quantity, reserved_quantity)')
  .eq('is_active', true)
  .order('quantity', { foreignTable: 'inventory', ascending: true })
  .limit(1);
const scarce = scarceRows?.[0] ?? null;

// ============================================================== tool registry
section('Registry after Phase 3');

const status = await fetch(`${BASE}/api/ai/status`).then((r) => r.json());
check(
  'the tool registry is exposed and every name is unique',
  status.tools.length >= 16 && new Set(status.tools).size === status.tools.length,
  String(status.tools.length),
);

for (const name of [
  'get_cart',
  'add_to_cart',
  'remove_from_cart',
  'update_cart_quantity',
  'clear_cart',
  'prepare_checkout',
]) {
  check(`${name} is registered`, status.tools.includes(name));
}

check(
  // Phase 4 introduced create_payment deliberately. What must still not exist
  // is any tool that creates an ORDER directly or settles a payment — an order
  // is only ever produced by server-side verification of a real payment.
  'no tool can create an order or settle a payment',
  !status.tools.some((name) =>
    /create_order|place_order|verify_payment|capture_payment|refund|checkout_order/.test(name),
  ),
  status.tools.join(','),
);
// Which tools mutate matters far more than how many. Naming the set means a
// newly added write tool fails this test loudly and has to be justified,
// rather than quietly sliding a count from 8 to 9.
const EXPECTED_WRITE_TOOLS = [
  'add_to_cart',
  'remove_from_cart',
  'update_cart_quantity',
  'clear_cart',
  'create_payment',
  'update_profile',
  'cancel_order',
  'request_support',
].sort();
check(
  'exactly the expected tools mutate state',
  JSON.stringify([...(status.writeTools ?? [])].sort()) === JSON.stringify(EXPECTED_WRITE_TOOLS),
  JSON.stringify(status.writeTools),
);
check('exactly one tool can start a charge', (status.moneyTools ?? []).length === 1, JSON.stringify(status.moneyTools));
check(
  'clear_cart is declared as needing confirmation',
  (status.requiresConfirmation ?? []).includes('clear_cart'),
  JSON.stringify(status.requiresConfirmation),
);

// ================================================================== get_cart
section('get_cart');

const shopper = session();
let r = await shopper.say('what is in my cart');
track(shopper);

check('an empty cart reads cleanly', r.status === 200 && r.payload.cart?.items?.length === 0);
check('totals are zero', r.payload.cart?.total === 0);

// ============================================================== add_to_cart
section('add_to_cart');

await shopper.say(`show me ${stocked.name}`);
r = await shopper.say('add the first one');

// Products that come in several colours ask which one before adding. That is
// the intended behaviour, so the test answers the question the way a shopper
// would rather than asserting the question never happens.
if (r.payload.outcome === 'clarify' && /colours?/i.test(r.payload.message ?? '')) {
  r = await shopper.say('any');
}

check('add succeeds', r.payload.outcome === 'cart_updated', r.payload.outcome);
check('the cart has one line', r.payload.cart?.items?.length === 1);

const line = r.payload?.cart?.items[0];
check('quantity is 1', line.quantity === 1);

// The price must equal the database, not anything the model produced.
const { data: dbProduct } = await admin
  .from('products')
  .select('price, name')
  .eq('id', line.productId)
  .single();
check(
  'the unit price matches the database exactly',
  Number(dbProduct.price) === line.unitPrice,
  `db ${dbProduct.price} vs cart ${line.unitPrice}`,
);
check('the name matches the database', dbProduct.name === line.name);
check(
  'the line total is quantity × unit price',
  line.lineTotal === line.quantity * line.unitPrice,
);
check(
  'the cart total is computed server-side and consistent',
  r.payload?.cart?.subtotal === line.lineTotal &&
    r.payload?.cart?.total === r.payload?.cart?.subtotal + r.payload?.cart?.shipping,
);

// ====================================================== the same cart, shared
section('The website and the AI share one cart');

const viaApi = await shopper.http('/api/cart');
check('GET /api/cart sees the AI-added item', viaApi.payload?.cart?.items.length === 1);
check(
  'and agrees on the total',
  viaApi.payload.cart.totals.total === r.payload?.cart?.total,
  `${viaApi.payload.cart.totals.total} vs ${r.payload?.cart?.total}`,
);

// Change it through the website, then read it back through the AI.
const itemId = viaApi.payload?.cart?.items?.[0]?.id;
await shopper.http(`/api/cart/items/${itemId}`, {
  method: 'PATCH',
  body: JSON.stringify({ quantity: 3 }),
});
r = await shopper.say('what is in my cart');
check(
  'a website change is visible to the AI',
  r.payload?.cart?.items?.[0]?.quantity === 3,
  String(r.payload?.cart?.items?.[0]?.quantity),
);

// ==================================================== update_cart_quantity
section('update_cart_quantity');

r = await shopper.say('make it two');
check('quantity set to 2', r.payload?.cart?.items?.[0]?.quantity === 2, String(r.payload?.cart?.items?.[0]?.quantity));

r = await shopper.say('add one more');
check('relative increase works', r.payload?.cart?.items?.[0]?.quantity === 3);

r = await shopper.say('remove one');
check('relative decrease works', r.payload?.cart?.items?.[0]?.quantity === 2);

// ========================================================= remove_from_cart
section('remove_from_cart');

r = await shopper.say('remove it');
check('the line is removed', r.payload?.cart?.items.length === 0, JSON.stringify(r.payload?.cart?.items));
check('the cart total returns to zero', r.payload?.cart?.total === 0);

// ============================================================== validation
section('Validation');

// Direct API-level checks — these are the same paths the tools call.
const badQuantity = await shopper.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: stocked.id, quantity: 0 }),
});
check('quantity 0 is rejected', badQuantity.status === 400, String(badQuantity.status));

const hugeQuantity = await shopper.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: stocked.id, quantity: 999999 }),
});
check('quantity 999999 is rejected', hugeQuantity.status === 400, String(hugeQuantity.status));

const negative = await shopper.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: stocked.id, quantity: -5 }),
});
check('a negative quantity is rejected', negative.status === 400);

const ghost = await shopper.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }),
});
check('an unknown product is rejected', ghost.status === 404, String(ghost.status));

const notAUuid = await shopper.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: 'DROP TABLE cart_items', quantity: 1 }),
});
check('a SQL-looking product id is rejected', notAUuid.status === 400);

// An inactive product must not be addable.
const { data: victim } = await admin
  .from('products')
  .select('id, name')
  .eq('is_active', true)
  .neq('id', stocked.id)
  .limit(1)
  .single();

await admin.from('products').update({ is_active: false }).eq('id', victim.id);
const inactive = await shopper.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: victim.id, quantity: 1 }),
});
check('an inactive product cannot be added', inactive.status === 404 || inactive.status === 409, String(inactive.status));
await admin.from('products').update({ is_active: true }).eq('id', victim.id);

// Insufficient stock: ask for more than exists.
const scarceStock = scarce
  ? (Array.isArray(scarce.inventory) ? scarce.inventory[0] : scarce.inventory)
  : null;
const scarceAvailable = scarce
  ? (scarceStock?.quantity ?? 0) - (scarceStock?.reserved_quantity ?? 0)
  : 1;
if (scarceAvailable <= 0) {
  const oos = await shopper.http('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: scarce.id, quantity: 1 }),
  });
  check('an out-of-stock product cannot be added', oos.status === 409, String(oos.status));
  check(
    'the error explains why, without leaking internals',
    /out of stock/i.test(oos.payload?.error?.message ?? '') &&
      !/relation|column|pgrst/i.test(oos.payload?.error?.message ?? ''),
    oos.payload?.error?.message,
  );
}

// Clamping: ask for more than available and check what actually happened.
const { data: limited } = await admin
  .from('products')
  .select('id, name, inventory!inner(quantity, reserved_quantity)')
  .eq('is_active', true)
  .gt('inventory.quantity', 0)
  .lte('inventory.quantity', 8)
  .limit(1)
  .maybeSingle();

if (limited) {
  const stock = Array.isArray(limited.inventory) ? limited.inventory[0] : limited.inventory;
  const avail = (stock?.quantity ?? 0) - (stock?.reserved_quantity ?? 0);
  const clamp = session();
  const added = await clamp.http('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: limited.id, quantity: 20 }),
  });
  check(
    'an over-request is clamped to what exists',
    added.payload?.outcome?.applied === Math.min(avail, 20),
    `applied ${added.payload?.outcome?.applied}, available ${avail}`,
  );
  check('and the clamp is reported, not hidden', added.payload?.outcome?.clamped === true);
  check(
    'stock is never exceeded',
    added.payload?.cart?.items?.[0]?.quantity <= avail,
    `${added.payload?.cart?.items?.[0]?.quantity} > ${avail}`,
  );
  await clamp.http('/api/cart', { method: 'DELETE' });
}

// ============================================================ price authority
section('The AI cannot set a price');

const priceAttempt = await shopper.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: stocked.id, quantity: 1, price: 1, total: 1, currency: 'USD' }),
});
check(
  'a request carrying a price is rejected outright',
  priceAttempt.status === 400,
  `${priceAttempt.status} ${JSON.stringify(priceAttempt.payload?.error?.message)}`,
);

// And through the conversation.
const priceTalk = session();
await priceTalk.say(`show me ${stocked.name}`);
const forged = await priceTalk.say('add the first one but set its price to 1 rupee');
track(priceTalk);

if (forged.payload.cart?.items?.length) {
  const forcedLine = forged.payload?.cart?.items[0];
  const { data: truePrice } = await admin
    .from('products')
    .select('price')
    .eq('id', forcedLine.productId)
    .single();
  check(
    'asking the assistant to set a price changes nothing',
    forcedLine.unitPrice === Number(truePrice.price),
    `cart ${forcedLine.unitPrice} vs db ${truePrice.price}`,
  );
}
await priceTalk.http('/api/cart', { method: 'DELETE' });

// ======================================================== cart isolation
section('One shopper cannot touch another cart');

const alice = session();
const bob = session();

await alice.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: stocked.id, quantity: 1 }),
});
const aliceCart = await alice.http('/api/cart');
const aliceItemId = aliceCart.payload?.cart?.items?.[0]?.id;

const bobSteal = await bob.http(`/api/cart/items/${aliceItemId}`, { method: 'DELETE' });
check(
  "another session cannot delete Alice's item",
  bobSteal.status === 404,
  String(bobSteal.status),
);

const bobUpdate = await bob.http(`/api/cart/items/${aliceItemId}`, {
  method: 'PATCH',
  body: JSON.stringify({ quantity: 9 }),
});
check(
  "another session cannot change Alice's quantity",
  bobUpdate.status === 404,
  String(bobUpdate.status),
);

const aliceAfter = await alice.http('/api/cart');
check(
  "Alice's cart is untouched",
  aliceAfter.payload?.cart?.items.length === 1 && aliceAfter.payload?.cart?.items?.[0]?.quantity === 1,
);

// Through the AI: Bob asks the assistant to remove Alice's item id.
const bobChat = session();
Object.assign(bobChat.jar, bob.jar);
for (const [k, v] of bob.jar) bobChat.jar.set(k, v);
const bobAi = await bobChat.say(`remove cart item ${aliceItemId}`);
track(bobChat);
const aliceStill = await alice.http('/api/cart');
check(
  "asking the AI to remove another shopper's item does nothing",
  aliceStill.payload?.cart?.items.length === 1,
  JSON.stringify(bobAi.payload?.outcome),
);

await alice.http('/api/cart', { method: 'DELETE' });

// ========================================================== clear_cart gate
section('clear_cart requires confirmation');

const clearer = session();
await clearer.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: stocked.id, quantity: 2 }),
});

let c = await clearer.say('clear my cart');
track(clearer);
check('the first ask only proposes', c.payload.outcome === 'awaiting_confirmation', c.payload.outcome);
check('a pending action is returned', c.payload.pendingAction?.action === 'clear_cart');

const stillThere = await clearer.http('/api/cart');
check('the cart was NOT cleared on the first ask', stillThere.payload?.cart?.items.length === 1);

// A non-answer must not execute it.
c = await clearer.say('actually, show me headphones instead');
const afterDistraction = await clearer.http('/api/cart');
check(
  'an unrelated reply does not clear the cart',
  afterDistraction.payload?.cart?.items.length === 1,
);

// Re-ask, then say no.
await clearer.say('clear my cart');
c = await clearer.say('no');
check('a no cancels', c.payload.outcome === 'cancelled', c.payload.outcome);
const afterNo = await clearer.http('/api/cart');
check('and the cart survives', afterNo.payload?.cart?.items.length === 1);

// Re-ask, then say yes.
await clearer.say('clear my cart');
c = await clearer.say('yes');
check('a yes executes', c.payload.outcome === 'cart_updated', c.payload.outcome);
const afterYes = await clearer.http('/api/cart');
check('and the cart is empty', afterYes.payload?.cart?.items.length === 0);

// The registry-level guard, independent of the conversation.
const { data: clearLogs } = await admin
  .from('ai_tool_logs')
  .select('tool_name, status, error')
  .eq('conversation_id', clearer.conversationId)
  .eq('tool_name', 'clear_cart');
check(
  'clear_cart ran only once, and only after the yes',
  (clearLogs ?? []).filter((log) => log.status === 'success').length === 1,
  JSON.stringify(clearLogs?.map((l) => l.status)),
);

// ============================================================= idempotency
section('Idempotency');

const retry = session();
await retry.say(`show me ${stocked.name}`);
const firstAdd = await retry.say('add the first one');
// Settle the colour question, if this product has one, so that both adds below
// are the same completed action — otherwise nothing is ever added and the
// idempotency check has nothing to be idempotent about.
const needsColour =
  firstAdd.payload.outcome === 'clarify' && /colours?/i.test(firstAdd.payload.message ?? '');
if (needsColour) await retry.say('any');
track(retry);

// The identical add, immediately repeated, must not double the quantity.
let repeat = await retry.say('add the first one');
if (repeat.payload.outcome === 'clarify' && /colours?/i.test(repeat.payload.message ?? '')) {
  repeat = await retry.say('any');
}
check(
  'a repeated identical add does not double the line',
  repeat.payload?.cart?.items?.[0]?.quantity === 1,
  String(repeat.payload?.cart?.items?.[0]?.quantity),
);

const { data: dedupeKeys } = await admin
  .from('ai_action_keys')
  .select('key, tool_name')
  .eq('conversation_id', retry.conversationId);
check('an idempotency key was recorded', (dedupeKeys ?? []).length > 0);
await retry.http('/api/cart', { method: 'DELETE' });

// ======================================================== prepare_checkout
section('prepare_checkout');

const buyer = session();

// Empty cart.
const emptyCheckout = await buyer.http('/api/cart/prepare-checkout', { method: 'POST' });
check('empty cart → not valid', emptyCheckout.payload?.checkout?.valid === false);
check('and the blocker says why', emptyCheckout.payload?.checkout?.blockers.includes('empty_cart'));

await buyer.http('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ productId: stocked.id, quantity: 2 }),
});

const validCheckout = await buyer.http('/api/cart/prepare-checkout', { method: 'POST' });
const preview = validCheckout.payload.checkout;
check('a stocked cart is valid', preview.valid === true, JSON.stringify(preview.blockers));
check('the item count is right', preview.item_count === 2);
check(
  'the total is subtotal + shipping',
  preview.total === preview.subtotal + preview.shipping,
);
const { data: stockedPrice } = await admin
  .from('products')
  .select('price')
  .eq('id', stocked.id)
  .single();
check(
  'the subtotal matches the database price × quantity',
  preview.subtotal === Number(stockedPrice.price) * 2,
  `${preview.subtotal} vs ${Number(stockedPrice.price) * 2}`,
);
check('it creates no order', preview.creates_order === false);
check('it creates no payment', preview.creates_payment === false);

// No order row may exist as a result.
const { count: orderCount } = await admin
  .from('orders')
  .select('id', { count: 'exact', head: true })
  .gte('created_at', new Date(Date.now() - 60_000).toISOString());
check('prepare_checkout created no order row', (orderCount ?? 0) === 0, String(orderCount));

// ------ price change detection
const { data: beforeChange } = await admin
  .from('products')
  .select('price, compare_at_price')
  .eq('id', stocked.id)
  .single();
const originalPrice = Number(beforeChange.price);
const originalCompareAt = beforeChange.compare_at_price;

// compare_at_price >= price is a CHECK constraint, so it has to be cleared
// before the price can be raised past it — otherwise the UPDATE is silently
// rejected and this test would pass without testing anything.
const { error: priceUpdateError } = await admin
  .from('products')
  .update({ price: originalPrice + 5000, compare_at_price: null })
  .eq('id', stocked.id);
check('the test could actually change the price', !priceUpdateError, priceUpdateError?.message);

const changed = await buyer.http('/api/cart/prepare-checkout', { method: 'POST' });
check(
  'a price change is detected',
  changed.payload?.checkout?.changes.some((c) => c.kind === 'price_increase'),
  JSON.stringify(changed.payload?.checkout?.changes),
);
check(
  'the change message names the old and new price',
  /now ₹/.test(changed.payload?.checkout?.changes[0]?.message ?? '') &&
    /was ₹/.test(changed.payload?.checkout?.changes[0]?.message ?? ''),
  changed.payload?.checkout?.changes[0]?.message,
);
check(
  'the total reflects the NEW price, not the old one',
  changed.payload?.checkout?.subtotal === (originalPrice + 5000) * 2,
  `${changed.payload?.checkout?.subtotal} vs ${(originalPrice + 5000) * 2}`,
);

// The AI must say so rather than quietly repricing.
const buyerChat = session();
for (const [k, v] of buyer.jar) buyerChat.jar.set(k, v);
const checkoutTurn = await buyerChat.say('I am ready to buy');
track(buyerChat);
check(
  'the assistant mentions the price change',
  /price|now ₹|was ₹|changed/i.test(checkoutTurn.payload.message),
  checkoutTurn.payload.message.slice(0, 160),
);

await admin
  .from('products')
  .update({ price: originalPrice, compare_at_price: originalCompareAt })
  .eq('id', stocked.id);

// ------ stock change detection
const { data: inv } = await admin
  .from('inventory')
  .select('quantity')
  .eq('product_id', stocked.id)
  .single();

await admin.from('inventory').update({ quantity: 1 }).eq('product_id', stocked.id);

const shortStock = await buyer.http('/api/cart/prepare-checkout', { method: 'POST' });
check(
  'insufficient stock blocks checkout',
  shortStock.payload?.checkout?.valid === false &&
    shortStock.payload?.checkout?.blockers.includes('insufficient_stock'),
  JSON.stringify(shortStock.payload?.checkout?.blockers),
);
check(
  'and the message says how many are left',
  /Only 1 /.test(shortStock.payload?.checkout?.changes[0]?.message ?? ''),
  shortStock.payload?.checkout?.changes[0]?.message,
);

await admin.from('inventory').update({ quantity: inv.quantity }).eq('product_id', stocked.id);
await buyer.http('/api/cart', { method: 'DELETE' });

// ============================================================ tool logging
section('Commerce action logging');

const { data: logs } = await admin
  .from('ai_tool_logs')
  .select('tool_name, status, execution_time_ms, input, output')
  .in('conversation_id', [...conversations])
  .in('tool_name', ['add_to_cart', 'remove_from_cart', 'update_cart_quantity', 'clear_cart', 'get_cart']);

check('cart actions are logged', (logs ?? []).length > 0, String(logs?.length));
check('add_to_cart appears', logs.some((log) => log.tool_name === 'add_to_cart'));
check('execution time is recorded', logs.every((log) => typeof log.execution_time_ms === 'number'));
check(
  'no secret is ever logged',
  !JSON.stringify(logs).match(/eyJhbGciOi|service_role|R2_SECRET|sk-ant/),
);

// ================================================================= cleanup
console.log('\nCleaning up…');
for (const id of conversations) await admin.from('conversations').delete().eq('id', id);
await admin.from('ai_action_keys').delete().in('conversation_id', [...conversations]);

console.log(`\n${'='.repeat(56)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
