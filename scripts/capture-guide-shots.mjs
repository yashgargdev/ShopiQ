/**
 * Screenshots for the guide, taken from the running app.
 *
 *   node -r dotenv/config scripts/capture-guide-shots.mjs dotenv_config_path=.env.local
 *
 * Real screens, not mockups: a guide that shows something the product does not
 * look like is worse than one with no pictures, because the reader trusts it
 * and then cannot find what it described. Re-run this whenever the UI moves.
 */
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const OUT = 'public/guide';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const browser = await chromium.launch();
const shot = async (page, name, locator) => {
  const target = locator ?? page;
  await target.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  captured', name);
};

async function panelOf(page) {
  return page.locator('aside[aria-label="ShopiQ AI assistant"]');
}

async function say(page, panel, text) {
  const input = panel.locator('input[aria-label="Message ShopiQ"]');
  for (let w = 0; w < 60000 && !(await input.isEnabled()); w += 250) await page.waitForTimeout(250);
  await input.fill(text);
  await input.press('Enter');
  await page.waitForResponse((r) => r.url().includes('/api/ai/chat') && r.request().method() === 'POST', { timeout: 90000 });
  await page.waitForTimeout(1600);
}

// ---------------------------------------------------------------- signed out
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot(page, 'landing');

  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, 'store');

  // The panel, mid-conversation.
  await page.locator('button[aria-label="Ask ShopiQ"]').first().click();
  await page.waitForTimeout(700);
  const panel = await panelOf(page);
  await say(page, panel, 'I need a laptop for programming and gaming under 80000');
  await shot(page, 'panel-results', panel);

  await say(page, panel, 'add the first one');
  await shot(page, 'panel-added', panel);

  await say(page, panel, 'why did you recommend that?');
  await shot(page, 'panel-why', panel);

  await page.goto(`${BASE}/cart`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, 'cart');

  await ctx.close();
}

// ------------------------------------------------------------- signed in
{
  const email = `guide-${Date.now()}@shopiq.test`;
  const password = `Pw!${randomUUID().slice(0, 12)}`;
  const { data: user, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  const userId = user.user.id;
  await admin.from('customers').upsert({ id: userId, email, full_name: 'Aarav Sharma' });
  await admin.from('customer_addresses').insert({
    customer_id: userId, label: 'Home', full_name: 'Aarav Sharma', phone: '9876543210',
    line1: '221B Residency Road', city: 'Bengaluru', state: 'Karnataka',
    postal_code: '560025', country: 'IN', is_default: true,
  });

  // A real order, made the way checkout makes one.
  const { data: cart } = await admin.from('carts').insert({ customer_id: userId, status: 'active' }).select('id').single();
  const { data: product } = await admin.from('products').select('id').eq('is_active', true).limit(1).single();
  await admin.from('cart_items').insert({ cart_id: cart.id, product_id: product.id, quantity: 1 });
  await admin.rpc('create_order_from_cart', {
    p_cart_id: cart.id, p_customer_id: userId,
    p_contact_email: email, p_contact_phone: '9876543210',
    p_shipping_address: { line1: '221B Residency Road', city: 'Bengaluru', state: 'Karnataka', postal_code: '560025', country: 'IN' },
  });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password).catch(() => {});
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2800);

  await page.goto(`${BASE}/account/orders`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, 'orders');

  // Asking the assistant about the order it can actually see.
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.locator('button[aria-label="Ask ShopiQ"]').first().click();
  await page.waitForTimeout(700);
  const panel = await panelOf(page);
  await say(page, panel, 'what did I order?');
  await shot(page, 'panel-order-status', panel);

  await ctx.close();

  // Release what the fixture reserved.
  //
  // create_order_from_cart holds stock against the order, and the order above
  // exists only to be photographed. Leaving it reserved quietly reduces the
  // available count of a real catalogue product — which is how a cart test
  // asserting "insufficient stock" started reporting "out of stock" instead.
  const { data: fixtureOrders } = await admin
    .from('orders')
    .select('id, order_items(product_id, quantity)')
    .eq('customer_id', userId);

  for (const order of fixtureOrders ?? []) {
    for (const line of order.order_items ?? []) {
      const { data: row } = await admin
        .from('inventory')
        .select('reserved_quantity')
        .eq('product_id', line.product_id)
        .single();
      if (!row) continue;
      await admin
        .from('inventory')
        .update({
          reserved_quantity: Math.max((row.reserved_quantity ?? 0) - line.quantity, 0),
        })
        .eq('product_id', line.product_id);
    }
    await admin.from('order_items').delete().eq('order_id', order.id);
    await admin.from('orders').delete().eq('id', order.id);
  }

  await admin.from('customer_addresses').delete().eq('customer_id', userId);
  await admin.from('carts').delete().eq('customer_id', userId);
  await admin.from('customers').delete().eq('id', userId);
  await admin.auth.admin.deleteUser(userId);
  console.log('  fixture order removed and its stock released');
}

// ------------------------------------------------------------------ mobile
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot(page, 'mobile-landing');
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(page, 'mobile-store');
  await ctx.close();
}

await browser.close();
console.log('\nAll guide screenshots written to', OUT);
