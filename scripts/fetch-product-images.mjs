/**
 * Replaces the generated SVG placeholders with real product photography from
 * Wikimedia Commons, uploaded to R2.
 *
 *   node -r dotenv/config scripts/fetch-product-images.mjs dotenv_config_path=.env.local [--dry-run] [--only <fragment>]
 *
 * Commons is used because it is the one large image corpus that is both openly
 * licensed for reuse and reachable without an API key. Most of it is CC-BY /
 * CC-BY-SA, so author, licence and source page are recorded on every row
 * (migration 0008) — that credit is a licence condition, not a nicety.
 *
 * The picker is deliberately conservative: a product whose best candidate does
 * not clear MIN_SCORE keeps its placeholder. A neutral gradient is a better
 * shopping experience than a confidently wrong photograph.
 */
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const DRY_RUN = process.argv.includes('--dry-run');
const onlyIndex = process.argv.indexOf('--only');
const ONLY = onlyIndex > -1 ? process.argv[onlyIndex + 1] : null;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.R2_BUCKET_NAME ?? 'shopiq';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? '').replace(/\/+$/, '');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing Supabase credentials.');
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

if (!r2 && !DRY_RUN) {
  console.error('R2 is not configured — run with --dry-run to preview picks only.');
  process.exit(1);
}

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'ShopiQ/1.0 (https://shopiq.yashgarg.co.in; shopiq@yashgarg.co.in)';

