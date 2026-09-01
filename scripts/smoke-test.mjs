/**
 * End-to-end smoke test against a running ShopiQ server.
 *
 *   npm run dev            # in one terminal
 *   node scripts/smoke-test.mjs
 *
 * Covers the public API surface, guest cart persistence via cookie, and the
 * authorisation boundaries. Exits non-zero if anything fails.
 */

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  [32mPASS[0m  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  [31mFAIL[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n[1m${title}[0m`);
}

/** Keeps the guest cart cookie across requests. */
const jar = new Map();

async function api(path, init = {}) {
  const cookieHeader = Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(init.headers ?? {}),
    },
    redirect: 'manual',
  });

  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML response */
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function main() {
  console.log(`ShopiQ smoke test → ${BASE}\n${'='.repeat(52)}`);

  // ---------------------------------------------------------------- catalogue
  section('Products API');

  const list = await api('/api/products?limit=5');
  check('GET /api/products → 200', list.status === 200, `got ${list.status}`);
  check('returns products array', Array.isArray(list.json?.products));
  check('returns 5 products', list.json?.products?.length === 5, `got ${list.json?.products?.length}`);
  check(
    'pagination metadata is complete',
    ['page', 'limit', 'total', 'totalPages'].every((k) => k in (list.json?.pagination ?? {})),
  );
  check(
    'the catalogue is populated',
    (list.json?.pagination?.total ?? 0) >= 18,
    `got ${list.json?.pagination?.total}`,
  );

  const first = list.json?.products?.[0];
  check('price is a number, not a formatted string', typeof first?.price === 'number', typeof first?.price);
  check('currency is separate from the amount', first?.currency === 'INR');
  check('availability is present', typeof first?.availability?.inStock === 'boolean');
  check('specs are machine-readable', first?.specs && typeof first.specs === 'object');
  check('product has an image URL', typeof first?.image === 'string' && first.image.length > 0);

  const filtered = await api('/api/products?category=laptops&maxPrice=80000');
  check('category + maxPrice filter → 200', filtered.status === 200);
  check(
    'every result respects maxPrice',
    (filtered.json?.products ?? []).every((p) => p.price <= 80000),
  );
  check(
    'every result is in the laptops category',
    (filtered.json?.products ?? []).every((p) => p.category?.slug === 'laptops'),
  );

  const sorted = await api('/api/products?sort=price_asc&limit=10');
  const prices = (sorted.json?.products ?? []).map((p) => p.price);
  check(
    'sort=price_asc is ascending',
    prices.every((price, i) => i === 0 || prices[i - 1] <= price),
  );

  const paged = await api('/api/products?page=2&limit=10');
  check('pagination page 2 → 200', paged.status === 200);
  check('page 2 reports page=2', paged.json?.pagination?.page === 2);
  check(
    'page 2 differs from page 1',
    paged.json?.products?.[0]?.id !== list.json?.products?.[0]?.id,
  );

  const badPage = await api('/api/products?page=0');
  check('invalid page → 400', badPage.status === 400, `got ${badPage.status}`);
  check('error has a machine-readable code', badPage.json?.error?.code === 'VALIDATION_ERROR');

  // ------------------------------------------------------------------ search
  section('Search API');

  const search = await api('/api/products/search?q=gaming+laptop');
  check('GET search?q=gaming laptop → 200', search.status === 200);
  check('returns results', (search.json?.products?.length ?? 0) > 0);
  check('echoes the query', search.json?.query === 'gaming laptop');
  const topName = `${search.json?.products?.[0]?.brand} ${search.json?.products?.[0]?.name}`;
  check('top hit is a gaming laptop', /tuf|legion|katana|victus|zephyrus/i.test(topName), topName);

  const specSearch = await api('/api/products/search?q=in+ear+monitors');
  check('spec-aware search finds earphones', (specSearch.json?.products?.length ?? 0) >= 1);

  const emptySearch = await api('/api/products/search?q=');
  check('empty q → 400', emptySearch.status === 400, `got ${emptySearch.status}`);

  const noResults = await api('/api/products/search?q=zzzzqqqxyz');
  check('nonsense query → 200 with 0 results', noResults.status === 200 && noResults.json?.pagination?.total === 0);

  // ------------------------------------------------------------ product detail
  section('Product detail & inventory API');

  const slug = first?.slug;
  const detail = await api(`/api/products/${slug}`);
  check('GET /api/products/:slug → 200', detail.status === 200);
  const product = detail.json?.product;
  check('includes category', Boolean(product?.category?.name));
  check('includes images array', Array.isArray(product?.images) && product.images.length > 0);
  check('includes typed specifications', Array.isArray(product?.specifications));
  check(
    'numeric specs stay numeric',
    product?.specifications?.some((s) => typeof s.value === 'number'),
  );
  check('includes related products', Array.isArray(product?.related));
  check('includes availability', typeof product?.availability?.available === 'number');

  const byId = await api(`/api/products/${product?.id}`);
  check('GET /api/products/:uuid also works', byId.status === 200);

  const missing = await api('/api/products/this-product-does-not-exist');
  check('unknown product → 404', missing.status === 404, `got ${missing.status}`);
  check('404 body has NOT_FOUND code', missing.json?.error?.code === 'NOT_FOUND');

  const badRef = await api('/api/products/Not_A_Valid_Ref!!');
  check('malformed product ref → 400', badRef.status === 400, `got ${badRef.status}`);

  const inventory = await api(`/api/products/${product?.id}/inventory`);
  check('GET inventory → 200', inventory.status === 200);
  check('inventory reports availability', typeof inventory.json?.available === 'boolean');
  check('inventory reports a quantity', typeof inventory.json?.quantity === 'number');
  check(
    'inventory hides reserved_quantity',
    !('reserved' in (inventory.json ?? {})) && !('reservedQuantity' in (inventory.json ?? {})),
  );

  // -------------------------------------------------------------- categories
  section('Categories API');

  const categories = await api('/api/categories');
  check('GET /api/categories → 200', categories.status === 200);
  // Not a fixed count: the taxonomy grows whenever the catalogue does, and a
  // magic number here fails on every legitimate addition. What must hold is
  // that the tree is served whole and names the categories a shopper asks for.
  const slugs = new Set((categories.json?.categories ?? []).map((c) => c.slug));
  check('returns the category tree', slugs.size > 0, `got ${slugs.size}`);
  check(
    'the tree names the categories shoppers ask for',
    ['smartphones', 'laptops', 'televisions'].every((slug) => slugs.has(slug)),
    [...slugs].join(','),
  );
  const electronics = categories.json?.categories?.find((c) => c.slug === 'electronics');
  check('parent categories carry children', (electronics?.children?.length ?? 0) > 0);
  check('parent count rolls up children', (electronics?.productCount ?? 0) > 0);

  // --------------------------------------------------------------- guest cart
  section('Cart (guest session)');

  const empty = await api('/api/cart');
  check('GET /api/cart → 200', empty.status === 200);
  check('cart starts empty', empty.json?.cart?.items?.length === 0);

  const added = await api('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, quantity: 2 }),
  });
  check('POST /api/cart/items → 201', added.status === 201, `got ${added.status}`);
  check('cart now has 1 line', added.json?.cart?.items?.length === 1);
  check('quantity is 2', added.json?.cart?.items?.[0]?.quantity === 2);
  check(
    'server priced the line itself',
    added.json?.cart?.items?.[0]?.lineTotal === product.price * 2,
  );
  check('guest cart cookie was set', jar.has('shopiq_cart'));

  const persisted = await api('/api/cart');
  check('cart persists across requests', persisted.json?.cart?.items?.length === 1);

  const itemId = added.json.cart.items[0].id;
  const updated = await api(`/api/cart/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ quantity: 3 }),
  });
  check('PATCH quantity → 200', updated.status === 200);
  check('quantity updated to 3', updated.json?.cart?.items?.[0]?.quantity === 3);

  const overStock = await api(`/api/cart/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ quantity: 20 }),
  });
  const clamped = overStock.json?.cart?.items?.[0]?.quantity;
  check(
    'quantity is clamped to available stock',
    clamped <= product.availability.available,
    `clamped to ${clamped}, available ${product.availability.available}`,
  );

  const badQuantity = await api(`/api/cart/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ quantity: -5 }),
  });
  check('negative quantity → 400', badQuantity.status === 400, `got ${badQuantity.status}`);

  const badProduct = await api('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: 'not-a-uuid', quantity: 1 }),
  });
  check('invalid productId → 400', badProduct.status === 400);

  const ghostProduct = await api('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }),
  });
  check('unknown productId → 404', ghostProduct.status === 404, `got ${ghostProduct.status}`);

  const removed = await api(`/api/cart/items/${itemId}`, { method: 'DELETE' });
  check('DELETE cart item → 200', removed.status === 200);
  check('cart is empty again', removed.json?.cart?.items?.length === 0);

  // ------------------------------------------------------------ authorisation
  section('Authorisation boundaries');

  const orders = await api('/api/orders');
  check('GET /api/orders anonymous → 401', orders.status === 401, `got ${orders.status}`);
  check('401 body has UNAUTHORIZED code', orders.json?.error?.code === 'UNAUTHORIZED');

  const createOrder = await api('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ contactEmail: 'x@example.com', shippingAddress: {} }),
  });
  check('POST /api/orders anonymous → 401', createOrder.status === 401, `got ${createOrder.status}`);

  for (const route of [
    '/api/merchant/products',
    '/api/merchant/inventory',
    '/api/merchant/orders',
    '/api/merchant/analytics',
  ]) {
    const response = await api(route);
    check(`${route} anonymous → 401`, response.status === 401, `got ${response.status}`);
  }

  const merchantPage = await api('/merchant');
  check(
    '/merchant anonymous → redirect to /login',
    merchantPage.status === 307 &&
      (merchantPage.headers.get('location') ?? '').includes('/login'),
    `got ${merchantPage.status} → ${merchantPage.headers.get('location')}`,
  );

  const accountPage = await api('/account');
  check(
    '/account anonymous → renders a signed-out state, not a redirect',
    accountPage.status === 200,
    `got ${accountPage.status}`,
  );

  // ------------------------------------------------------------------ pages
  section('Storefront pages render');

  for (const [path, needle] of [
    ['/', 'Shop smarter'],
    ['/products', 'Products'],
    [`/products/${slug}`, product.name],
    ['/categories', 'Categories'],
    ['/categories/laptops', 'Laptops'],
    ['/search?q=laptop', 'Search ShopiQ'],
    ['/cart', 'Your cart'],
    ['/login', 'Welcome back'],
    ['/signup', 'Create your ShopiQ account'],
  ]) {
    const page = await api(path);
    check(
      `GET ${path} → 200 and renders`,
      page.status === 200 && page.text.includes(needle),
      `status ${page.status}`,
    );
  }

  const notFound = await api('/products/definitely-not-a-real-product');
  check('unknown product page → 404', notFound.status === 404, `got ${notFound.status}`);

  // ------------------------------------------------------------------- media
  section('R2 image delivery');

  const imageUrl = product.images?.[0]?.url;
  check('image URL points at the R2 CDN', /^https:\/\/cdn\./.test(imageUrl ?? ''), imageUrl);
  if (imageUrl?.startsWith('http')) {
    const image = await fetch(imageUrl);
    check('image is publicly fetchable', image.ok, `HTTP ${image.status}`);
    check(
      'image serves the right content type',
      (image.headers.get('content-type') ?? '').includes('image/'),
      image.headers.get('content-type') ?? 'none',
    );
  }

  // ----------------------------------------------------------------- summary
  console.log(`\n${'='.repeat(52)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  · ${failure}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
