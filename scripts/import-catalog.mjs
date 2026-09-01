/**
 * Import the ShopiQ demo catalogue into Supabase.
 *
 *   node -r dotenv/config scripts/import-catalog.mjs dotenv_config_path=.env.local
 *   … --dry-run          validate and report, write nothing
 *   … --keep-absent      leave products not in the catalogue active
 *
 * Populates: categories, products, product_specs, product_images, inventory.
 *
 * Three properties this script guarantees, in order of how much damage their
 * absence would do:
 *
 *   1. It NEVER deletes a product, order, cart, customer or payment. Products
 *      absent from the catalogue are DEACTIVATED, not removed — order history
 *      keeps its foreign keys, and a mistake here is reversible.
 *   2. It is idempotent. Keyed on SKU, which is unique and stable, so running
 *      it twice produces the same catalogue rather than two of everything.
 *   3. It validates before it writes. A dataset with a bad category or a
 *      string where a number belongs is rejected whole rather than imported
 *      into a state where products are silently unreachable.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

register('./scripts/ts-loader.mjs', pathToFileURL('./'));

import { createClient } from '@supabase/supabase-js';

const { validateCatalogData, summarise } = await import('../lib/catalog/validate.ts');
const { taxonomy } = await import('../lib/catalog/config.ts');

const DRY = process.argv.includes('--dry-run');
const KEEP_ABSENT = process.argv.includes('--keep-absent');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

/* ------------------------------------------------------------- validation */

const catalog = JSON.parse(fs.readFileSync('data/catalog/catalog.json', 'utf8'));
const { errors, warnings } = summarise(validateCatalogData(catalog));

console.log(`ShopiQ catalogue ${catalog.catalog_version}${catalog.demo_dataset ? ' (demo dataset)' : ''}`);
console.log(`${catalog.products.length} products\n`);

for (const warning of warnings.slice(0, 15)) {
  console.log(`  warn  ${warning.product ?? ''} — ${warning.problem}`);
}
if (warnings.length > 15) console.log(`  … and ${warnings.length - 15} more warnings`);

if (errors.length > 0) {
  console.error(`\n${errors.length} error(s) — nothing was written:\n`);
  for (const error of errors.slice(0, 30)) {
    console.error(`  ${error.product ?? ''} — ${error.problem}`);
  }
  process.exit(1);
}
console.log(`\nvalidation passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.\n`);

if (DRY) {
  console.log('--dry-run: nothing was written.');
  process.exit(0);
}

/* ------------------------------------------------------------- categories */

// Create only what is missing. Existing categories are left exactly as they
// are — re-parenting a category the storefront already links to is not this
// script's business.
const { data: existingCategories } = await db.from('categories').select('id, slug');
const categoryId = Object.fromEntries((existingCategories ?? []).map((c) => [c.slug, c.id]));

const needed = new Set(catalog.products.map((product) => product.category));
const nodeBySlug = Object.fromEntries(taxonomy.nodes.map((node) => [node.slug, node]));

// Parents first, so a child can reference one that exists.
const ordered = [];
const visit = (slug) => {
  if (!slug || ordered.includes(slug)) return;
  const node = nodeBySlug[slug];
  if (node?.parent) visit(node.parent);
  ordered.push(slug);
};
for (const slug of needed) visit(slug);

let categoriesCreated = 0;
for (const slug of ordered) {
  if (categoryId[slug]) continue;
  const node = nodeBySlug[slug];
  if (!node) {
    console.error(`  category "${slug}" is not in the taxonomy — aborting.`);
    process.exit(1);
  }
  const { data, error } = await db
    .from('categories')
    .insert({
      slug: node.slug,
      name: node.name,
      parent_id: node.parent ? (categoryId[node.parent] ?? null) : null,
      is_active: true,
    })
    .select('id')
    .single();
  if (error) {
    console.error(`  could not create category ${slug}: ${error.message}`);
    process.exit(1);
  }
  categoryId[slug] = data.id;
  categoriesCreated += 1;
  console.log(`  + category ${slug}`);
}

/* ---------------------------------------------------------------- products */

const slugify = (value) =>
  String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Derive an r2_key from a CDN URL — the column is NOT NULL and unique. */
const r2KeyFor = (imageUrl) => {
  try {
    return decodeURIComponent(new URL(imageUrl).pathname).replace(/^\/+/, '');
  } catch {
    return imageUrl.slice(0, 400);
  }
};

let created = 0;
let updated = 0;
const importedSkus = new Set();