/** Words that mark a file as not-a-product-photo. */
const BAD_TITLE =
  /logo|icon|vector|diagram|chart\b|map\b|screenshot|font|signature|coat.of.arms|flag|plaque|patent|graph|\(2160p|\(1080p|fps |kbit|timeline|infobox|barcode|qr.code|advert|poster|magazine|packaging|unboxing|retail box|1[89]\d\d/i;

/** A generic but honest search term per category, used as the last resort. */
const CATEGORY_TERM = {
  laptops: 'laptop computer',
  'gaming-laptops': 'gaming laptop computer',
  smartphones: 'smartphone',
  headphones: 'headphones',
  'gaming-headsets': 'gaming headset',
  keyboards: 'computer keyboard',
  mice: 'computer mouse',
  monitors: 'computer monitor display',
  controllers: 'game controller gamepad',
  'gaming-accessories': 'computer desk accessory',
  'home-accessories': 'household gadget',
  bags: 'backpack bag',
  shoes: 'sneaker shoe',
  't-shirts': 't-shirt',
  jackets: 'jacket',
};

/** Products whose literal name finds nothing useful; steer to the real article. */
const QUERY_HINTS = {
  'WH-1000XM6': ['Sony WH-1000XM5', 'Sony WH-1000XM4', 'Sony noise cancelling headphones'],
  'AirPods Pro 3': ['AirPods Pro 2', 'AirPods Pro'],
  'iPhone 16 128 GB': ['iPhone 16'],
  'Galaxy S25 128 GB': ['Samsung Galaxy S25'],
  'Galaxy A56 5G': ['Samsung Galaxy A55', 'Samsung Galaxy A series'],
  'MacBook Air 13-inch M4': ['MacBook Air M3', 'MacBook Air M2'],
  'MacBook Pro 14-inch M4 Pro': ['MacBook Pro 14-inch', 'MacBook Pro M3'],
  'DualSense Edge Wireless': ['DualSense controller'],
  'Pixel 9a': ['Google Pixel 9', 'Google Pixel 8a'],
  'OnePlus 13R': ['OnePlus 13', 'OnePlus smartphone'],
  'Ultraboost Light': ['Adidas Ultraboost'],
  'Pegasus 41 Running Shoes': ['Nike Air Zoom Pegasus'],
  'MX Keys S Wireless': ['Logitech MX Keys'],
  'G502 X Lightspeed': ['Logitech G502'],
  'DeathAdder V3 Pro': ['Razer DeathAdder'],
  'K8 Pro Wireless Mechanical': ['Keychron keyboard', 'mechanical keyboard'],
  'Cloud III Wired': ['HyperX Cloud headset'],
  'Arctis Nova 7 Wireless': ['SteelSeries Arctis'],
  'Sherpa Trucker Jacket': ['Levi denim trucker jacket', 'denim jacket'],
  'Ultra Light Down Jacket': ['Uniqlo down jacket', 'down jacket'],
  'Thermosteel Flask 1000 ml': ['vacuum flask thermos'],
  'Mi LED Desk Lamp 1S': ['LED desk lamp'],
  'PowerCore 20000 PD Power Bank': ['Anker power bank', 'power bank battery'],
  'Redmi Note 14 Pro+': ['Redmi Note 13', 'Xiaomi Redmi Note'],
  'Edge 60 Fusion': ['Motorola Edge', 'Motorola smartphone'],
  'UltraGear 27GS95QE OLED': ['LG UltraGear monitor', 'LG computer monitor'],
  'ViewFinity S6 34-inch Ultrawide': ['Samsung ultrawide monitor', 'ultrawide monitor'],
  'UltraSharp U2724D 27-inch': ['Dell UltraSharp monitor'],
  'Nitro VG240Y 24-inch 180Hz': ['Acer monitor'],
  'Huntsman V3 Pro TKL': ['Razer keyboard'],
  'Trident 35L Laptop Backpack': ['laptop backpack'],
  'Zork Sling Crossbody': ['sling bag crossbody'],
  'Laptop Sleeve 14-inch': ['laptop sleeve case'],
  'XL Desk Mousepad 900x400': ['desk mousepad'],
  '7-in-1 USB-C Docking Hub': ['USB-C hub dock'],
  'ROG 65W GaN Charger': ['USB-C charger power adapter'],
  'G8 Plus Mobile Gamepad': ['mobile gaming controller'],
  'Everyday Sneaker': ['white sneaker shoe'],
  'Softride Pro Trainer': ['Puma sneaker'],
  'Oversized Heavyweight Tee': ['plain t-shirt'],
  'Supima Cotton Crew Neck Tee': ['plain white t-shirt'],
  'Dri-FIT Training Tee': ['Nike t-shirt', 'sports t-shirt'],
  'Quechua MH500 Windproof Jacket': ['windproof hiking jacket'],
  'Wireless Silent Mouse 280M': ['HP wireless mouse'],
  'Max Plus Mechanical 104-key': ['mechanical keyboard'],
  'Airdopes 500 ANC': ['wireless earbuds'],
  'Rockerz 550 Over-Ear': ['over-ear headphones'],
  'Tune Beam 2 TWS': ['JBL earbuds', 'wireless earbuds'],
  'Accentum Plus Wireless': ['Sennheiser headphones'],
  'G335 Wired Gaming Headset': ['Logitech gaming headset'],
  'Swift Go 14 OLED': ['Acer Swift laptop'],
  'Zenbook 14 OLED (2025)': ['Asus Zenbook'],
  'TUF Gaming A15 (2025)': ['Asus TUF gaming laptop'],
  'ROG Zephyrus G14 (2025)': ['Asus ROG Zephyrus'],
  'Victus 15 RTX 4050': ['HP gaming laptop'],
  'Katana 15 RTX 4060': ['MSI gaming laptop'],
  'Legion Pro 5 16-inch': ['Lenovo Legion laptop'],
  'IdeaPad Slim 5 14-inch': ['Lenovo IdeaPad'],
  'Inspiron 15 Business': ['Dell Inspiron laptop'],
  'Pavilion Aero 13': ['HP Pavilion laptop'],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function commonsSearch(query, limit = 12) {
  const url = new URL(API);
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '1000',
  }).toString();

  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) return [];
  const json = await response.json();

  const strip = (html) =>
    html ? String(html).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : null;

  return Object.values(json?.query?.pages ?? {})
    .map((page) => {
      const info = page.imageinfo?.[0];
      if (!info) return null;
      const meta = info.extmetadata ?? {};
      return {
        title: String(page.title).replace(/^File:/, ''),
        width: info.width,
        height: info.height,
        mime: info.mime,
        thumb: info.thumburl,
        descriptionUrl: info.descriptionurl,
        artist: strip(meta.Artist?.value),
        license: strip(meta.LicenseShortName?.value),
      };
    })
    .filter(Boolean);
}

/**
 * The file title must name the KIND of thing being sold. Without this gate a
 * search for "HP Wireless Silent Mouse" happily returns an HP workstation
 * tower, because it matched the brand and nothing else.
 */
