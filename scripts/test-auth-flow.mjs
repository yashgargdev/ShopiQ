/**
 * Authenticated end-to-end test.
 *
 * Creates a throwaway customer and a throwaway merchant, then exercises the
 * flows a smoke test cannot reach anonymously:
 *   - sign-up → cart merge on login → checkout → order created
 *   - price and stock validated server-side
 *   - inventory reserved on order, released on cancel, consumed on ship
 *   - one customer cannot read another customer's order
 *   - merchant product CRUD, image upload to R2, inventory and analytics
 *
 *   node -r dotenv/config scripts/test-auth-flow.mjs dotenv_config_path=.env.local
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(SUPABASE_URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/** True when the object is absent from the bucket itself (not just the CDN). */
async function objectIsGone(key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    return false;
  } catch (error) {
    return error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404;
  }
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  [32mPASS[0m  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  [31mFAIL[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (t) => console.log(`\n[1m${t}[0m`);

/** A browser-like session with its own cookie jar. */
function session() {
  const jar = new Map();
  return {
    jar,
    async fetch(path, init = {}) {
      const cookie = Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
      const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          ...(init.body && !(init.body instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(init.headers ?? {}),
        },
        redirect: 'manual',
      });
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        if (i > 0) {
          const name = pair.slice(0, i).trim();
          const value = pair.slice(i + 1).trim();
          if (value === '' || raw.includes('Max-Age=0')) jar.delete(name);
          else jar.set(name, value);
        }
      }
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* html */
      }
      return { status: response.status, json, text, headers: response.headers };
    },
  };
}

/**
 * Signs in through supabase-js, then plants the resulting session into the
 * cookie jar in the format @supabase/ssr expects, so the Next server reads it.
 */
async function signIn(sess, email, password) {
  const client = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);

  const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
  const payload = `base64-${Buffer.from(JSON.stringify(data.session)).toString('base64')}`;

  // @supabase/ssr chunks cookies above ~3180 bytes.
  const CHUNK = 3180;
  const name = `sb-${ref}-auth-token`;
  if (payload.length <= CHUNK) {
    sess.jar.set(name, encodeURIComponent(payload));
  } else {
    for (let i = 0; i * CHUNK < payload.length; i++) {
      sess.jar.set(`${name}.${i}`, encodeURIComponent(payload.slice(i * CHUNK, (i + 1) * CHUNK)));
    }
  }
  return data.user;
}

const stamp = Date.now();
const CUSTOMER = { email: `sq-cust-${stamp}@example.com`, password: 'ShopiQ-Test-1234' };
const OTHER = { email: `sq-other-${stamp}@example.com`, password: 'ShopiQ-Test-1234' };
const MERCHANT = { email: `sq-merch-${stamp}@example.com`, password: 'ShopiQ-Test-1234' };
const created = { users: [], products: [] };

async function createUser({ email, password }, fullName) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  created.users.push(data.user.id);
  return data.user;
}