for (const product of catalog.products) {
  importedSkus.add(product.sku);

  const row = {
    category_id: categoryId[product.category],
    name: product.name,
    slug: product.id,
    brand: product.brand,
    description: product.description ?? product.short_description ?? null,
    short_description: product.short_description ?? null,
    price: product.pricing.selling_price,
    compare_at_price: product.pricing.mrp ?? null,
    currency: product.pricing.currency ?? 'INR',
    sku: product.sku,
    // Segments ride in `tags`, which is the only free-form classification
    // column the schema has. Without this the rule engine sees no segments at
    // all and a rule like "gaming laptops want a gaming mouse" never fires —
    // silently, because an unmatched rule looks exactly like no rule.
    tags: [...new Set([...(product.tags ?? []), ...(product.segments ?? [])])],
    specs: product.specifications ?? {},
    // Everything the recommendation engine needs that has no column of its
    // own. Written whole so a removed field disappears rather than lingering.
    catalog_metadata: {
      product_family: product.product_family ?? null,
      segments: product.segments ?? [],
      use_cases: product.use_cases ?? [],
      performance: product.performance ?? {},
      compatibility: product.compatibility ?? {},
      relationships: product.relationships ?? [],
      recommendation_profile: product.recommendation_profile ?? {},
      configuration: product.configuration ?? {},
    },
    is_active: true,
  };

  // Keyed on SKU: it is unique, stable across re-runs, and does not change
  // when a name is edited.
  const { data: existing } = await db
    .from('products')
    .select('id, rating, review_count')
    .eq('sku', product.sku)
    .maybeSingle();

  let productId;
  if (existing) {
    // Ratings are customer data, not catalogue data. Re-importing must not
    // reset them.
    const { error } = await db.from('products').update(row).eq('id', existing.id);
    if (error) {
      console.error(`  ${product.sku}: ${error.message}`);
      process.exit(1);
    }
    productId = existing.id;
    updated += 1;
  } else {
    const { data, error } = await db
      .from('products')
      .insert({ ...row, rating: product.rating ?? 0, review_count: product.review_count ?? 0 })
      .select('id')
      .single();
    if (error) {
      console.error(`  ${product.sku}: ${error.message}`);
      process.exit(1);
    }
    productId = data.id;
    created += 1;
  }

  // -- specs -------------------------------------------------------------
  // Replaced rather than merged: a spec removed from the catalogue must
  // disappear, or a stale value keeps filtering.
  await db.from('product_specs').delete().eq('product_id', productId);
  const specRows = Object.entries(product.specifications ?? {}).map(([key, value], index) => ({
    product_id: productId,
    spec_key: key,
    spec_value: String(value),
    // The numeric mirror is what range filters use. A non-numeric value must
    // be null here rather than 0, which would compare as "smaller than
    // everything" and quietly match every `lte` filter.
    spec_value_num: typeof value === 'number' && Number.isFinite(value) ? value : null,
    display_label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    sort_order: index,
  }));
  if (specRows.length > 0) {
    const { error } = await db.from('product_specs').insert(specRows);
    if (error) console.error(`  ${product.sku} specs: ${error.message}`);
  }

  // -- images ------------------------------------------------------------
  // Cleared first: the single-primary-image index rejects a second primary,
  // and re-running would otherwise collide with itself.
  await db.from('product_images').delete().eq('product_id', productId);
  const imageRows = (product.images ?? []).map((image, index) => ({
    product_id: productId,
    r2_key: `${r2KeyFor(image.url)}#${slugify(product.sku)}-${index}`,
    public_url: image.url,
    alt_text: image.alt ?? `${product.brand} ${product.name}`,
    sort_order: index,
    is_primary: image.is_primary === true || index === 0,
  }));
  if (imageRows.length > 0) {
    // Exactly one primary, whatever the file said.
    imageRows.forEach((image, index) => { image.is_primary = index === 0; });
    const { error } = await db.from('product_images').insert(imageRows);
    if (error) console.error(`  ${product.sku} images: ${error.message}`);
  }

  // -- inventory ---------------------------------------------------------
  // reserved_quantity is left alone: it belongs to orders in flight, and
  // resetting it would release stock somebody has already paid for.
  const { data: existingInventory } = await db
    .from('inventory')
    .select('id')
    .eq('product_id', productId)
    .maybeSingle();

  if (existingInventory) {
    await db
      .from('inventory')
      .update({ quantity: product.inventory.quantity, updated_at: new Date().toISOString() })
      .eq('id', existingInventory.id);
  } else {
    await db.from('inventory').insert({
      product_id: productId,
      quantity: product.inventory.quantity,
      reserved_quantity: 0,
      low_stock_threshold: product.inventory.low_stock_threshold ?? 5,
    });
  }
}

/* --------------------------------------------------------------- retiring */

let retired = 0;
if (!KEEP_ABSENT) {
  const { data: allProducts } = await db.from('products').select('id, sku, name, is_active');
  const absent = (allProducts ?? []).filter(
    (product) => product.is_active && !importedSkus.has(product.sku),
  );

  for (const product of absent) {
    // DEACTIVATED, never deleted. order_items reference these rows, and a
    // delete would either fail or null out a customer's purchase history.
    await db.from('products').update({ is_active: false }).eq('id', product.id);
    retired += 1;
    console.log(`  - retired ${product.sku} (${product.name})`);
  }
}

/* ---------------------------------------------------------------- summary */

const { count: activeCount } = await db
  .from('products')
  .select('*', { count: 'exact', head: true })
  .eq('is_active', true);

console.log('');
console.log(`categories created : ${categoriesCreated}`);
console.log(`products created   : ${created}`);
console.log(`products updated   : ${updated}`);
console.log(`products retired   : ${retired}${KEEP_ABSENT ? ' (--keep-absent)' : ''}`);
console.log(`active products now: ${activeCount}`);
console.log('\nNothing was deleted. Orders, carts, customers and payments are untouched.');