const TYPE_WORDS = {
  laptops:
    /laptop|notebook|macbook|zenbook|ideapad|thinkpad|inspiron|pavilion|swift|aero|ultrabook/i,
  'gaming-laptops': /laptop|notebook|legion|victus|katana|zephyrus|\btuf\b|nitro|omen|predator/i,
  smartphones: /phone|iphone|galaxy|pixel|redmi|oneplus|moto|xperia|handset/i,
  headphones: /headphone|earbud|earphone|airpod|headset|in-ear|over-ear|iem\b/i,
  'gaming-headsets': /headset|headphone|earcup/i,
  keyboards: /keyboard/i,
  mice: /\bmouse\b|\bmice\b/i,
  monitors: /monitor|display|\bscreen\b/i,
  controllers: /controller|gamepad|joypad|joystick|dualsense|dualshock|\bxbox\b/i,
  'gaming-accessories': /mousepad|mouse pad|desk mat|\bhub\b|dock|charger|adapter|\bgan\b/i,
  'home-accessories': /lamp|flask|thermos|power ?bank|battery|bottle|tumbler/i,
  bags: /backpack|\bbag\b|sleeve|\bcase\b|sling|rucksack|satchel/i,
  shoes: /\bshoe|sneaker|trainer|footwear|boot\b/i,
  't-shirts': /\btee\b|t-shirt|tshirt|\bshirt\b/i,
  jackets: /jacket|\bcoat\b|parka|anorak|windbreaker/i,
};

/**
 * A photograph of a shop, a crowd or a museum case is not product photography,
 * however well it scores on keywords.
 */
const SCENE =
  /\bshop\b|\bmall\b|\bstore\b|stadium|museum|zeum|collection|exhibition|\bfair\b|\bshow\b|booth|festival|concert|\bcrowd\b|conference|expo\b|display case|shelf|shelves|street|\broom\b|wearing|\bman\b|\bwoman\b|\bmen\b|\bwomen\b|\bboy\b|\bgirl\b|\bteam\b|\bplayer\b|\bmatch\b|\bissue\b|vintage/i;

/**
 * Products where the wrong variant is glaringly wrong to a shopper. A MacBook
 * Pro photo on the MacBook Air listing is not a near miss — they are different
 * products at different prices. The title must satisfy this pattern.
 */
const MUST_MATCH = {
  'MacBook Air 13-inch M4': /macbook air/i,
  'MacBook Pro 14-inch M4 Pro': /macbook pro/i,
  'iPhone 16 128 GB': /iphone\s*1[4-7]/i,
  'Galaxy S25 128 GB': /galaxy\s*s2[3-6]/i,
  'Galaxy A56 5G': /galaxy\s*a\d/i,
  'Pixel 9a': /pixel\s*[89]/i,
  'OnePlus 13R': /oneplus\s*1[123]/i,
  'Redmi Note 14 Pro+': /redmi\s*note/i,
  'Edge 60 Fusion': /moto|edge/i,
  'Nitro VG240Y 24-inch 180Hz': /nitro|predator|monitor/i,
  'UltraSharp U2724D 27-inch': /ultrasharp/i,
};

/**
 * Reviewed by eye on the contact sheet and rejected. Title-based filtering
 * cannot see what is actually in the frame: "LG UltraWide monitors.jpg" is a
 * trade-show booth with models, "Battery powered LED desk lamp…" is a bare
 * circuit board, and the Adidas hit was a band photo. These keep the
 * placeholder, and the script restores it if a previous run wrote a photo.
 */
const MANUAL_REJECT = new Set([
  'Nitro VG240Y 24-inch 180Hz',
  'Ultraboost Light',
  'ROG 65W GaN Charger',
  'Everyday Sneaker',
  'Inspiron 15 Business',
  'Pixel 9a',
  'Pavilion Aero 13',
  'Wireless Silent Mouse 280M',
  'IdeaPad Slim 5 14-inch',
  'Legion Pro 5 16-inch',
  'UltraGear 27GS95QE OLED',
  'MX Keys S Wireless',
  'G502 X Lightspeed',
  'Edge 60 Fusion',
  'Dri-FIT Training Tee',
  'Huntsman V3 Pro TKL',
  'Galaxy A56 5G',
  'Mi LED Desk Lamp 1S',
]);

/** Every brand in the catalogue — used to veto a competitor's product. */
const ALL_BRANDS = [];

/** Words in a model name that carry no identifying power. */
const WEAK_TOKEN =
  /^(the|and|inch|pro|plus|max|wireless|gaming|edition|series|light|slim|air|go|business|mobile|desk|over|ear|crew|neck|cotton|heavyweight|oversized|everyday|training|running|shoes|jacket|tee|bag|hub|charger|sleeve|wired|edge|note|key|keys)$/;

