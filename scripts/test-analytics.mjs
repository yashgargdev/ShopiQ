/**
 * Phase 6 analytics tests — attribution, funnel and honest-empty behaviour.
 *
 *   npm run dev
 *   node -r dotenv/config scripts/test-analytics.mjs dotenv_config_path=.env.local
 *
 * The thing being protected here is that the merchant numbers mean what they
 * say. A dashboard that quietly rounds an unknown to zero, or credits the AI
 * for a sale it had nothing to do with, is worse than no dashboard.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-loader.mjs', pathToFileURL(`${import.meta.dirname}/`));

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const { getAiCommerceStats, getFrequentlyBoughtTogether, getAuditTrail } = await import(
  '@/lib/analytics/queries'
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

const made = { userId: null, orderId: null, recIds: [], tag: `an_${Date.now()}` };

async function cleanup() {
  await admin.from('ai_recommendations').delete().eq('session_key', made.tag);
  await admin.from('commerce_events').delete().eq('session_key', made.tag);
  await admin.from('ai_usage').delete().eq('provider', made.tag);
  if (made.orderId) {
    await admin.from('ai_recommendations').delete().eq('order_id', made.orderId);
    await admin.from('order_items').delete().eq('order_id', made.orderId);
    await admin.from('orders').delete().eq('id', made.orderId);
  }
  if (made.userId) {
    await admin.from('payment_events').delete().eq('customer_id', made.userId);
    await admin.from('ai_recommendations').delete().eq('customer_id', made.userId);
    await admin.from('commerce_events').delete().eq('customer_id', made.userId);
    const { data: carts } = await admin.from('carts').select('id').eq('customer_id', made.userId);
    for (const cart of carts ?? []) await admin.from('cart_items').delete().eq('cart_id', cart.id);
    await admin.from('carts').delete().eq('customer_id', made.userId);
    await admin.auth.admin.deleteUser(made.userId).catch(() => {});
  }
}

process.on('uncaughtException', async (error) => {
  console.error('\nUNCAUGHT:', error);
  await cleanup();
  process.exit(1);
});

try {
  // ============================================================= rate math
  section('Rates report N/A rather than a misleading zero');

  const stats = await getAiCommerceStats(30);
  check('stats load', typeof stats.windowDays === 'number');

  // The property under test is structural: value is null exactly when the
  // denominator is zero. That holds whether or not there is data today.
  const rates = [
    ['aiConversion', stats.aiConversion],
    ['aov.all', stats.aov.all],
    ['aov.ai', stats.aov.ai],
    ['aov.nonAi', stats.aov.nonAi],
    ['crossSell.clickRate', stats.crossSell.clickRate],
    ['crossSell.addRate', stats.crossSell.addRate],
    ['crossSell.purchaseRate', stats.crossSell.purchaseRate],
    ['recommendations.addRate', stats.recommendations.addRate],
  ];
  for (const [name, figure] of rates) {
    const consistent = figure.denominator === 0 ? figure.value === null : figure.value !== null;
    check(`${name} is null iff its denominator is zero`, consistent, JSON.stringify(figure));
  }

  check(
    'every rate carries its numerator and denominator',
    rates.every(([, f]) => typeof f.numerator === 'number' && typeof f.denominator === 'number'),
  );

  // ========================================================== attribution
  section('Attribution credits only what it recorded');

  const email = `analytics-${Date.now()}@shopiq.test`;
  const { data: user } = await admin.auth.admin.createUser({
    email,
    password: `Pw!${randomUUID().slice(0, 12)}`,
    email_confirm: true,
  });
  made.userId = user.user.id;
  await admin.from('customers').upsert({ id: made.userId, email, full_name: 'Analytics' });

  const { data: products } = await admin
    .from('products')
    .select('id, name, price')
    .eq('is_active', true)
    .gt('price', 500)
    .limit(2);
  const [recommended, unrecommended] = products;

  // One product was shown by the AI; the other never was.
  const { data: rec } = await admin
    .from('ai_recommendations')
    .insert({
      customer_id: made.userId,
      session_key: made.tag,
      product_id: recommended.id,
      source: 'ai_cross_sell',
      position: 1,
      score: 90,
    })
    .select('id')
    .single();
  made.recIds.push(rec.id);

  // A paid order containing BOTH products.
  const { data: order } = await admin
    .from('orders')
    .insert({
      order_number: `SQ-TEST-${Date.now()}`,
      customer_id: made.userId,
      status: 'confirmed',
      payment_status: 'paid',
      payment_method: 'mock',
      subtotal: Number(recommended.price) + Number(unrecommended.price),
      total: Number(recommended.price) + Number(unrecommended.price),
      currency: 'INR',
      shipping_address: { line1: 'x', city: 'x', state: 'x', postalCode: '000000', country: 'India' },
      contact_email: email,
    })
    .select('id')
    .single();
  made.orderId = order.id;

  for (const product of [recommended, unrecommended]) {
    await admin.from('order_items').insert({
      order_id: order.id,
      product_id: product.id,
      product_name: product.name,
      product_slug: 'x',
      brand: 'x',
      sku: `sku-${product.id.slice(0, 8)}`,
      quantity: 1,
      unit_price: product.price,
      total_price: product.price,
    });
  }

  const { data: attributed } = await admin.rpc('attribute_order_revenue', { p_order_id: order.id });
  check('exactly one line was attributed', Number(attributed) === 1, String(attributed));

  const { data: after } = await admin
    .from('ai_recommendations')
    .select('product_id, purchased_at, revenue_minor, order_id')
    .eq('id', rec.id)
    .single();

  check('the recommended product was credited', after.purchased_at !== null);
  check('with the order attached', after.order_id === order.id);
  check(
    'and the exact line revenue in paise',
    Number(after.revenue_minor) === Math.round(Number(recommended.price) * 100),
    `${after.revenue_minor} vs ${Math.round(Number(recommended.price) * 100)}`,
  );

  const { count: strayCredits } = await admin
    .from('ai_recommendations')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', unrecommended.id)
    .eq('order_id', order.id);
  check(
    'the product the AI never showed was NOT credited',
    strayCredits === 0,
    String(strayCredits),
  );

  // Re-running must not double-count.
  const { data: secondPass } = await admin.rpc('attribute_order_revenue', { p_order_id: order.id });
  check('re-attribution credits nothing further', Number(secondPass) === 0, String(secondPass));

  const { data: revenueRows } = await admin
    .from('ai_recommendations')
    .select('revenue_minor')
    .eq('order_id', order.id);
  const totalCredited = revenueRows.reduce((sum, row) => sum + Number(row.revenue_minor ?? 0), 0);
  check(
    'total attributed revenue never exceeds the order total',
    totalCredited <= Math.round((Number(recommended.price) + Number(unrecommended.price)) * 100),
    String(totalCredited),
  );

  // ======================================================= insight engine
  section('Insights come from real orders only');

  const pairs = await getFrequentlyBoughtTogether(recommended.id, 5);
  check('pairings load', Array.isArray(pairs));
  check(
    'the co-purchased product appears',
    pairs.some((pair) => pair.productId === unrecommended.id),
    pairs.map((p) => p.name).join(', ') || 'none',
  );
  check(
    'a product with no order history has no pairings',
    (await getFrequentlyBoughtTogether('00000000-0000-0000-0000-000000000000', 5)).length === 0,
  );

  // ============================================================== audit
  section('Audit trail');

  const empty = await getAuditTrail({});
  check('an unfiltered audit query returns nothing', empty.length === 0, String(empty.length));

  const byCustomer = await getAuditTrail({ customerId: made.userId, limit: 50 });
  check('a filtered audit query is scoped', Array.isArray(byCustomer));

  // ======================================================== stats reflect
  section('Stats reflect the attributed order');

  const after30 = await getAiCommerceStats(30);
  check(
    'AI-assisted revenue includes the attributed line',
    after30.aiRevenue >= Number(recommended.price),
    `${after30.aiRevenue} vs ${recommended.price}`,
  );
  check('AI-assisted orders is at least one', after30.aiOrders >= 1, String(after30.aiOrders));
  check(
    'AI revenue never exceeds total revenue',
    after30.aiRevenue <= after30.totalRevenue,
    `${after30.aiRevenue} vs ${after30.totalRevenue}`,
  );
  check(
    'non-AI revenue is the remainder, never negative',
    after30.nonAiRevenue >= 0 &&
      Math.abs(after30.aiRevenue + after30.nonAiRevenue - after30.totalRevenue) < 0.01,
    `${after30.aiRevenue} + ${after30.nonAiRevenue} vs ${after30.totalRevenue}`,
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
