/**
 * Seeds the ShopiQ catalogue: categories, products, specifications, inventory,
 * and one generated product image per product uploaded to Cloudflare R2.
 *
 *   node -r dotenv/config scripts/seed.mjs dotenv_config_path=.env.local
 *
 * Safe to re-run: everything upserts on its natural key (category slug,
 * product SKU, product+spec key, product+r2 key).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

import { CATEGORIES, PRODUCTS, SPEC_LABELS } from '../supabase/seed/catalog.mjs';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? '').replace(/\/+$/, '');
const BUCKET = process.env.R2_BUCKET_NAME ?? 'shopiq';
const SKIP_IMAGES = process.argv.includes('--skip-images');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const r2 =
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

// ---------------------------------------------------------------------------

const slugify = (s) =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function fail(step, error) {
  console.error(`\n✗ ${step}`);
  console.error(error?.message ?? error);
  process.exit(1);
}

// ------------------------------------------------------------ product art --
// Generated cover art, not photography: a deterministic gradient card carrying
// the brand and product name, in the ShopiQ palette. Replace per product from
// the merchant dashboard once real photography exists.

const PALETTES = [
  ['#F7931E', '#DE6A0C'],
  ['#FFB65C', '#C2540A'],
  ['#FFC97A', '#E07A12'],
  ['#F58C1F', '#8E3D05'],
];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/** Break a product name into at most three balanced lines. */
function wrap(text, maxChars = 18) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function productSvg(product) {
  const seed = hash(product.sku);
  const [from, to] = PALETTES[seed % PALETTES.length];
  const angle = 110 + (seed % 40);
  const lines = wrap(product.name);
  const startY = 300 - (lines.length - 1) * 26;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600" role="img" aria-label="${escapeXml(product.brand)} ${escapeXml(product.name)}">
  <defs>
    <linearGradient id="g" gradientTransform="rotate(${angle})">
      <stop offset="0%" stop-color="${from}" stop-opacity="0.30"/>
      <stop offset="60%" stop-color="${to}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="24%" r="62%">
      <stop offset="0%" stop-color="${from}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="${from}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="800" height="600" fill="#0F0F13"/>
  <rect width="800" height="600" fill="url(#g)"/>
  <ellipse cx="400" cy="150" rx="380" ry="220" fill="url(#glow)"/>
  <g fill="none" stroke="${from}" stroke-opacity="0.22" stroke-width="1.5">
    <circle cx="400" cy="300" r="150"/>
    <circle cx="400" cy="300" r="196"/>
  </g>
  <text x="400" y="150" text-anchor="middle" fill="#8B8B92"
        font-family="'Geist Mono',ui-monospace,'SFMono-Regular',Menlo,monospace"
        font-size="20" letter-spacing="4">${escapeXml(product.brand.toUpperCase())}</text>
  ${lines
    .map(
      (line, i) =>
        `<text x="400" y="${startY + i * 52}" text-anchor="middle" fill="#EDEDF0" font-family="'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif" font-size="42" font-weight="600">${escapeXml(line)}</text>`,
    )
    .join('\n  ')}
  <text x="400" y="470" text-anchor="middle" fill="${from}"
        font-family="'Geist Mono',ui-monospace,monospace" font-size="22" font-weight="500">₹${product.price.toLocaleString('en-IN')}</text>
  <text x="400" y="546" text-anchor="middle" fill="#4E4E56"
        font-family="'Geist Mono',ui-monospace,monospace" font-size="14" letter-spacing="3">SHOPIQ</text>
</svg>`;
}

async function uploadImage(product, productId) {
  const key = `products/${productId}/main.svg`;
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(productSvg(product), 'utf8'),
      ContentType: 'image/svg+xml',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return {
    r2_key: key,
    public_url: R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : `/api/media/${key}`,
  };
}

// ---------------------------------------------------------------------------

async function seedCategories() {
  const bySlug = new Map();

  for (const category of CATEGORIES) {
    const row = {
      name: category.name,
      slug: category.slug,
      description: category.description ?? null,
      sort_order: category.sort ?? 0,
      is_active: true,
      parent_id: category.parent ? bySlug.get(category.parent) : null,
    };

    const { data, error } = await db
      .from('categories')
      .upsert(row, { onConflict: 'slug' })
      .select('id, slug')
      .single();

    if (error) fail(`categories: ${category.slug}`, error);
    bySlug.set(data.slug, data.id);
  }

  console.log(`  categories        ${bySlug.size}`);
  return bySlug;
}

async function seedProducts(categoryIds) {
  let productCount = 0;
  let specCount = 0;
  let imageCount = 0;

  for (const item of PRODUCTS) {
    const categoryId = categoryIds.get(item.cat);
    if (!categoryId) fail(`products: ${item.sku}`, `unknown category "${item.cat}"`);

    const { data: product, error } = await db
      .from('products')
      .upsert(
        {
          category_id: categoryId,
          name: item.name,
          slug: slugify(item.name),
          brand: item.brand,
          sku: item.sku,
          description: item.desc,
          short_description: item.short,
          price: item.price,
          compare_at_price: item.mrp ?? null,
          currency: 'INR',
          tags: item.tags ?? [],
          rating: item.rating,
          review_count: item.reviews,
          is_featured: Boolean(item.featured),
          is_active: true,
        },
        { onConflict: 'sku' },
      )
      .select('id')
      .single();

    if (error) fail(`products: ${item.sku}`, error);
    productCount++;

    // -- specifications ----------------------------------------------------
    const specRows = Object.entries(item.specs ?? {})
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value], index) => {
        // Fall back to a title-cased label so a new spec key never blocks a seed.
        const meta = SPEC_LABELS[key] ?? {
          label: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        };
        return {
          product_id: product.id,
          spec_key: key,
          spec_value: String(value),
          spec_value_num: typeof value === 'number' ? value : null,
          unit: meta.unit ?? null,
          display_label: meta.label,
          sort_order: index,
        };
      });

    if (specRows.length) {
      const { error: specError } = await db
        .from('product_specs')
        .upsert(specRows, { onConflict: 'product_id,spec_key' });
      if (specError) fail(`specs: ${item.sku}`, specError);
      specCount += specRows.length;
    }

    // -- inventory ---------------------------------------------------------
    const { error: invError } = await db
      .from('inventory')
      .upsert(
        {
          product_id: product.id,
          quantity: item.stock ?? 0,
          reserved_quantity: 0,
          low_stock_threshold: 5,
        },
        { onConflict: 'product_id' },
      );
    if (invError) fail(`inventory: ${item.sku}`, invError);

    // -- image -------------------------------------------------------------
    if (r2 && !SKIP_IMAGES) {
      const image = await uploadImage(item, product.id);
      // Clear any existing rows first. scripts/fetch-product-images.mjs may have
      // replaced the placeholder with real photography under a different key,
      // and only one row per product may be primary — upserting on
      // (product_id, r2_key) would not match that row and would collide with
      // the partial unique index instead.
      await db.from('product_images').delete().eq('product_id', product.id);
      const { error: imgError } = await db.from('product_images').upsert(
        {
          product_id: product.id,
          r2_key: image.r2_key,
          public_url: image.public_url,
          alt_text: `${item.brand} ${item.name}`,
          width: 800,
          height: 600,
          sort_order: 0,
          is_primary: true,
        },
        { onConflict: 'product_id,r2_key' },
      );
      if (imgError) fail(`images: ${item.sku}`, imgError);
      imageCount++;
    }

    if (productCount % 10 === 0) process.stdout.write(`  … ${productCount} products\r`);
  }

  console.log(`  products          ${productCount}`);
  console.log(`  specifications    ${specCount}`);
  console.log(`  images in R2      ${imageCount}${SKIP_IMAGES ? ' (skipped)' : ''}`);
}

async function main() {
  console.log('Seeding ShopiQ catalogue…');
  const categoryIds = await seedCategories();
  await seedProducts(categoryIds);

  const { count } = await db.from('products').select('id', { count: 'exact', head: true });
  console.log(`\n✓ Catalogue ready — ${count} products in the database.`);
}

main().catch((err) => fail('seed', err));
