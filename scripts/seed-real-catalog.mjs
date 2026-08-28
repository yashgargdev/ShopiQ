/**
 * Replace the demo catalogue with the real products in ./Products.
 *
 *   node -r dotenv/config scripts/seed-real-catalog.mjs dotenv_config_path=.env.local [--dry-run]
 *
 * Storage and chip options are seeded as SEPARATE products rather than as
 * variants: they carry materially different prices, and ShopiQ's schema is one
 * price per product because every downstream guarantee — the cart hash, the
 * confirmation amount, the Razorpay total — is built on a single authoritative
 * figure. Modelling variants would mean threading a chosen option through all
 * of that, which is a schema change, not a seed.
 *
 * Deleting the old catalogue is safe for order history: `order_items.product_id`
 * is ON DELETE SET NULL and each line snapshots the name, SKU, price and image
 * at purchase time.
 */
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
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

const BUCKET = process.env.R2_BUCKET_NAME ?? 'shopiq';
const PUBLIC = (process.env.R2_PUBLIC_URL ?? '').replace(/\/+$/, '');

const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };

/* ------------------------------------------------------------- catalogue
 *
 * Transcribed from each product's docs.txt. Prices are the SELLING price;
 * `mrp` becomes compare_at_price so the discount badge is real rather than
 * invented. Where a docs file gave only one figure, mrp is left null.
 */
