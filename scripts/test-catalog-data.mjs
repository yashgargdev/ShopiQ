/**
 * Demo catalogue tests — the imported data, against the real database.
 *
 *   node -r dotenv/config scripts/test-catalog-data.mjs dotenv_config_path=.env.local
 *
 * scripts/test-catalog.mjs covers the engine with a fixture and no database.
 * This covers the DATA: that the demo catalogue actually answers the questions
 * the demo will be asked, that retrieval pushes into Postgres, and — most
 * importantly — that it says NO when the honest answer is no.
 *
 * The negative cases are the ones worth having. A recommender that returns
 * something plausible for every question demos beautifully and is wrong in
 * exactly the situations that cost money.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

register('./scripts/ts-loader.mjs', pathToFileURL('./'));

import { createClient } from '@supabase/supabase-js';

const { searchProductSummaries } = await import('../lib/ai/tools/implementations.ts');
const { getProductDetail } = await import('../lib/products/queries.ts');
const { findRecommendations, findCompatibleProducts, findUpsell } = await import('../lib/catalog/recommend.ts');
const { validateCatalogData, summarise } = await import('../lib/catalog/validate.ts');

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

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

const search = (input) =>
  searchProductSummaries({
    query: null, category: null, brand: null, min_price: null, max_price: null,
    min_rating: null, filters: null, in_stock_only: true, sort: 'relevance', limit: 10,
    ...input,
  });

// ============================================================ the dataset
section('The demo catalogue file');

const catalog = JSON.parse(fs.readFileSync('data/catalog/catalog.json', 'utf8'));
const { errors, warnings } = summarise(validateCatalogData(catalog));

check('validates with no errors', errors.length === 0, errors.slice(0, 3).map((e) => `${e.product}: ${e.problem}`).join(' | '));
check('validates with no warnings', warnings.length === 0, warnings.slice(0, 3).map((w) => `${w.product}: ${w.problem}`).join(' | '));
check('is marked as a demo dataset', catalog.demo_dataset === true);
check('holds 100-130 products', catalog.products.length >= 100 && catalog.products.length <= 130, String(catalog.products.length));

const families = new Set(catalog.products.map((p) => p.product_family).filter(Boolean));
check('groups products into families', families.size >= 40, String(families.size));

const multiConfig = [...families].filter(
  (family) => catalog.products.filter((p) => p.product_family === family).length > 1,
);
check('several families have multiple configurations', multiConfig.length >= 15, String(multiConfig.length));

// Every image must be a supplied CDN asset. Reuse is fine; invention is not.
const hosts = new Set(
  catalog.products.flatMap((p) => (p.images ?? []).map((i) => new URL(i.url).hostname)),
);
check('every image is on the ShopiQ CDN', hosts.size === 1 && hosts.has('cdn.shopiq.yashgarg.co.in'), [...hosts].join(','));

check(
  'MRP is never below the selling price',
  catalog.products.every((p) => !p.pricing.mrp || p.pricing.mrp >= p.pricing.selling_price),
);
check(
  'every product has a unique SKU',
  new Set(catalog.products.map((p) => p.sku)).size === catalog.products.length,
);
check(
  'at least one product is low stock, for the inventory demo',
  catalog.products.some((p) => p.inventory.quantity > 0 && p.inventory.quantity <= 5),
);

// ================================================================= import
section('What reached the database');

const { count: active } = await db.from('products').select('*', { count: 'exact', head: true }).eq('is_active', true);
check('the active catalogue matches the file', active === catalog.products.length, `${active} vs ${catalog.products.length}`);

const { count: orders } = await db.from('orders').select('*', { count: 'exact', head: true });
check('orders survived the import', orders > 0, String(orders));

const { data: retired } = await db.from('products').select('id').eq('is_active', false);
check('superseded products were deactivated, not deleted', (retired ?? []).length > 0, String((retired ?? []).length));

const { data: noStock } = await db
  .from('products')
  .select('id, inventory(id)')
  .eq('is_active', true)
  .limit(200);
// inventory is one-to-one, so PostgREST embeds it as an OBJECT, not an
// array. Testing .length here reported every product as missing stock.
check(
  'every active product has an inventory row',
  (noStock ?? []).length > 0 && noStock.every((p) => p.inventory && p.inventory.id),
  'products without stock cannot be sold at all',
);

// A numeric spec must land in spec_value_num, or range filters cannot see it.
const { data: numeric } = await db
  .from('product_specs')
  .select('spec_value_num')
  .eq('spec_key', 'ram_gb')
  .limit(20);
check(
  'numeric specs populate spec_value_num',
  (numeric ?? []).length > 0 && numeric.every((s) => typeof s.spec_value_num === 'number'),
);

const { data: textual } = await db
  .from('product_specs')
  .select('spec_value_num')
  .eq('spec_key', 'processor')
  .limit(10);
check(
  'text specs leave spec_value_num null, not zero',
  (textual ?? []).every((s) => s.spec_value_num === null),
  'zero would compare as smaller than everything and match every lte filter',
);

// ============================================================== retrieval
section('Deterministic retrieval');

const under80 = await search({ category: 'gaming-laptops', max_price: 80000 });
check('gaming laptop under 80k finds candidates', under80.products.length > 0, String(under80.products.length));
check('all of them are within budget', under80.products.every((p) => p.price <= 80000));
check('all of them are in stock', under80.products.every((p) => p.availability.available > 0));

const samsung = await search({ category: 'smartphones', brand: ['Samsung'], max_price: 70000 });
check('Samsung phone under 70k finds candidates', samsung.products.length > 0);
check('brand filtering is exact', samsung.products.every((p) => p.brand === 'Samsung'));
check('budget uses price, not MRP', samsung.products.every((p) => p.price <= 70000));

const ram12 = await search({ category: 'smartphones', filters: { ram_gb_min: 12 } });
check('12GB RAM phones are found by spec', ram12.products.length > 0, String(ram12.products.length));
check('the RAM filter is honoured', ram12.products.every((p) => Number(p.specs.ram_gb) >= 12));

const storage1tb = await search({ category: 'laptops', filters: { storage_gb_min: 1024 } });
check('1TB laptops are found by spec', storage1tb.products.length > 0);
check('the storage filter is honoured', storage1tb.products.every((p) => Number(p.specs.storage_gb) >= 1024));

const cheapProgramming = await search({ category: 'laptops', max_price: 60000 });
check('a laptop under 60k exists for the programming demo', cheapProgramming.products.length > 0);

// ------------------------------------------------------ the honest "no"
const impossible = await search({ category: 'gaming-laptops', max_price: 20000 });
check(
  'a gaming laptop under 20k returns NOTHING rather than a near miss',
  impossible.products.length === 0,
  impossible.products.map((p) => `${p.name} ${p.price}`).join(','),
);

const noSuchBrand = await search({ category: 'smartphones', brand: ['Nokia'] });
check('a brand we do not stock returns nothing', noSuchBrand.products.length === 0);

// ========================================================= recommendations
section('Recommendations');

const gamingLaptop = await getProductDetail('asus-tuf-a15-16-512');
const gamingRecs = await findRecommendations({ anchor: gamingLaptop, limit: 3 });
check('a gaming laptop gets recommendations', gamingRecs.recommendations.length > 0);
check('every one carries a reason', gamingRecs.recommendations.every((r) => r.reasons.length > 0));
check('every one carries a score', gamingRecs.recommendations.every((r) => r.score > 0));
check('no more than three are offered', gamingRecs.recommendations.length <= 3);
check(
  'the gaming rule fired, not just the generic laptop rule',
  gamingRecs.appliedRules.includes('gaming-laptop-accessories'),
  gamingRecs.appliedRules.join(','),
);
check(
  'nothing costs more than the laptop',
  gamingRecs.recommendations.every((r) => r.product.price < gamingLaptop.price),
);

const iphone = await getProductDetail('iphone-16-8-256');
const iphoneRecs = await findRecommendations({ anchor: iphone, limit: 3 });
check('an iPhone gets recommendations', iphoneRecs.recommendations.length > 0);
check(
  'a case made for Samsung is NOT offered for an iPhone',
  !iphoneRecs.recommendations.some((r) => /galaxy/i.test(r.product.name)),
  iphoneRecs.recommendations.map((r) => r.product.name).join(', '),
);

// ============================================================ PS5 ecosystem
section('PS5 ecosystem');

const ps5 = await getProductDetail('sony-playstation-5-slim-disc-edition');
const ps5Recs = await findRecommendations({ anchor: ps5, limit: 3 });
check('a PS5 gets ecosystem recommendations', ps5Recs.recommendations.length > 0);
check(
  'a controller is among them',
  ps5Recs.recommendations.some((r) => r.product.category.slug === 'controllers'),
  ps5Recs.recommendations.map((r) => r.product.category.slug).join(','),
);

const ps5Tv = await findCompatibleProducts(ps5, 'televisions', { limit: 3 });
check('a television is recommended for the PS5', ps5Tv.recommendations.length > 0);
check(
  'every recommended television is 4K at 120Hz over HDMI 2.1',
  ps5Tv.recommendations.every(
    (r) =>
      Number(r.product.specs.refresh_rate_hz) >= 120 &&
      r.product.specs.resolution === '4K' &&
      Number(r.product.specs.hdmi_version) >= 2.1,
  ),
  ps5Tv.recommendations.map((r) => `${r.product.name}:${r.product.specs.refresh_rate_hz}Hz`).join(', '),
);

// The catalogue deliberately contains 60Hz televisions. They must never be
// offered for a console that outputs 120 — that is the whole point of the
// requirement on the rule.
const all60hz = await search({ category: 'televisions', filters: { refresh_rate_hz_max: 60 } });
check('the catalogue does contain 60Hz televisions', all60hz.products.length > 0);
check(
  'none of them is offered for the PS5',
  !ps5Tv.recommendations.some((r) => all60hz.products.some((tv) => tv.id === r.product.id)),
);

// ================================================================= upsell
section('Upselling');

const cheapLaptop = (await search({ category: 'laptops', max_price: 45000, sort: 'price_desc' })).products[0];
if (cheapLaptop) {
  const upsell = await findUpsell(cheapLaptop, 45000);
  check(
    'an upsell, when offered, costs more than the anchor',
    upsell === null || upsell.product.price > cheapLaptop.price,
    upsell ? `${upsell.product.name} ${upsell.product.price} vs ${cheapLaptop.price}` : 'none offered',
  );
  check(
    'an upsell stays within the configured uplift',
    upsell === null || upsell.product.price <= 45000 * 1.25,
    upsell ? String(upsell.product.price) : 'none offered',
  );
  check('an upsell explains the difference', upsell === null || upsell.reasons.length > 0);
} else {
  check('a laptop exists to test upselling against', false);
}

// ============================================================== diversity
section('Diversity');

const laptops = await search({ category: 'laptops', max_price: 70000, limit: 10 });
const brands = new Set(laptops.products.map((p) => p.brand));
check('the laptop catalogue spans several brands', brands.size >= 3, [...brands].join(','));

// ================================================================ summary
console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