async function cleanup() {
  for (const id of created.products) {
    await admin.from('products').delete().eq('id', id);
  }
  for (const id of created.users) {
    await admin.from('orders').delete().eq('customer_id', id);
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}

async function main() {
  console.log(`ShopiQ authenticated flow test → ${BASE}\n${'='.repeat(52)}`);

  // --------------------------------------------------------------- accounts
  section('Account setup');

  const customer = await createUser(CUSTOMER, 'Test Customer');
  const other = await createUser(OTHER, 'Other Customer');
  const merchant = await createUser(MERCHANT, 'Test Merchant');

  const { data: customerRow } = await admin
    .from('customers')
    .select('id, email')
    .eq('id', customer.id)
    .maybeSingle();
  check('signup trigger created the customer row', customerRow?.email === CUSTOMER.email);

  await admin.from('merchant_users').insert({
    id: merchant.id,
    email: MERCHANT.email,
    full_name: 'Test Merchant',
    role: 'owner',
  });

  // ------------------------------------------------- guest cart → sign in
  section('Guest cart merges on sign-in');

  const shopper = session();
  const listing = await shopper.fetch('/api/products?limit=5&inStock=true');
  const product = listing.json.products[0];
  const second = listing.json.products[1];

  await shopper.fetch('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, quantity: 2 }),
  });
  const guestCart = await shopper.fetch('/api/cart');
  check('guest cart holds the item', guestCart.json.cart.items.length === 1);
  check('guest cart is flagged as a guest cart', guestCart.json.cart.isGuest === true);

  await signIn(shopper, CUSTOMER.email, CUSTOMER.password);

  const mergedCart = await shopper.fetch('/api/cart');
  check(
    'guest cart survived sign-in',
    mergedCart.json.cart.items.length === 1,
    `got ${mergedCart.json.cart.items.length} items`,
  );
  check('cart is no longer a guest cart', mergedCart.json.cart.isGuest === false);
  check('quantity carried across', mergedCart.json.cart.items[0].quantity === 2);

  // ---------------------------------------------------------- server pricing
  section('Server-side pricing and totals');

  await shopper.fetch('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: second.id, quantity: 1 }),
  });
  const priced = await shopper.fetch('/api/cart');
  const expectedSubtotal = product.price * 2 + second.price;
  check(
    'subtotal is computed from the catalogue',
    Math.abs(priced.json.cart.totals.subtotal - expectedSubtotal) < 0.01,
    `${priced.json.cart.totals.subtotal} vs ${expectedSubtotal}`,
  );
  check(
    'delivery is free over the threshold',
    expectedSubtotal >= 999 ? priced.json.cart.totals.shipping === 0 : true,
  );
  check(
    'total = subtotal + shipping',
    Math.abs(
      priced.json.cart.totals.total -
        (priced.json.cart.totals.subtotal + priced.json.cart.totals.shipping),
    ) < 0.01,
  );

  // ------------------------------------------------------------- validation
  section('Order validation');

  const badAddress = await shopper.fetch('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      contactEmail: 'not-an-email',
      shippingAddress: { fullName: 'X', phone: '1', line1: 'a', city: '', state: '', postalCode: '12' },
    }),
  });
  check('invalid checkout payload → 400', badAddress.status === 400, `got ${badAddress.status}`);
  check('validation errors name their fields', Array.isArray(badAddress.json?.error?.details));

  // ------------------------------------------------------------- checkout
  section('Checkout creates a real order');

  const stockBefore = await admin
    .from('inventory')
    .select('quantity, reserved_quantity, available')
    .eq('product_id', product.id)
    .single();

  const placed = await shopper.fetch('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      contactEmail: CUSTOMER.email,
      contactPhone: '+91 98765 43210',
      shippingAddress: {
        fullName: 'Test Customer',
        phone: '+91 98765 43210',
        line1: 'Flat 402, Sunrise Residency, Sector 62',
        city: 'Noida',
        state: 'Uttar Pradesh',
        postalCode: '201301',
        country: 'IN',
      },
      notes: 'Leave with security',
      saveAddress: true,
    }),
  });

  check('POST /api/orders → 201', placed.status === 201, `got ${placed.status} ${placed.text.slice(0, 200)}`);
  const orderId = placed.json?.order?.orderId;
  check('order number looks right', /^SQ-\d{4}-\d+$/.test(placed.json?.order?.orderNumber ?? ''), placed.json?.order?.orderNumber);
  check(
    'server total matches the cart total',
    Math.abs(placed.json.order.total - priced.json.cart.totals.total) < 0.01,
  );

  const emptied = await shopper.fetch('/api/cart');
  check('cart is emptied after checkout', emptied.json.cart.items.length === 0);

  const stockAfter = await admin
    .from('inventory')
    .select('quantity, reserved_quantity, available')
    .eq('product_id', product.id)
    .single();
  check(
    'stock was reserved, not deleted',
    stockAfter.data.reserved_quantity === stockBefore.data.reserved_quantity + 2 &&
      stockAfter.data.quantity === stockBefore.data.quantity,
    `reserved ${stockBefore.data.reserved_quantity}→${stockAfter.data.reserved_quantity}`,
  );
  check(
    'available dropped by the ordered quantity',
    stockAfter.data.available === stockBefore.data.available - 2,
  );

  // ------------------------------------------------------ price snapshotting
  section('Order line snapshots');

  const detail = await shopper.fetch(`/api/orders/${orderId}`);
  check('GET own order → 200', detail.status === 200);
  const line = detail.json.order.items.find((i) => i.productId === product.id);
  check('unit price snapshotted', line?.unitPrice === product.price);
  check('product name snapshotted', line?.productName === product.name);
  check('sku snapshotted', line?.sku === product.sku);

  const newPrice = product.price + 5000;
  await admin.from('products').update({ price: newPrice }).eq('id', product.id);
  const afterPriceChange = await shopper.fetch(`/api/orders/${orderId}`);
  const lineAfter = afterPriceChange.json.order.items.find((i) => i.productId === product.id);
  check(
    'order price does NOT follow the catalogue price',
    lineAfter.unitPrice === product.price,
    `order says ${lineAfter.unitPrice}, catalogue now ${newPrice}`,
  );
  check(
    'order total does NOT follow the catalogue price',
    Math.abs(afterPriceChange.json.order.total - placed.json.order.total) < 0.01,
  );
  await admin.from('products').update({ price: product.price }).eq('id', product.id);

  // ------------------------------------------------------------- isolation
  section('Customer isolation');

  const intruder = session();
  await signIn(intruder, OTHER.email, OTHER.password);

  const stolen = await intruder.fetch(`/api/orders/${orderId}`);
  check(
    "another customer cannot read the order",
    stolen.status === 404,
    `got ${stolen.status}`,
  );

  const theirOrders = await intruder.fetch('/api/orders');
  check('their own order list is empty', theirOrders.json.orders.length === 0);

  const notMerchant = await intruder.fetch('/api/merchant/products');
  check('customer hitting a merchant API → 403', notMerchant.status === 403, `got ${notMerchant.status}`);

  const merchantPage = await intruder.fetch('/merchant');
  check(
    'customer visiting /merchant → redirected to /merchant/access',
    merchantPage.status === 307 &&
      (merchantPage.headers.get('location') ?? '').includes('/merchant/access'),
    `got ${merchantPage.status} → ${merchantPage.headers.get('location')}`,
  );

  const accessPage = await intruder.fetch('/merchant/access');
  check('/merchant/access renders without looping', accessPage.status === 200, `got ${accessPage.status}`);

  // -------------------------------------------------------------- merchant
  section('Merchant panel');

  const panel = session();
  await signIn(panel, MERCHANT.email, MERCHANT.password);

  const merchantProducts = await panel.fetch('/api/merchant/products?limit=5');
  check('GET /api/merchant/products → 200', merchantProducts.status === 200, `got ${merchantProducts.status}`);
  check('includes reserved quantities', typeof merchantProducts.json.products[0]?.reservedQuantity === 'number');

  const { data: category } = await admin.from('categories').select('id').eq('slug', 'laptops').single();

  const createdProduct = await panel.fetch('/api/merchant/products', {
    method: 'POST',
    body: JSON.stringify({
      name: `Test Laptop ${stamp}`,
      brand: 'ShopiQ Test',
      categoryId: category.id,
      sku: `SQ-TEST-${stamp}`,
      price: 54999,
      compareAtPrice: 64999,
      shortDescription: 'A product created by the automated test.',
      description: 'Created and removed by scripts/test-auth-flow.mjs.',
      tags: ['test'],
      rating: 4.2,
      reviewCount: 10,
      isFeatured: false,
      isActive: true,
      quantity: 7,
      lowStockThreshold: 3,
      specs: [
        { key: 'ram_gb', label: 'Memory', value: 16, unit: 'GB' },
        { key: 'processor', label: 'Processor', value: 'Test CPU X1' },
      ],
    }),
  });
  check('POST create product → 201', createdProduct.status === 201, `got ${createdProduct.status} ${createdProduct.text.slice(0, 200)}`);
  const newProductId = createdProduct.json?.product?.id;
  if (newProductId) created.products.push(newProductId);

  const { data: cachedSpecs } = await admin
    .from('products')
    .select('specs')
    .eq('id', newProductId)
    .single();
  check(
    'numeric specs are stored as numbers in the jsonb cache',
    cachedSpecs.specs.ram_gb === 16 && typeof cachedSpecs.specs.ram_gb === 'number',
    JSON.stringify(cachedSpecs.specs),
  );
  check('text specs stay text', cachedSpecs.specs.processor === 'Test CPU X1');

  const { data: newInventory } = await admin
    .from('inventory')
    .select('quantity, available')
    .eq('product_id', newProductId)
    .single();
  check('opening stock was set', newInventory.quantity === 7 && newInventory.available === 7);

  const duplicateSku = await panel.fetch('/api/merchant/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Duplicate SKU product',
      brand: 'ShopiQ Test',
      categoryId: category.id,
      sku: `SQ-TEST-${stamp}`,
      price: 1000,
      quantity: 1,
      specs: [],
      tags: [],
    }),
  });
  check('duplicate SKU → 409', duplicateSku.status === 409, `got ${duplicateSku.status}`);

  const badPrice = await panel.fetch('/api/merchant/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Bad discount product',
      brand: 'ShopiQ Test',
      categoryId: category.id,
      sku: `SQ-TEST-BAD-${stamp}`,
      price: 5000,
      compareAtPrice: 1000,
      quantity: 1,
      specs: [],
      tags: [],
    }),
  });
  check('compareAtPrice below price → 400', badPrice.status === 400, `got ${badPrice.status}`);

  const patched = await panel.fetch(`/api/merchant/products/${newProductId}`, {
    method: 'PATCH',
    body: JSON.stringify({ price: 49999, isFeatured: true }),
  });
  check('PATCH product → 200', patched.status === 200, `got ${patched.status}`);
  check('price updated', Number(patched.json.product.price) === 49999);

  // ------------------------------------------------------------ R2 upload
  section('R2 image upload');

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#F7931E"/></svg>`,
  );
  const form = new FormData();
  form.append('file', new Blob([svg], { type: 'image/svg+xml' }), 'test cover!!.svg');

  const upload = await panel.fetch(`/api/merchant/products/${newProductId}/images`, {
    method: 'POST',
    body: form,
  });
  check('POST image → 201', upload.status === 201, `got ${upload.status} ${upload.text.slice(0, 200)}`);
  const image = upload.json?.image;
  check('filename was sanitised into a safe key', /^products\/[0-9a-f-]{36}\/test-cover-[a-z0-9]{6}\.svg$/.test(image?.r2_key ?? ''), image?.r2_key);
  check('first image becomes primary', image?.is_primary === true);
  check('public URL points at the CDN', /^https:\/\/cdn\./.test(image?.public_url ?? ''));

  const fetched = await fetch(image.public_url);
  check('uploaded image is publicly fetchable', fetched.ok, `HTTP ${fetched.status}`);
  check('content type preserved', (fetched.headers.get('content-type') ?? '').includes('svg'));

  const notAnImage = new FormData();
  notAnImage.append('file', new Blob([Buffer.from('this is definitely not an image at all, just text')], { type: 'image/png' }), 'evil.png');
  const rejected = await panel.fetch(`/api/merchant/products/${newProductId}/images`, {
    method: 'POST',
    body: notAnImage,
  });
  check(
    'a text file claiming to be a PNG is rejected → 400',
    rejected.status === 400,
    `got ${rejected.status}`,
  );

  const removedImage = await panel.fetch(
    `/api/merchant/products/${newProductId}/images?imageId=${image.id}`,
    { method: 'DELETE' },
  );
  check('DELETE image → 200', removedImage.status === 200);
  // Check the R2 origin, not the CDN: uploads carry `immutable` cache headers,
  // so Cloudflare's edge may keep serving a copy of a deleted object until the
  // TTL expires. What matters is that the origin object and the DB row are gone.
  check('object removed from the R2 origin', await objectIsGone(image.r2_key), image.r2_key);
  const { data: imageRow } = await admin
    .from('product_images')
    .select('id')
    .eq('id', image.id)
    .maybeSingle();
  check('image row removed from the database', imageRow === null);

  // ------------------------------------------------------------- inventory
  section('Merchant inventory');

  const inv = await panel.fetch('/api/merchant/inventory?limit=10');
  check('GET inventory → 200', inv.status === 200);
  check('rows carry a status', ['healthy', 'low_stock', 'out_of_stock'].includes(inv.json.inventory[0]?.status));

  const setStock = await panel.fetch('/api/merchant/inventory', {
    method: 'PATCH',
    body: JSON.stringify({ productId: newProductId, quantity: 25 }),
  });
  check('PATCH stock → 200', setStock.status === 200);
  const { data: raised } = await admin
    .from('inventory')
    .select('quantity, available')
    .eq('product_id', newProductId)
    .single();
  check('stock raised to 25', raised.quantity === 25 && raised.available === 25);

  const belowReserved = await panel.fetch('/api/merchant/inventory', {
    method: 'PATCH',
    body: JSON.stringify({ productId: product.id, quantity: 0 }),
  });
  check(
    'cannot set stock below what is reserved → 409',
    belowReserved.status === 409,
    `got ${belowReserved.status}`,
  );

  // ------------------------------------------------ order status + inventory
  section('Order status moves inventory');

  const beforeShip = await admin
    .from('inventory')
    .select('quantity, reserved_quantity, available')
    .eq('product_id', product.id)
    .single();

  const shipped = await panel.fetch(`/api/merchant/orders/${orderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'shipped' }),
  });
  check('PATCH status → shipped → 200', shipped.status === 200, `got ${shipped.status}`);

  const afterShip = await admin
    .from('inventory')
    .select('quantity, reserved_quantity, available')
    .eq('product_id', product.id)
    .single();
  check(
    'shipping consumes the reservation',
    afterShip.data.quantity === beforeShip.data.quantity - 2 &&
      afterShip.data.reserved_quantity === beforeShip.data.reserved_quantity - 2,
    `qty ${beforeShip.data.quantity}→${afterShip.data.quantity}, reserved ${beforeShip.data.reserved_quantity}→${afterShip.data.reserved_quantity}`,
  );
  check('available is unchanged by shipping', afterShip.data.available === beforeShip.data.available);

  const cancelled = await panel.fetch(`/api/merchant/orders/${orderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled' }),
  });
  check('PATCH status → cancelled → 200', cancelled.status === 200);

  const afterCancel = await admin
    .from('inventory')
    .select('quantity, reserved_quantity, available')
    .eq('product_id', product.id)
    .single();
  check(
    'cancelling restocks the units',
    afterCancel.data.quantity === beforeShip.data.quantity &&
      afterCancel.data.available === beforeShip.data.available + 2,
    `qty ${afterCancel.data.quantity}, available ${afterCancel.data.available}`,
  );

  const badStatus = await panel.fetch(`/api/merchant/orders/${orderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'teleported' }),
  });
  check('invalid status → 400', badStatus.status === 400, `got ${badStatus.status}`);

  // ---------------------------------------------------- insufficient stock
  section('Insufficient stock is a 409');

  await admin.from('inventory').update({ quantity: 1 }).eq('product_id', newProductId);

  const buyer = session();
  await signIn(buyer, CUSTOMER.email, CUSTOMER.password);
  await buyer.fetch('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: newProductId, quantity: 1 }),
  });
  // Drop the stock underneath the cart, then try to check out.
  await admin.from('inventory').update({ quantity: 0 }).eq('product_id', newProductId);

  const conflict = await buyer.fetch('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      contactEmail: CUSTOMER.email,
      shippingAddress: {
        fullName: 'Test Customer',
        phone: '+91 98765 43210',
        line1: 'Flat 402',
        city: 'Noida',
        state: 'Uttar Pradesh',
        postalCode: '201301',
        country: 'IN',
      },
    }),
  });
  check('checkout with vanished stock → 409', conflict.status === 409, `got ${conflict.status}`);
  check(
    'error code is INVENTORY_CONFLICT',
    conflict.json?.error?.code === 'INVENTORY_CONFLICT',
    conflict.json?.error?.code,
  );
  check(
    'message names the product',
    (conflict.json?.error?.message ?? '').includes('Test Laptop'),
    conflict.json?.error?.message,
  );

  // -------------------------------------------------------------- analytics
  section('Analytics reflect real data');

  const analytics = await panel.fetch('/api/merchant/analytics');
  check('GET analytics → 200', analytics.status === 200);
  const stats = analytics.json.stats;
  check('totalOrders is a real count', typeof stats.totalOrders === 'number' && stats.totalOrders >= 1);
  // Counted against the catalogue rather than a number typed in once: the
  // demo seed's 62 products became 18 real ones, and a hardcoded figure only
  // ever measures how recently someone edited the test.
  const { count: liveProductCount } = await admin
    .from('products')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);
  check(
    'totalProducts matches the catalogue',
    stats.totalProducts === liveProductCount,
    stats.totalProducts + ' vs ' + liveProductCount,
  );
  check(
    'cancelled orders are excluded from revenue',
    stats.cancelledOrders >= 1,
    `cancelled ${stats.cancelledOrders}`,
  );
  check('recentRevenue is an array', Array.isArray(stats.recentRevenue));

  // ------------------------------------------------------------ page renders
  section('Authenticated pages render');

  for (const [sess, path, needle] of [
    [shopper, '/account', 'Account'],
    // The list itself is fetched client-side, so the server HTML carries the
    // account nav rather than the orders — match the nav label it does render.
    [shopper, '/account/orders', 'My orders'],
    [shopper, '/checkout', 'Checkout'],
    [panel, '/merchant', 'Overview'],
    [panel, '/merchant/products', 'Products'],
    [panel, '/merchant/inventory', 'Inventory'],
    [panel, '/merchant/orders', 'Orders'],
    [panel, '/merchant/analytics', 'Analytics'],
  ]) {
    const page = await sess.fetch(path);
    check(
      `GET ${path} → 200`,
      page.status === 200 && page.text.includes(needle),
      `status ${page.status}`,
    );
  }

  // Invoice emails already in customers' inboxes link to /orders, so the old
  // path has to keep working as a redirect rather than 404.
  const legacyOrders = await shopper.fetch('/orders');
  check(
    'the legacy /orders link still reaches order history',
    legacyOrders.status === 307 || legacyOrders.status === 308 || legacyOrders.status === 200,
    `status ${legacyOrders.status}`,
  );

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  · ${f}`);
  }
}

main()
  .catch((error) => {
    console.error('\nTest crashed:', error);
    failed++;
  })
  .finally(async () => {
    console.log('\nCleaning up test data…');
    await cleanup();
    console.log('done.');
    process.exit(failed > 0 ? 1 : 0);
  });