const CATALOG = [
  // ------------------------------------------------------------- laptops
  {
    dir: 'Products/Laptop/Asus TUF A14 (2024)',
    category: 'gaming-laptops',
    brand: 'ASUS',
    name: 'TUF Gaming A14 (2024)',
    sku: 'FA401WV',
    price: 149999,
    mrp: 199999,
    stock: 8,
    short: 'Gaming and productivity laptop with an RTX 4060 and 32 GB of memory.',
    description:
      'A 14-inch gaming laptop that does not punish you for carrying it. The Ryzen AI 9 HX 370 and RTX 4060 handle modern titles at high settings, while 32 GB of memory means compiling, editing and a browser full of tabs do not fight each other.',
    tags: ['gaming', 'programming', 'portable'],
    specs: {
      processor: 'AMD Ryzen AI 9 HX 370',
      ram_gb: 32,
      storage_gb: 512,
      storage_type: 'SSD',
      gpu: 'NVIDIA RTX 4060 8 GB',
      display_size: '14 inch',
      use_case: 'Gaming, productivity',
    },
  },
  ...[
    { chip: 'M5', price: 239999, suffix: 'm5' },
    { chip: 'M5 Pro', price: 299999, suffix: 'm5-pro' },
    { chip: 'M5 Pro Max', price: 499999, suffix: 'm5-pro-max' },
  ].map((variant) => ({
    dir: 'Products/Laptop/MacBook Pro',
    category: 'laptops',
    brand: 'Apple',
    name: `MacBook Pro ${variant.chip}`,
    sku: `A2442-${variant.suffix.toUpperCase()}`,
    slugSuffix: variant.suffix,
    price: variant.price,
    mrp: null,
    stock: 6,
    short: `Professional laptop with the ${variant.chip} chip, 16 GB memory and a 1 TB SSD.`,
    description:
      'Built for sustained work rather than bursts — long compiles, large timelines, and a battery that lasts the day. 16 GB of unified memory and a 1 TB SSD as configured.',
    tags: ['productivity', 'professional', 'student'],
    specs: {
      processor: `Apple ${variant.chip}`,
      ram_gb: 16,
      storage_gb: 1024,
      storage_type: 'SSD',
      display_size: '14 inch',
      use_case: 'Productivity, professional, student',
    },
  })),

  // --------------------------------------------------------- smartphones
  ...[
    { size: '128 GB', gb: 128, price: 74900, mrp: 79900, suffix: '128gb' },
    { size: '256 GB', gb: 256, price: 84900, mrp: 89900, suffix: '256gb' },
    { size: '512 GB', gb: 512, price: 104900, mrp: 109900, suffix: '512gb' },
  ].map((variant) => ({
    dir: 'Products/Mobile/IPhone 16',
    category: 'smartphones',
    brand: 'Apple',
    name: `iPhone 16 ${variant.size}`,
    sku: `MYEK3HN/A-${variant.gb}`,
    slugSuffix: variant.suffix,
    barcode: '195949823633',
    price: variant.price,
    mrp: variant.mrp,
    stock: 14,
    short: `iPhone 16 with ${variant.size} of storage.`,
    description:
      'The everyday iPhone, in four colours. Camera Control, the Action button and a battery that comfortably covers a full day.',
    tags: ['camera', 'everyday'],
    specs: { storage_gb: variant.gb, display_size: '6.1 inch', use_case: 'Everyday, camera' },
  })),
  ...[
    { size: '256 GB', gb: 256, price: 82900, suffix: '256gb' },
    { size: '512 GB', gb: 512, price: 102900, suffix: '512gb' },
  ].map((variant) => ({
    dir: 'Products/Mobile/IPhone 17',
    category: 'smartphones',
    brand: 'Apple',
    name: `iPhone 17 ${variant.size}`,
    sku: `MG6M4HN/A-${variant.gb}`,
    slugSuffix: variant.suffix,
    barcode: '195950644043',
    price: variant.price,
    mrp: null,
    stock: 12,
    short: `iPhone 17 with ${variant.size} of storage.`,
    description:
      'The current standard iPhone, in five colours, with a brighter display and a longer-lasting battery than the generation before it.',
    tags: ['camera', 'everyday'],
    specs: { storage_gb: variant.gb, display_size: '6.3 inch', use_case: 'Everyday, camera' },
  })),
  ...[
    { size: '256 GB', gb: 256, price: 134900, suffix: '256gb' },
    { size: '512 GB', gb: 512, price: 154900, suffix: '512gb' },
    { size: '1 TB', gb: 1024, price: 174900, suffix: '1tb' },
    { size: '2 TB', gb: 2048, price: 229900, suffix: '2tb' },
  ].map((variant) => ({
    dir: 'Products/Mobile/IPhone 17 Pro',
    category: 'smartphones',
    brand: 'Apple',
    name: `iPhone 17 Pro ${variant.size}`,
    sku: `MG8H4HN/A-${variant.gb}`,
    slugSuffix: variant.suffix,
    barcode: '195950627305',
    price: variant.price,
    mrp: null,
    stock: 7,
    short: `iPhone 17 Pro with ${variant.size} of storage.`,
    description:
      'The Pro camera system with a longer telephoto reach, in Cosmic Orange and Deep Blue. For photography, video and anything that needs the headroom.',
    tags: ['camera', 'professional', 'video'],
    specs: { storage_gb: variant.gb, display_size: '6.3 inch', use_case: 'Photography, professional' },
  })),
  {
    dir: 'Products/Mobile/Samsung S25 Ultra',
    category: 'smartphones',
    brand: 'Samsung',
    name: 'Galaxy S25 Ultra 12 GB 512 GB',
    sku: 'SM-S938BZTB-512',
    slugSuffix: '512gb',
    price: 129999,
    mrp: 141999,
    stock: 9,
    short: 'Galaxy S25 Ultra with 12 GB memory and 512 GB storage.',
    description:
      'The Ultra, in four titanium finishes. Built-in S Pen, a 200 MP main camera and the largest battery in the range.',
    tags: ['camera', 'productivity', 'stylus'],
    specs: { ram_gb: 12, storage_gb: 512, display_size: '6.9 inch', use_case: 'Photography, productivity' },
  },
  // The 1 TB Galaxy S25 Ultra is deliberately NOT seeded.
  //
  // docs.txt records it as "12 1TB- MRP: Out of Stock" — a stock state with no
  // price. Every guarantee in ShopiQ rests on the catalogue price being real,
  // so inventing a figure for a product a customer could put in a cart is the
  // one thing that must not happen here. Add it with its true price and it
  // will seed like any other.
  ...[
    { size: '256 GB', gb: 256, price: 79999, mrp: 87999, suffix: '256gb' },
    { size: '512 GB', gb: 512, price: 99999, mrp: 107999, suffix: '512gb' },
  ].map((variant) => ({
    dir: 'Products/Mobile/Samsung S26',
    category: 'smartphones',
    brand: 'Samsung',
    name: `Galaxy S26 12 GB ${variant.size}`,
    sku: `SM-S942BZVC-${variant.gb}`,
    slugSuffix: variant.suffix,
    price: variant.price,
    mrp: variant.mrp,
    stock: 11,
    short: `Galaxy S26 with 12 GB memory and ${variant.size} storage.`,
    description:
      'The new flagship Galaxy in four finishes, with a brighter display and faster charging than the S25.',
    tags: ['camera', 'everyday'],
    specs: { ram_gb: 12, storage_gb: variant.gb, display_size: '6.7 inch', use_case: 'Everyday, camera' },
  })),

  // --------------------------------------------------------- accessories
  {
    dir: 'Products/Controller/DualSense wireless controller',
    category: 'controllers',
    brand: 'Sony',
    name: 'DualSense Wireless Controller',
    sku: 'CFI-ZCT1W',
    price: 7999,
    mrp: null,
    stock: 20,
    short: 'Haptic feedback and adaptive triggers, on PC as well as PS5.',
    description:
      'Adaptive triggers that push back and haptics that do more than buzz. Works over USB or Bluetooth on a PC, which is why it pairs well with a gaming laptop.',
    tags: ['gaming', 'accessory'],
    // Category docs.txt: "A Accessories Brought with Gaming laptops."
    pairsWith: ['gaming-laptops'],
    specs: { connectivity: 'Bluetooth, USB-C', battery_hours: 12, use_case: 'Gaming' },
  },
  {
    dir: 'Products/IEMs/Sony IER Z1R',
    category: 'headphones',
    brand: 'Sony',
    name: 'IER-Z1R In-Ear Monitors',
    sku: 'IER-Z1R',
    price: 159990,
    mrp: null,
    stock: 4,
    short: 'Flagship in-ear monitors with a three-driver hybrid design.',
    description:
      'Sony’s flagship IEMs. A 5 mm dynamic driver, a 12 mm dynamic driver and a balanced armature per side, in a magnesium and zirconium housing.',
    tags: ['audio', 'audiophile', 'accessory'],
    // Category docs.txt: "Accessories for Phone and Laptops."
    pairsWith: ['smartphones', 'laptops'],
    specs: { type: 'In-ear monitor', driver: 'Hybrid 3-driver', connectivity: 'Wired 4.4 mm / 3.5 mm', use_case: 'Music, audiophile' },
  },
];