/**
 * How many distinctive tokens of the model name appear in the file title.
 * "3s", "g502", "deathadder", "zephyrus" identify a product; "pro" does not.
 */
function distinctiveHits(title, productName) {
  const tokens = productName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !WEAK_TOKEN.test(t))
    .filter((t) => /\d/.test(t) || t.length >= 5);
  return tokens.filter((t) => title.includes(t)).length;
}

/** Reject anything that is not a usable raster photograph of THIS product. */
function usable(candidate, product) {
  if (!/^image\/(jpeg|png|webp)$/.test(candidate.mime)) return false;
  if (!candidate.thumb) return false;
  if (candidate.width < 600 || candidate.height < 400) return false;
  const ratio = candidate.width / candidate.height;
  if (ratio < 0.55 || ratio > 2.2) return false;
  if (BAD_TITLE.test(candidate.title)) return false;
  if (SCENE.test(candidate.title)) return false;

  const title = candidate.title.toLowerCase();

  // Variant-critical products must name the right variant.
  const required = MUST_MATCH[product.name];
  if (required && !required.test(title)) return false;

  // Must look like the right kind of product — UNLESS the title already names
  // this exact model. "Logitech MX Master 3S HS03.jpg" is unmistakably the
  // right photo and never says the word "mouse"; a type gate alone throws it
  // away and settles for a generic Logitech m500 instead.
  const named =
    title.includes(product.brand.toLowerCase()) && distinctiveHits(title, product.name) >= 1;

  if (!named) {
    const typeWords = TYPE_WORDS[product.categorySlug];
    if (typeWords && !typeWords.test(title)) return false;
  }

  // Must not be a competitor's product. Showing a Bose headphone on a boAt
  // listing is worse than showing no photograph at all.
  const ownBrand = product.brand.toLowerCase();
  for (const brand of ALL_BRANDS) {
    if (brand === ownBrand) continue;
    if (ownBrand.includes(brand) || brand.includes(ownBrand)) continue;
    if (new RegExp(`\\b${brand.replace(/[^a-z0-9]/g, '.')}\\b`, 'i').test(title)) return false;
  }

  return true;
}

/** Higher is better. Rewards the brand and model tokens actually appearing. */
function scoreCandidate(candidate, product, queryRank) {
  let score = 40 - queryRank * 12; // earlier (more specific) queries win

  const title = candidate.title.toLowerCase();
  if (title.includes(product.brand.toLowerCase())) score += 25;

  const tokens = product.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^(the|and|inch|pro|plus|max|wireless|gaming)$/.test(t));
  const hits = tokens.filter((t) => title.includes(t)).length;
  score += Math.min(hits, 3) * 10;

  const ratio = candidate.width / candidate.height;
  if (ratio >= 0.85 && ratio <= 1.6) score += 10; // product-shot shaped
  if (candidate.width >= 1500) score += 5;

  return score;
}

const MIN_SCORE = 45;

function queriesFor(product) {
  const hints = QUERY_HINTS[product.name] ?? [];
  const generic = CATEGORY_TERM[product.categorySlug] ?? 'product';
  return [`${product.brand} ${product.name}`, ...hints, `${product.brand} ${generic}`, generic];
}

async function pickImage(product) {
  const queries = queriesFor(product);
  let best = null;

  for (let rank = 0; rank < queries.length; rank++) {
    const results = await commonsSearch(queries[rank]);
    await sleep(180); // be polite to the API

    for (const candidate of results) {
      if (!usable(candidate, product)) continue;
      const score = scoreCandidate(candidate, product, rank);
      if (!best || score > best.score) best = { ...candidate, score, query: queries[rank] };
    }
    if (best && best.score >= 75) break; // a strong specific match ends the search
  }

  return best && best.score >= MIN_SCORE ? best : null;
}

async function uploadToR2(productId, bytes, contentType) {
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const key = `products/${productId}/photo.${ext}`;
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return { key, url: R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : `/api/media/${key}` };
}

/**
 * Put a product back on its generated placeholder. The seed uploads
 * products/<id>/main.svg and this script never deletes that object, so
 * restoring is a matter of pointing the row back at it.
 */