/* ------------------------------------------------------------------ run */

async function upload(key, bytes, contentType) {
  if (DRY || !r2) return PUBLIC ? `${PUBLIC}/${key}` : `/api/media/${key}`;
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return PUBLIC ? `${PUBLIC}/${key}` : `/api/media/${key}`;
}

/** base.* first, then colour shots in the order they appear on disk. */
async function imagesFor(dir) {
  const { readdir } = await import('node:fs/promises');
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const usable = files.filter((f) => MIME[f.toLowerCase().split('.').pop()]);
  const base = usable.filter((f) => f.toLowerCase().startsWith('base'));
  const rest = usable.filter((f) => !f.toLowerCase().startsWith('base')).sort();
  return [...base, ...rest].map((f) => ({ file: f, full: path.join(dir, f) }));
}

console.log(`${CATALOG.length} products to seed${DRY ? ' (dry run — nothing will be written)' : ''}\n`);

if (!DRY) {
  // Order history survives: order_items.product_id is ON DELETE SET NULL and
  // each line already carries its own snapshot of what was bought.
  const { count: before } = await db.from('products').select('*', { count: 'exact', head: true });
  console.log(`Removing ${before} demo products…`);
  await db.from('ai_recommendations').delete().not('product_id', 'is', null);
  await db.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  const { count: after } = await db.from('products').select('*', { count: 'exact', head: true });
  console.log(`  ${after} remaining\n`);
}

const { data: categories } = await db.from('categories').select('id, slug');
const categoryId = Object.fromEntries((categories ?? []).map((c) => [c.slug, c.id]));

let seeded = 0;
for (const item of CATALOG) {
  const slug = slugify(`${item.brand} ${item.name}`);
  const catId = categoryId[item.category];
  if (!catId) {
    console.log(`  SKIP  ${item.name} — no category "${item.category}"`);
    continue;
  }

  if (DRY) {
    const images = await imagesFor(item.dir);
    console.log(
      `  ${String(item.price).padStart(7)}  ${item.name.padEnd(34)} ${item.category.padEnd(16)} ${images.length} img`,
    );
    seeded++;
    continue;
  }

  const { data: product, error } = await db
    .from('products')
    .insert({
      category_id: catId,
      name: item.name,
      slug,
      brand: item.brand,
      sku: item.sku,
      description: item.description,
      short_description: item.short,
      price: item.price,
      compare_at_price: item.mrp,
      currency: 'INR',
      rating: 0,
      review_count: 0,
      is_featured: false,
      is_active: true,
      tags: item.tags ?? [],
      specs: item.specs ?? {},
    })
    .select('id')
    .single();

  if (error) {
    console.log(`  FAIL  ${item.name} — ${error.message}`);
    continue;
  }

  await db
    .from('inventory')
    .upsert({ product_id: product.id, quantity: item.stock, reserved_quantity: 0, low_stock_threshold: 3 },
      { onConflict: 'product_id' });

  const specRows = Object.entries(item.specs ?? {}).map(([key, value], index) => ({
    product_id: product.id,
    spec_key: key,
    display_label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    spec_value: String(value),
    spec_value_num: typeof value === 'number' ? value : null,
    sort_order: index,
  }));
  if (specRows.length) await db.from('product_specs').insert(specRows);

  const images = await imagesFor(item.dir);
  let order = 0;
  for (const image of images) {
    const ext = image.file.toLowerCase().split('.').pop();
    const bytes = await readFile(image.full);
    const key = `products/${product.id}/${order === 0 ? 'base' : slugify(image.file.replace(/\.[^.]+$/, ''))}.${ext}`;
    const url = await upload(key, bytes, MIME[ext]);

    await db.from('product_images').insert({
      product_id: product.id,
      r2_key: key,
      public_url: url,
      alt_text: `${item.brand} ${item.name}`,
      sort_order: order,
      is_primary: order === 0,
    });
    order++;
  }

  console.log(`  ok    ${item.name.padEnd(34)} ₹${item.price.toLocaleString('en-IN').padStart(9)}  ${images.length} img  stock ${item.stock}`);
  seeded++;
}

console.log(`\n${seeded} products seeded.`);