async function restorePlaceholder(product) {
  const key = `products/${product.id}/main.svg`;
  const url = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : `/api/media/${key}`;

  const { data: existing } = await db
    .from('product_images')
    .select('r2_key')
    .eq('product_id', product.id);
  if (existing?.length === 1 && existing[0].r2_key === key) return; // already correct

  await db.from('product_images').delete().eq('product_id', product.id);
  const { error: restoreError } = await db.from('product_images').insert({
    product_id: product.id,
    r2_key: key,
    public_url: url,
    alt_text: `${product.brand} ${product.name}`,
    width: 800,
    height: 600,
    sort_order: 0,
    is_primary: true,
  });
  if (restoreError) console.log(`        restore failed: ${restoreError.message}`);
}

// ---------------------------------------------------------------------------

const { data: products, error } = await db
  .from('products')
  .select('id, brand, name, categories(slug)')
  .order('brand');

if (error) {
  console.error('Could not read products:', error.message);
  process.exit(1);
}

// Populate the competitor veto list from the catalogue itself, plus a few
// major brands we do not stock but whose products dominate image search.
ALL_BRANDS.push(
  ...new Set([
    ...products.map((p) => p.brand.toLowerCase()),
    'bose', 'jabra', 'beats', 'huawei', 'oppo', 'vivo', 'realme', 'nothing',
    'toshiba', 'fujitsu', 'gigabyte', 'corsair', 'cooler master', 'benq',
    'aoc', 'viewsonic', 'philips', 'nintendo', 'sega', 'reebok', 'asics',
    'new balance', 'converse', 'vans', 'skechers', 'fila',
    'north face', 'onitsuka', 'patagonia', 'columbia', 'jack wolfskin',
    'timberland', 'crocs', 'birkenstock', 'zara', 'gap', 'primark',
    'logitech revue', 'thermos', 'tupperware', 'ikea',
  ]),
);

const targets = products
  .map((p) => ({ id: p.id, brand: p.brand, name: p.name, categorySlug: p.categories.slug }))
  .filter((p) => !ONLY || `${p.brand} ${p.name}`.toLowerCase().includes(ONLY.toLowerCase()));

console.log(`${targets.length} products${DRY_RUN ? ' (dry run — nothing will be written)' : ''}\n`);

let matched = 0;
const skippedNames = [];

for (const product of targets) {
  const label = `${product.brand} ${product.name}`.padEnd(46);

  if (MANUAL_REJECT.has(product.name)) {
    console.log(`  rej   ${label} (rejected on review — placeholder restored)`);
    skippedNames.push(`${product.brand} ${product.name}`);
    if (!DRY_RUN) await restorePlaceholder(product);
    continue;
  }

  let pick;
  try {
    pick = await pickImage(product);
  } catch (err) {
    console.log(`  ERR   ${label} ${err.message}`);
    skippedNames.push(`${product.brand} ${product.name}`);
    continue;
  }

  if (!pick) {
    console.log(`  keep  ${label} (no confident match — placeholder retained)`);
    skippedNames.push(`${product.brand} ${product.name}`);
    continue;
  }

  console.log(`  ${String(pick.score).padStart(3)}   ${label} ${pick.title.slice(0, 58)}`);

  if (DRY_RUN) {
    matched++;
    continue;
  }

  const imageResponse = await fetch(pick.thumb, { headers: { 'User-Agent': UA } });
  if (!imageResponse.ok) {
    console.log(`        download failed (${imageResponse.status}) — placeholder retained`);
    skippedNames.push(`${product.brand} ${product.name}`);
    continue;
  }
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  const contentType = imageResponse.headers.get('content-type') ?? 'image/jpeg';
  const uploaded = await uploadToR2(product.id, bytes, contentType);

  // Replace the placeholder row so exactly one primary image remains.
  await db.from('product_images').delete().eq('product_id', product.id);
  const scaledWidth = Math.min(pick.width, 1000);
  const { error: insertError } = await db.from('product_images').insert({
    product_id: product.id,
    r2_key: uploaded.key,
    public_url: uploaded.url,
    alt_text: `${product.brand} ${product.name}`,
    width: scaledWidth,
    height: Math.round((scaledWidth / pick.width) * pick.height),
    sort_order: 0,
    is_primary: true,
    attribution: pick.artist,
    license: pick.license,
    source_url: pick.descriptionUrl,
  });
  if (insertError) {
    console.log(`        DB insert failed: ${insertError.message}`);
    skippedNames.push(`${product.brand} ${product.name}`);
    continue;
  }
  matched++;
}

console.log(`\n${matched} matched, ${skippedNames.length} kept their placeholder`);
if (skippedNames.length) {
  console.log('\nStill on placeholders:');
  for (const name of skippedNames) console.log(`  · ${name}`);
}
