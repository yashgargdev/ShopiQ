/**
 * Build the ShopiQ demo catalogue.
 *
 *   node scripts/build-demo-catalog.mjs
 *
 * Writes data/catalog/catalog.json against data/catalog/schema.json.
 *
 * The catalogue is GENERATED rather than hand-written because most of it is
 * one product repeated at different capacities. Writing 121 objects by hand
 * guarantees the 40th one has a spec key the other 39 do not, and nothing
 * would report it — a family is declared once here and its configurations are
 * expanded mechanically, so they cannot drift apart.
 *
 * DEMO DATA. Prices, specs and ratings are plausible and invented. They are
 * not scraped, not sourced from any retailer, and must not be presented as
 * real product information. Images are the supplied ShopiQ CDN assets and are
 * deliberately reused across products.
 */
import fs from 'node:fs';
import path from 'node:path';

const CDN = 'https://cdn.shopiq.yashgarg.co.in/prod-img';

/**
 * The supplied demo images. Reuse across products is intentional and
 * sanctioned — no image is invented, scraped, or guessed at.
 */
const IMG = {
  iphone: `${CDN}/IPhone%2016/Pink.webp`,
  macbook: `${CDN}/macbook/base.webp`,
  samsung: `${CDN}/Samsung/Titanium%20Gray.webp`,
  laptop: `${CDN}/laptop/base.webp`,
  ps5: `${CDN}/DualSense/ps5/esq240112-digital-ecomm-playstationps5-0305-679133a09328d.avif`,
  dualsense: `${CDN}/DualSense/33668_1.webp`,
  iem: `${CDN}/IEMs/base.webp`,
  keyboard: `${CDN}/Frame_1000009259.webp`,
  mouse: `${CDN}/Frame1000008117.webp`,
  monitor: `${CDN}/images.jpg`,
  headphones: `${CDN}/262565_0_cMTz4dVUv.webp`,
  phoneCharger: `${CDN}/shopping.webp`,
  laptopCharger: `${CDN}/51GvWC7uAtL._AC_UF1000%2C1000_QL80_.jpg`,
};

const products = [];
const slugify = (value) =>
  String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const gb = (n) => (n >= 1024 ? `${n / 1024}TB` : `${n}GB`);

/**
 * Declare one product.
 *
 * Everything optional is omitted rather than defaulted to a guess: a product
 * with no performance judgement should carry none, so the ranker treats it as
 * unrated instead of mediocre.
 */
function push(entry) {
  const id = entry.id;
  if (products.some((p) => p.id === id)) throw new Error(`duplicate id: ${id}`);
  if (products.some((p) => p.sku === entry.sku)) throw new Error(`duplicate sku: ${entry.sku}`);
  products.push({
    id,
    ...(entry.product_family ? { product_family: entry.product_family } : {}),
    name: entry.name,
    brand: entry.brand,
    category: entry.category,
    ...(entry.segments ? { segments: entry.segments } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.short_description ? { short_description: entry.short_description } : {}),
    ...(entry.configuration ? { configuration: entry.configuration } : {}),
    pricing: { mrp: entry.mrp, selling_price: entry.price, currency: 'INR' },
    sku: entry.sku,
    inventory: { quantity: entry.stock },
    ...(entry.specifications ? { specifications: entry.specifications } : {}),
    ...(entry.performance ? { performance: entry.performance } : {}),
    ...(entry.use_cases ? { use_cases: entry.use_cases } : {}),
    ...(entry.tags ? { tags: entry.tags } : {}),
    ...(entry.compatibility ? { compatibility: entry.compatibility } : {}),
    ...(entry.relationships ? { relationships: entry.relationships } : {}),
    images: [{ url: entry.image, alt: `${entry.brand} ${entry.name}`, is_primary: true }],
    ...(entry.recommendation_profile ? { recommendation_profile: entry.recommendation_profile } : {}),
  });
}

/* ------------------------------------------------------------------ phones */

/**
 * A phone family, expanded across its storage configurations.
 *
 * Price steps by capacity rather than being restated per row, so a family
 * cannot end up with a 512 GB model cheaper than its 256 GB sibling.
 */
function phoneFamily(base, configs) {
  for (const config of configs) {
    const label = `${config.ram}GB ${gb(config.storage)}`;
    push({
      id: `${base.family}-${config.ram}-${config.storage}`,
      product_family: base.family,
      name: `${base.name} ${label}`,
      brand: base.brand,
      category: 'smartphones',
      segments: base.segments,
      short_description: base.short,
      configuration: { ram_gb: config.ram, storage_gb: config.storage },
      price: config.price,
      mrp: config.mrp ?? Math.round(config.price * 1.15),
      sku: `${base.sku}-${config.ram}-${config.storage}`,
      stock: config.stock ?? base.stock ?? 20,
      specifications: { ...base.specs, ram_gb: config.ram, storage_gb: config.storage },
      performance: base.performance,
      use_cases: base.use_cases,
      tags: base.tags,
      compatibility: {
        platform: 'mobile',
        attributes: { connector: base.connector ?? 'USB-C' },
        compatible_accessory_types: ['phone_case', 'screen_protector', 'charger', 'earbuds'],
      },
      image: base.image,
    });
  }
}

const applePhoneSpecs = {
  display_type: 'Super Retina XDR OLED',
  panel_type: 'OLED',
  operating_system: 'iOS',
  water_resistance: 'IP68',
  connector: 'USB-C',
};

phoneFamily(
  {
    family: 'iphone-16', name: 'Apple iPhone 16', brand: 'Apple', sku: 'APPLE-IP16',
    segments: ['flagship', 'camera'], image: IMG.iphone, stock: 50,
    short: 'The everyday iPhone, with Camera Control and the Action button.',
    specs: { ...applePhoneSpecs, display_size_in: 6.1, refresh_rate_hz: 60, processor: 'Apple A18',
      camera_mp: 48, battery_mah: 3561, charging_w: 20, weight_kg: 0.17 },
    performance: { photography: 9, gaming: 8, battery: 7, display_quality: 8, portability: 9, value: 7 },
    use_cases: ['photography', 'daily_use', 'gaming', 'calls'],
    tags: ['apple', 'flagship', 'ios', 'usb-c'],
  },
  [
    { ram: 8, storage: 128, price: 74900, mrp: 79900 },
    { ram: 8, storage: 256, price: 84900, mrp: 89900 },
    { ram: 8, storage: 512, price: 104900, mrp: 109900, stock: 10 },
  ],
);

phoneFamily(
  {
    family: 'iphone-17', name: 'Apple iPhone 17', brand: 'Apple', sku: 'APPLE-IP17',
    segments: ['flagship', 'camera'], image: IMG.iphone, stock: 40,
    short: 'The current standard iPhone, with a brighter 120 Hz display.',
    specs: { ...applePhoneSpecs, display_size_in: 6.3, refresh_rate_hz: 120, processor: 'Apple A19',
      camera_mp: 48, battery_mah: 3700, charging_w: 25, weight_kg: 0.177 },
    performance: { photography: 9, gaming: 9, battery: 8, display_quality: 9, portability: 9, value: 7 },
    use_cases: ['photography', 'daily_use', 'gaming', 'calls', 'content_creation'],
    tags: ['apple', 'flagship', 'ios', '120hz'],
  },
  [
    { ram: 8, storage: 256, price: 82900, mrp: 89900 },
    { ram: 8, storage: 512, price: 102900, mrp: 109900 },
  ],
);

phoneFamily(
  {
    family: 'iphone-17-pro', name: 'Apple iPhone 17 Pro', brand: 'Apple', sku: 'APPLE-IP17P',
    segments: ['flagship', 'camera'], image: IMG.iphone, stock: 15,
    short: 'The professional iPhone, with a telephoto camera and ProMotion.',
    specs: { ...applePhoneSpecs, display_size_in: 6.3, refresh_rate_hz: 120, processor: 'Apple A19 Pro',
      camera_mp: 48, battery_mah: 3900, charging_w: 30, weight_kg: 0.199 },
    performance: { photography: 10, gaming: 10, battery: 8, display_quality: 10, portability: 8, value: 6 },
    use_cases: ['photography', 'video_editing', 'gaming', 'professional', 'content_creation'],
    tags: ['apple', 'flagship', 'ios', 'pro', '120hz'],
  },
  [
    { ram: 12, storage: 256, price: 134900, mrp: 139900 },
    { ram: 12, storage: 512, price: 154900, mrp: 159900, stock: 8 },
  ],
);

const samsungSpecs = {
  panel_type: 'OLED', operating_system: 'Android', water_resistance: 'IP68', connector: 'USB-C',
  display_type: 'Dynamic AMOLED 2X',
};

phoneFamily(
  {
    family: 'galaxy-s25', name: 'Samsung Galaxy S25', brand: 'Samsung', sku: 'SAMSUNG-S25',
    segments: ['flagship', 'camera'], image: IMG.samsung, stock: 35,
    short: 'Compact Samsung flagship with a 120 Hz AMOLED display.',
    specs: { ...samsungSpecs, display_size_in: 6.2, refresh_rate_hz: 120, processor: 'Snapdragon 8 Elite',
      camera_mp: 50, battery_mah: 4000, charging_w: 25, weight_kg: 0.162 },
    performance: { photography: 9, gaming: 9, battery: 7, display_quality: 9, portability: 9, value: 7 },
    use_cases: ['photography', 'daily_use', 'gaming', 'calls'],
    tags: ['samsung', 'android', 'flagship', '120hz'],
  },
  [
    { ram: 12, storage: 256, price: 69999, mrp: 80999 },
    { ram: 12, storage: 512, price: 79999, mrp: 92999 },
  ],
);

phoneFamily(
  {
    family: 'galaxy-s25-ultra', name: 'Samsung Galaxy S25 Ultra', brand: 'Samsung', sku: 'SAMSUNG-S25U',
    segments: ['flagship', 'camera'], image: IMG.samsung, stock: 12,
    short: 'The big Samsung flagship, with the S Pen and a 200 MP camera.',
    specs: { ...samsungSpecs, display_size_in: 6.9, refresh_rate_hz: 120, processor: 'Snapdragon 8 Elite',
      camera_mp: 200, battery_mah: 5000, charging_w: 45, weight_kg: 0.218 },
    performance: { photography: 10, gaming: 10, battery: 9, display_quality: 10, portability: 6, value: 6 },
    use_cases: ['photography', 'video_editing', 'professional', 'gaming', 'content_creation'],
    tags: ['samsung', 'android', 'flagship', 'spen', '200mp'],
  },
  [
    { ram: 12, storage: 256, price: 119999, mrp: 129999 },
    { ram: 12, storage: 512, price: 129999, mrp: 141999, stock: 6 },
  ],
);

phoneFamily(
  {
    family: 'galaxy-s26', name: 'Samsung Galaxy S26', brand: 'Samsung', sku: 'SAMSUNG-S26',
    segments: ['flagship', 'camera'], image: IMG.samsung, stock: 25,
    short: 'The new Galaxy S, with faster charging than the S25.',
    specs: { ...samsungSpecs, display_size_in: 6.7, refresh_rate_hz: 120, processor: 'Snapdragon 8 Elite Gen 2',
      camera_mp: 50, battery_mah: 4900, charging_w: 45, weight_kg: 0.19 },
    performance: { photography: 9, gaming: 9, battery: 9, display_quality: 9, portability: 8, value: 7 },
    use_cases: ['photography', 'daily_use', 'gaming', 'content_creation'],
    tags: ['samsung', 'android', 'flagship', '120hz'],
  },
  [
    { ram: 12, storage: 256, price: 79999, mrp: 89999 },
    { ram: 12, storage: 512, price: 99999, mrp: 109999 },
  ],
);

phoneFamily(
  {
    family: 'nothing-phone-3a', name: 'Nothing Phone (3a)', brand: 'Nothing', sku: 'NOTHING-P3A',
    segments: ['mid_range', 'camera'], image: IMG.samsung, stock: 30,
    short: 'Mid-range Android with the Glyph interface.',
    specs: { panel_type: 'AMOLED', operating_system: 'Android', water_resistance: 'IP64',
      connector: 'USB-C', display_size_in: 6.77, refresh_rate_hz: 120, processor: 'Snapdragon 7s Gen 3',
      camera_mp: 50, battery_mah: 5000, charging_w: 50, weight_kg: 0.201 },
    performance: { photography: 7, gaming: 6, battery: 8, display_quality: 8, portability: 7, value: 9 },
    use_cases: ['daily_use', 'photography', 'calls'],
    tags: ['nothing', 'android', 'value', '120hz'],
  },
  [
    { ram: 8, storage: 128, price: 24999, mrp: 27999 },
    { ram: 12, storage: 256, price: 29999, mrp: 32999 },
  ],
);

phoneFamily(
  {
    family: 'pixel-9a', name: 'Google Pixel 9a', brand: 'Google', sku: 'GOOGLE-P9A',
    segments: ['mid_range', 'camera'], image: IMG.samsung, stock: 22,
    short: 'Google mid-ranger with the Pixel camera pipeline.',
    specs: { panel_type: 'OLED', operating_system: 'Android', water_resistance: 'IP68',
      connector: 'USB-C', display_size_in: 6.3, refresh_rate_hz: 120, processor: 'Google Tensor G4',
      camera_mp: 48, battery_mah: 5100, charging_w: 23, weight_kg: 0.186 },
    performance: { photography: 9, gaming: 6, battery: 8, display_quality: 8, portability: 8, value: 9 },
    use_cases: ['photography', 'daily_use', 'calls'],
    tags: ['google', 'android', 'camera', 'value'],
  },
  [
    { ram: 8, storage: 128, price: 49999, mrp: 54999 },
    { ram: 8, storage: 256, price: 55999, mrp: 60999 },
  ],
);

phoneFamily(
  {
    family: 'oneplus-13r', name: 'OnePlus 13R', brand: 'OnePlus', sku: 'ONEPLUS-13R',
    segments: ['upper_mid_range', 'gaming'], image: IMG.samsung, stock: 18,
    short: 'Fast Android with a large battery, tuned for gaming.',
    specs: { panel_type: 'AMOLED', operating_system: 'Android', water_resistance: 'IP65',
      connector: 'USB-C', display_size_in: 6.78, refresh_rate_hz: 120, processor: 'Snapdragon 8 Gen 3',
      camera_mp: 50, battery_mah: 6000, charging_w: 80, weight_kg: 0.206 },
    performance: { photography: 8, gaming: 9, battery: 10, display_quality: 9, portability: 7, value: 9 },
    use_cases: ['gaming', 'daily_use', 'photography'],
    tags: ['oneplus', 'android', 'gaming', 'fast-charging'],
  },
  [
    { ram: 12, storage: 256, price: 42999, mrp: 47999 },
    { ram: 16, storage: 512, price: 49999, mrp: 54999 },
  ],
);

phoneFamily(
  {
    family: 'xiaomi-14', name: 'Xiaomi 14', brand: 'Xiaomi', sku: 'XIAOMI-14',
    segments: ['upper_mid_range', 'camera'], image: IMG.samsung, stock: 16,
    short: 'Compact Xiaomi flagship with Leica-tuned cameras.',
    specs: { panel_type: 'AMOLED', operating_system: 'Android', water_resistance: 'IP68',
      connector: 'USB-C', display_size_in: 6.36, refresh_rate_hz: 120, processor: 'Snapdragon 8 Gen 3',
      camera_mp: 50, battery_mah: 4610, charging_w: 90, weight_kg: 0.193 },
    performance: { photography: 9, gaming: 9, battery: 8, display_quality: 9, portability: 9, value: 8 },
    use_cases: ['photography', 'gaming', 'daily_use'],
    tags: ['xiaomi', 'android', 'camera', 'fast-charging'],
  },
  [
    { ram: 12, storage: 256, price: 54999, mrp: 69999 },
    { ram: 12, storage: 512, price: 59999, mrp: 74999 },
  ],
);

phoneFamily(
  {
    family: 'oppo-reno-13', name: 'OPPO Reno 13', brand: 'OPPO', sku: 'OPPO-R13',
    segments: ['mid_range', 'camera'], image: IMG.samsung, stock: 20,
    short: 'Slim mid-range phone with a strong selfie camera.',
    specs: { panel_type: 'AMOLED', operating_system: 'Android', water_resistance: 'IP66',
      connector: 'USB-C', display_size_in: 6.59, refresh_rate_hz: 120, processor: 'Dimensity 8350',
      camera_mp: 50, battery_mah: 5600, charging_w: 80, weight_kg: 0.181 },
    performance: { photography: 8, gaming: 7, battery: 9, display_quality: 8, portability: 8, value: 8 },
    use_cases: ['photography', 'daily_use', 'calls'],
    tags: ['oppo', 'android', 'value'],
  },
  [{ ram: 8, storage: 256, price: 32999, mrp: 37999 }],
);

/* ----------------------------------------------------------------- laptops */

function laptopFamily(base, configs) {
  for (const config of configs) {
    const label = `${config.ram}GB ${gb(config.storage)}`;
    push({
      id: `${base.family}-${config.ram}-${config.storage}`,
      product_family: base.family,
      name: `${base.name} ${label}`,
      brand: base.brand,
      category: base.category ?? 'laptops',
      segments: base.segments,
      short_description: base.short,
      configuration: { ram_gb: config.ram, storage_gb: config.storage },
      price: config.price,
      mrp: config.mrp ?? Math.round(config.price * 1.2),
      sku: `${base.sku}-${config.ram}-${config.storage}`,
      stock: config.stock ?? base.stock ?? 15,
      specifications: {
        ...base.specs, ram_gb: config.ram, storage_gb: config.storage, storage_type: 'SSD',
      },
      performance: base.performance,
      use_cases: base.use_cases,
      tags: base.tags,
      compatibility: {
        platform: 'laptop',
        attributes: { connector: base.connector ?? 'USB-C' },
        compatible_accessory_types: base.accessories ?? [
          'laptop_sleeve', 'laptop_bag', 'usb_c_hub', 'wireless_mouse', 'external_ssd', 'charger',
        ],
      },
      image: base.image,
    });
  }
}

laptopFamily(
  {
    family: 'macbook-air', name: 'Apple MacBook Air M4', brand: 'Apple', sku: 'APPLE-MBA-M4',
    segments: ['ultraportable', 'student', 'business'], image: IMG.macbook, stock: 20,
    short: 'Fanless, light, and quiet. The default choice for writing and study.',
    specs: { processor: 'Apple M4', gpu: 'Apple M4 10-core GPU', display_size_in: 13.6,
      resolution: 'QHD', refresh_rate_hz: 60, panel_type: 'IPS', battery_wh: 53.8,
      weight_kg: 1.24, operating_system: 'macOS' },
    performance: { gaming: 4, programming: 9, office: 10, content_creation: 8, portability: 10, battery: 10, value: 7 },
    use_cases: ['programming', 'office', 'college', 'travel', 'productivity'],
    tags: ['apple', 'macos', 'portable', 'premium'],
    accessories: ['laptop_sleeve', 'usb_c_hub', 'wireless_mouse', 'external_ssd', 'charger'],
  },
  [
    { ram: 16, storage: 256, price: 99900, mrp: 114900 },
    { ram: 16, storage: 512, price: 119900, mrp: 134900 },
    { ram: 24, storage: 512, price: 139900, mrp: 154900, stock: 8 },
  ],
);

laptopFamily(
  {
    family: 'macbook-pro', name: 'Apple MacBook Pro M4 Pro', brand: 'Apple', sku: 'APPLE-MBP-M4P',
    segments: ['creator', 'business', 'performance'], image: IMG.macbook, stock: 10,
    short: 'For sustained work: video, compiling, and anything that runs for hours.',
    specs: { processor: 'Apple M4 Pro', gpu: 'Apple M4 Pro 16-core GPU', display_size_in: 14.2,
      resolution: 'QHD', refresh_rate_hz: 120, panel_type: 'Mini-LED', battery_wh: 72.4,
      weight_kg: 1.55, operating_system: 'macOS' },
    performance: { gaming: 6, programming: 10, office: 10, content_creation: 10, portability: 8, battery: 9, value: 6 },
    use_cases: ['programming', 'video_editing', 'content_creation', 'professional'],
    tags: ['apple', 'macos', 'creator', 'premium'],
    accessories: ['laptop_sleeve', 'usb_c_hub', 'wireless_mouse', 'external_ssd', 'charger'],
  },
  [
    { ram: 24, storage: 512, price: 199900, mrp: 219900 },
    { ram: 24, storage: 1024, price: 219900, mrp: 239900 },
    { ram: 48, storage: 1024, price: 289900, mrp: 309900, stock: 4 },
  ],
);

laptopFamily(
  {
    family: 'asus-tuf-a15', name: 'ASUS TUF Gaming A15', brand: 'ASUS', sku: 'ASUS-TUF-A15',
    category: 'gaming-laptops', segments: ['gaming', 'performance'], image: IMG.laptop, stock: 18,
    short: 'Durable mainstream gaming laptop with a 144 Hz panel.',
    specs: { processor: 'AMD Ryzen 7 7435HS', gpu: 'NVIDIA RTX 4060 8GB', vram_gb: 8,
      display_size_in: 15.6, resolution: 'FHD', refresh_rate_hz: 144, panel_type: 'IPS',
      battery_wh: 90, weight_kg: 2.2, operating_system: 'Windows 11' },
    performance: { gaming: 9, programming: 8, office: 8, content_creation: 8, portability: 4, battery: 5, value: 9 },
    use_cases: ['gaming', 'programming', 'content_creation', 'college'],
    tags: ['gaming', 'rtx', 'asus', '144hz'],
    accessories: ['gaming_mouse', 'gaming_headset', 'cooling_pad', 'laptop_sleeve', 'laptop_bag'],
  },
  [
    { ram: 8, storage: 512, price: 64999, mrp: 79999 },
    { ram: 16, storage: 512, price: 74999, mrp: 89999 },
    { ram: 16, storage: 1024, price: 84999, mrp: 99999 },
  ],
);

laptopFamily(
  {
    family: 'asus-rog-strix', name: 'ASUS ROG Strix G16', brand: 'ASUS', sku: 'ASUS-ROG-G16',
    category: 'gaming-laptops', segments: ['gaming', 'performance'], image: IMG.laptop, stock: 8,
    short: 'High-refresh gaming laptop for competitive play.',
    specs: { processor: 'Intel Core i7-13650HX', gpu: 'NVIDIA RTX 4070 8GB', vram_gb: 8,
      display_size_in: 16, resolution: 'QHD', refresh_rate_hz: 240, panel_type: 'IPS',
      battery_wh: 90, weight_kg: 2.5, operating_system: 'Windows 11' },
    performance: { gaming: 10, programming: 9, office: 8, content_creation: 9, portability: 3, battery: 4, value: 7 },
    use_cases: ['gaming', 'content_creation', 'video_editing'],
    tags: ['gaming', 'rtx', 'asus', '240hz', 'premium'],
    accessories: ['gaming_mouse', 'gaming_headset', 'cooling_pad', 'laptop_bag'],
  },
  [
    { ram: 16, storage: 1024, price: 134999, mrp: 159999 },
    { ram: 32, storage: 1024, price: 154999, mrp: 179999, stock: 5 },
  ],
);

laptopFamily(
  {
    family: 'asus-vivobook-15', name: 'ASUS Vivobook 15', brand: 'ASUS', sku: 'ASUS-VIVO-15',
    segments: ['student', 'budget', 'business'], image: IMG.laptop, stock: 40,
    short: 'Everyday laptop for coursework, browsing and documents.',
    specs: { processor: 'Intel Core i5-1335U', gpu: 'Intel Iris Xe', display_size_in: 15.6,
      resolution: 'FHD', refresh_rate_hz: 60, panel_type: 'IPS', battery_wh: 42,
      weight_kg: 1.7, operating_system: 'Windows 11' },
    performance: { gaming: 3, programming: 6, office: 8, content_creation: 5, portability: 7, battery: 6, value: 9 },
    use_cases: ['office', 'college', 'daily_use', 'productivity'],
    tags: ['budget', 'student', 'asus'],
  },
  [
    { ram: 8, storage: 512, price: 42999, mrp: 54999 },
    { ram: 16, storage: 512, price: 51999, mrp: 63999 },
  ],
);

laptopFamily(
  {
    family: 'hp-victus-15', name: 'HP Victus 15', brand: 'HP', sku: 'HP-VICTUS-15',
    category: 'gaming-laptops', segments: ['gaming', 'budget'], image: IMG.laptop, stock: 22,
    short: 'Entry gaming laptop that doubles as a study machine.',
    specs: { processor: 'AMD Ryzen 5 7535HS', gpu: 'NVIDIA RTX 3050 6GB', vram_gb: 6,
      display_size_in: 15.6, resolution: 'FHD', refresh_rate_hz: 144, panel_type: 'IPS',
      battery_wh: 52.5, weight_kg: 2.29, operating_system: 'Windows 11' },
    performance: { gaming: 7, programming: 7, office: 8, content_creation: 6, portability: 4, battery: 5, value: 9 },
    use_cases: ['gaming', 'college', 'programming'],
    tags: ['gaming', 'budget', 'hp', '144hz'],
    accessories: ['gaming_mouse', 'gaming_headset', 'cooling_pad', 'laptop_sleeve'],
  },
  [
    { ram: 8, storage: 512, price: 52999, mrp: 66999 },
    { ram: 16, storage: 512, price: 59999, mrp: 74999 },
  ],
);

laptopFamily(
  {
    family: 'hp-pavilion-14', name: 'HP Pavilion 14', brand: 'HP', sku: 'HP-PAV-14',
    segments: ['student', 'business', 'budget'], image: IMG.laptop, stock: 28,
    short: 'Compact all-rounder for office work and study.',
    specs: { processor: 'Intel Core i5-1340P', gpu: 'Intel Iris Xe', display_size_in: 14,
      resolution: 'FHD', refresh_rate_hz: 60, panel_type: 'IPS', battery_wh: 51,
      weight_kg: 1.41, operating_system: 'Windows 11' },
    performance: { gaming: 3, programming: 7, office: 9, content_creation: 5, portability: 8, battery: 8, value: 8 },
    use_cases: ['office', 'programming', 'college', 'travel'],
    tags: ['student', 'portable', 'hp'],
  },
  [
    { ram: 8, storage: 512, price: 48999, mrp: 61999 },
    { ram: 16, storage: 1024, price: 62999, mrp: 76999 },
  ],
);

laptopFamily(
  {
    family: 'dell-inspiron-15', name: 'Dell Inspiron 15', brand: 'Dell', sku: 'DELL-INSP-15',
    segments: ['student', 'budget', 'business'], image: IMG.laptop, stock: 30,
    short: 'Straightforward everyday laptop with a full-size keyboard.',
    specs: { processor: 'Intel Core i5-1334U', gpu: 'Intel UHD', display_size_in: 15.6,
      resolution: 'FHD', refresh_rate_hz: 60, panel_type: 'IPS', battery_wh: 54,
      weight_kg: 1.65, operating_system: 'Windows 11' },
    performance: { gaming: 2, programming: 6, office: 8, content_creation: 4, portability: 7, battery: 7, value: 9 },
    use_cases: ['office', 'college', 'daily_use'],
    tags: ['budget', 'student', 'dell'],
  },
  [
    { ram: 8, storage: 512, price: 39999, mrp: 52999 },
    { ram: 16, storage: 512, price: 47999, mrp: 60999 },
  ],
);

laptopFamily(
  {
    family: 'dell-xps-13', name: 'Dell XPS 13', brand: 'Dell', sku: 'DELL-XPS-13',
    segments: ['ultraportable', 'premium', 'business'], image: IMG.laptop, stock: 9,
    short: 'Premium thin-and-light with an excellent display.',
    specs: { processor: 'Intel Core Ultra 7 155H', gpu: 'Intel Arc', display_size_in: 13.4,
      resolution: 'QHD', refresh_rate_hz: 120, panel_type: 'OLED', battery_wh: 55,
      weight_kg: 1.19, operating_system: 'Windows 11' },
    performance: { gaming: 4, programming: 9, office: 10, content_creation: 8, portability: 10, battery: 9, value: 6 },
    use_cases: ['programming', 'office', 'travel', 'professional'],
    tags: ['premium', 'portable', 'dell', 'oled'],
    accessories: ['laptop_sleeve', 'usb_c_hub', 'wireless_mouse', 'charger'],
  },
  [
    { ram: 16, storage: 512, price: 134999, mrp: 154999 },
    { ram: 32, storage: 1024, price: 164999, mrp: 184999, stock: 4 },
  ],
);

laptopFamily(
  {
    family: 'lenovo-loq-15', name: 'Lenovo LOQ 15', brand: 'Lenovo', sku: 'LENOVO-LOQ-15',
    category: 'gaming-laptops', segments: ['gaming', 'budget'], image: IMG.laptop, stock: 24,
    short: 'Value gaming laptop with a bright 144 Hz screen.',
    specs: { processor: 'Intel Core i5-12450HX', gpu: 'NVIDIA RTX 4050 6GB', vram_gb: 6,
      display_size_in: 15.6, resolution: 'FHD', refresh_rate_hz: 144, panel_type: 'IPS',
      battery_wh: 60, weight_kg: 2.38, operating_system: 'Windows 11' },
    performance: { gaming: 8, programming: 8, office: 8, content_creation: 7, portability: 4, battery: 5, value: 9 },
    use_cases: ['gaming', 'programming', 'college'],
    tags: ['gaming', 'value', 'lenovo', '144hz'],
    accessories: ['gaming_mouse', 'gaming_headset', 'cooling_pad', 'laptop_sleeve'],
  },
  [
    { ram: 12, storage: 512, price: 57999, mrp: 72999 },
    { ram: 16, storage: 512, price: 63999, mrp: 79999 },
  ],
);

laptopFamily(
  {
    family: 'lenovo-legion-5', name: 'Lenovo Legion 5', brand: 'Lenovo', sku: 'LENOVO-LEG-5',
    category: 'gaming-laptops', segments: ['gaming', 'performance'], image: IMG.laptop, stock: 10,
    short: 'Serious gaming laptop with strong cooling.',
    specs: { processor: 'AMD Ryzen 7 7840HS', gpu: 'NVIDIA RTX 4060 8GB', vram_gb: 8,
      display_size_in: 16, resolution: 'QHD', refresh_rate_hz: 165, panel_type: 'IPS',
      battery_wh: 80, weight_kg: 2.4, operating_system: 'Windows 11' },
    performance: { gaming: 9, programming: 9, office: 8, content_creation: 9, portability: 4, battery: 6, value: 8 },
    use_cases: ['gaming', 'content_creation', 'programming'],
    tags: ['gaming', 'rtx', 'lenovo', '165hz'],
    accessories: ['gaming_mouse', 'gaming_headset', 'cooling_pad', 'laptop_bag'],
  },
  [
    { ram: 16, storage: 512, price: 94999, mrp: 114999 },
    { ram: 32, storage: 1024, price: 114999, mrp: 134999, stock: 5 },
  ],
);

laptopFamily(
  {
    family: 'lenovo-ideapad-slim-3', name: 'Lenovo IdeaPad Slim 3', brand: 'Lenovo', sku: 'LENOVO-IDEA-S3',
    segments: ['student', 'budget'], image: IMG.laptop, stock: 45,
    short: 'The budget pick for notes, browsing and video calls.',
    specs: { processor: 'AMD Ryzen 5 7520U', gpu: 'AMD Radeon 610M', display_size_in: 15.6,
      resolution: 'FHD', refresh_rate_hz: 60, panel_type: 'TN', battery_wh: 47,
      weight_kg: 1.62, operating_system: 'Windows 11' },
    performance: { gaming: 2, programming: 5, office: 7, content_creation: 3, portability: 7, battery: 7, value: 10 },
    use_cases: ['college', 'office', 'daily_use'],
    tags: ['budget', 'student', 'lenovo'],
  },
  [
    { ram: 8, storage: 512, price: 32999, mrp: 44999 },
    { ram: 16, storage: 512, price: 41999, mrp: 54999 },
  ],
);

laptopFamily(
  {
    family: 'acer-nitro-v', name: 'Acer Nitro V 15', brand: 'Acer', sku: 'ACER-NITRO-V',
    category: 'gaming-laptops', segments: ['gaming', 'budget'], image: IMG.laptop, stock: 20,
    short: 'Affordable RTX gaming laptop.',
    specs: { processor: 'Intel Core i5-13420H', gpu: 'NVIDIA RTX 4050 6GB', vram_gb: 6,
      display_size_in: 15.6, resolution: 'FHD', refresh_rate_hz: 144, panel_type: 'IPS',
      battery_wh: 57, weight_kg: 2.1, operating_system: 'Windows 11' },
    performance: { gaming: 8, programming: 7, office: 8, content_creation: 7, portability: 5, battery: 5, value: 9 },
    use_cases: ['gaming', 'college', 'programming'],
    tags: ['gaming', 'budget', 'acer', 'rtx'],
    accessories: ['gaming_mouse', 'gaming_headset', 'cooling_pad', 'laptop_sleeve'],
  },
  [
    { ram: 8, storage: 512, price: 54999, mrp: 71999 },
    { ram: 16, storage: 1024, price: 69999, mrp: 86999 },
  ],
);

laptopFamily(
  {
    family: 'acer-aspire-lite', name: 'Acer Aspire Lite 14', brand: 'Acer', sku: 'ACER-ASP-L14',
    segments: ['student', 'budget'], image: IMG.laptop, stock: 35,
    short: 'Light, cheap and adequate — a first laptop.',
    specs: { processor: 'Intel Core i3-1215U', gpu: 'Intel UHD', display_size_in: 14,
      resolution: 'FHD', refresh_rate_hz: 60, panel_type: 'IPS', battery_wh: 50,
      weight_kg: 1.35, operating_system: 'Windows 11' },
    performance: { gaming: 2, programming: 4, office: 7, content_creation: 3, portability: 9, battery: 7, value: 10 },
    use_cases: ['college', 'daily_use', 'office'],
    tags: ['budget', 'student', 'acer', 'portable'],
  },
  [
    { ram: 8, storage: 512, price: 28999, mrp: 39999 },
    { ram: 16, storage: 512, price: 36999, mrp: 47999 },
  ],
);

/* ------------------------------------------------------------------ simple */

/** Everything that has no configuration axis: one product, one row. */
function simple(entry) {
  push({ ...entry, id: entry.id ?? slugify(`${entry.brand}-${entry.name}`) });
}

// ---- earbuds ----------------------------------------------------------
const budCompat = { platform: 'universal', attributes: { connector: 'USB-C' } };
const buds = [
  ['Apple', 'AirPods Pro 3', 'APPLE-APP3', 24900, 26900, 40, { anc: 'Active', battery_hours: 8, driver_type: 'Dynamic', connectivity: 'Bluetooth 5.3', water_resistance: 'IP54', wireless_charging: 'Yes', microphones: 3 }, ['audiophile', 'commute', 'calls'], ['apple', 'anc', 'wireless'], { audio_quality: 9, battery: 8, build_quality: 9, value: 7 }],
  ['Apple', 'AirPods 4', 'APPLE-AP4', 12900, 14900, 50, { anc: 'None', battery_hours: 6, driver_type: 'Dynamic', connectivity: 'Bluetooth 5.3', water_resistance: 'IPX4', microphones: 2 }, ['commute', 'calls'], ['apple', 'wireless'], { audio_quality: 8, battery: 7, build_quality: 8, value: 8 }],
  ['Samsung', 'Galaxy Buds3 Pro', 'SAMSUNG-BUDS3P', 19999, 24999, 30, { anc: 'Active', battery_hours: 7, driver_type: 'Dual dynamic', connectivity: 'Bluetooth 5.4', water_resistance: 'IP57', wireless_charging: 'Yes', microphones: 3 }, ['audiophile', 'commute', 'calls'], ['samsung', 'anc', 'wireless'], { audio_quality: 9, battery: 8, build_quality: 8, value: 8 }],
  ['Samsung', 'Galaxy Buds3', 'SAMSUNG-BUDS3', 12999, 16999, 35, { anc: 'Active', battery_hours: 6, driver_type: 'Dynamic', connectivity: 'Bluetooth 5.4', water_resistance: 'IP54', microphones: 3 }, ['commute', 'calls'], ['samsung', 'anc', 'wireless'], { audio_quality: 8, battery: 7, build_quality: 8, value: 8 }],
  ['Nothing', 'Ear (a)', 'NOTHING-EAR-A', 7999, 8999, 45, { anc: 'Active', battery_hours: 9, driver_type: 'Dynamic', connectivity: 'Bluetooth 5.3', water_resistance: 'IP54', microphones: 3 }, ['commute', 'budget'], ['nothing', 'anc', 'value'], { audio_quality: 8, battery: 9, build_quality: 7, value: 10 }],
  ['Nothing', 'Ear (2)', 'NOTHING-EAR-2', 9999, 11999, 25, { anc: 'Active', battery_hours: 8, driver_type: 'Dynamic', connectivity: 'Bluetooth 5.3', water_resistance: 'IP54', wireless_charging: 'Yes', microphones: 3 }, ['audiophile', 'commute'], ['nothing', 'anc'], { audio_quality: 8, battery: 8, build_quality: 8, value: 9 }],
  ['Google', 'Pixel Buds A-Series', 'GOOGLE-PBA', 6999, 9999, 28, { anc: 'None', battery_hours: 5, driver_type: 'Dynamic', connectivity: 'Bluetooth 5.0', water_resistance: 'IPX4', microphones: 2 }, ['commute', 'calls', 'budget'], ['google', 'value'], { audio_quality: 7, battery: 6, build_quality: 7, value: 9 }],
  ['Xiaomi', 'Redmi Buds 5 Pro', 'XIAOMI-RB5P', 3999, 5999, 60, { anc: 'Active', battery_hours: 10, driver_type: 'Dual dynamic', connectivity: 'Bluetooth 5.3', water_resistance: 'IP54', microphones: 3 }, ['commute', 'budget', 'sports'], ['xiaomi', 'anc', 'value'], { audio_quality: 7, battery: 9, build_quality: 6, value: 10 }],
];
for (const [brand, name, sku, price, mrp, stock, specs, segments, tags, performance] of buds) {
  simple({
    product_family: slugify(`${brand}-${name}`), name, brand, category: 'earbuds', segments,
    short_description: `${brand} wireless earbuds.`, price, mrp, sku, stock,
    specifications: specs, performance, use_cases: ['music', 'calls', 'commute', 'travel'],
    tags, compatibility: budCompat, image: IMG.iem,
  });
}

simple({
  id: 'sony-ier-z1r', product_family: 'sony-ier-z1r', name: 'Sony IER-Z1R In-Ear Monitors',
  brand: 'Sony', category: 'earbuds', segments: ['audiophile'],
  short_description: 'Flagship wired in-ear monitors with a three-driver hybrid design.',
  price: 159990, mrp: 174990, sku: 'SONY-IERZ1R', stock: 4,
  specifications: { driver_type: 'Hybrid 3-driver', connectivity: 'Wired 4.4mm / 3.5mm', anc: 'None' },
  performance: { audio_quality: 10, build_quality: 10, value: 4 },
  use_cases: ['music', 'professional'], tags: ['sony', 'audiophile', 'premium', 'wired'],
  compatibility: { platform: 'universal', attributes: { connector: '3.5 mm' } }, image: IMG.iem,
});

// ---- headphones -------------------------------------------------------
const cans = [
  ['Sony', 'WH-1000XM5', 'SONY-XM5', 26990, 34990, 15, ['audiophile', 'commute'], { anc: 'Active', battery_hours: 30, driver_type: '30mm dynamic', connectivity: 'Bluetooth 5.2' }, { audio_quality: 10, battery: 10, build_quality: 9, value: 8 }, ['sony', 'anc', 'travel']],
  ['Bose', 'QuietComfort Ultra', 'BOSE-QCU', 29990, 35900, 10, ['audiophile', 'commute'], { anc: 'Active', battery_hours: 24, driver_type: '35mm dynamic', connectivity: 'Bluetooth 5.3' }, { audio_quality: 9, battery: 9, build_quality: 9, value: 7 }, ['bose', 'anc', 'travel']],
  ['JBL', 'Tune 770NC', 'JBL-T770', 6999, 9999, 30, ['budget', 'commute'], { anc: 'Active', battery_hours: 70, driver_type: '40mm dynamic', connectivity: 'Bluetooth 5.3' }, { audio_quality: 7, battery: 10, build_quality: 7, value: 10 }, ['jbl', 'anc', 'value']],
  ['Sennheiser', 'HD 560S', 'SENN-HD560S', 17990, 21990, 8, ['studio', 'audiophile'], { anc: 'None', driver_type: '38mm dynamic', connectivity: 'Wired 3.5mm' }, { audio_quality: 9, build_quality: 8, value: 8 }, ['sennheiser', 'studio', 'wired']],
  ['boAt', 'Rockerz 550', 'BOAT-R550', 2499, 4990, 50, ['budget'], { anc: 'None', battery_hours: 20, driver_type: '50mm dynamic', connectivity: 'Bluetooth 5.0' }, { audio_quality: 6, battery: 8, build_quality: 6, value: 9 }, ['boat', 'budget']],
];
for (const [brand, name, sku, price, mrp, stock, segments, specs, performance, tags] of cans) {
  simple({
    id: slugify(`${brand} ${name}`), product_family: slugify(`${brand}-${name}`), name: `${brand} ${name}`, brand,
    category: 'headphones', segments, short_description: `${brand} over-ear headphones.`,
    price, mrp, sku, stock, specifications: specs, performance,
    use_cases: ['music', 'travel', 'calls', 'commute'], tags,
    compatibility: { platform: 'universal' }, image: IMG.headphones,
  });
}

// ---- chargers ---------------------------------------------------------
const chargers = [
  ['Apple', '20W USB-C Power Adapter', 'APPLE-CHG-20', 1900, 2100, 60, 20, 1, 'smartphones'],
  ['Samsung', '25W Travel Adapter', 'SAMSUNG-CHG-25', 1499, 1999, 55, 25, 1, 'smartphones'],
  ['OnePlus', 'SUPERVOOC 80W Adapter', 'ONEPLUS-CHG-80', 2499, 2999, 30, 80, 1, 'smartphones'],
  ['Anker', 'Nano 30W USB-C', 'ANKER-CHG-30', 2299, 2999, 40, 30, 1, 'smartphones'],
  ['Anker', '45W GaN Dual-Port', 'ANKER-CHG-45', 3499, 4499, 25, 45, 2, 'smartphones'],
  ['Anker', '65W GaN Charger', 'ANKER-CHG-65', 4499, 5999, 22, 65, 2, 'laptops'],
  ['Ugreen', '100W GaN 4-Port', 'UGREEN-CHG-100', 6999, 8999, 15, 100, 4, 'laptops'],
  ['Dell', '65W USB-C Laptop Adapter', 'DELL-CHG-65', 3999, 4999, 18, 65, 1, 'laptops'],
  ['HP', '140W USB-C Laptop Adapter', 'HP-CHG-140', 7999, 9499, 10, 140, 1, 'laptops'],
];
for (const [brand, name, sku, price, mrp, stock, watts, ports, forCategory] of chargers) {
  const laptopClass = forCategory === 'laptops';
  simple({
    id: slugify(`${brand} ${name}`), product_family: slugify(`${brand}-${name}`), name: `${brand} ${name}`, brand,
    category: 'chargers', segments: watts >= 45 ? ['fast_charging'] : ['budget'],
    short_description: `${watts}W ${ports > 1 ? `${ports}-port ` : ''}charger for ${laptopClass ? 'laptops' : 'phones'}.`,
    price, mrp, sku, stock,
    specifications: { power_w: watts, connector: 'USB-C', charging_w: watts, connectivity: `${ports} port` },
    performance: { value: watts >= 65 ? 8 : 9, build_quality: 8 },
    use_cases: ['daily_use', 'travel'],
    tags: ['charger', 'usb-c', 'fast-charging', ...(watts >= 45 ? ['gan'] : [])],
    compatibility: {
      platform: 'universal',
      attributes: { connector: 'USB-C', power_w: watts },
      // Named so a phone charger is never offered as a laptop charger: 20W
      // will not run a MacBook, and saying it will is a returned parcel.
      claims: [{ predicate: 'recommended_for', category: forCategory, reason: `${watts}W suits ${laptopClass ? 'laptops' : 'phones'}` }],
    },
    image: laptopClass ? IMG.laptopCharger : IMG.phoneCharger,
  });
}

// ---- laptop accessories ----------------------------------------------
const sleeves = [
  ['13', 1299, 1999, 40], ['14', 1499, 2199, 45], ['15', 1699, 2399, 38], ['16', 1899, 2599, 30],
];
for (const [size, price, mrp, stock] of sleeves) {
  simple({
    id: `shopiq-laptop-sleeve-${size}`, product_family: 'laptop-sleeve',
    name: `ShopiQ Laptop Sleeve ${size}"`, brand: 'ShopiQ', category: 'laptop-accessories',
    segments: ['budget', 'travel'], short_description: `Padded sleeve sized for ${size}-inch laptops.`,
    price, mrp, sku: `SHOPIQ-SLV-${size}`, stock,
    specifications: { weight_kg: 0.3 }, performance: { build_quality: 7, value: 9 },
    use_cases: ['travel', 'college', 'office'], tags: ['sleeve', 'protection', 'budget'],
    compatibility: { platform: 'universal', compatible_sizes: [size] },
    image: IMG.laptop,
  });
}
simple({
  id: 'shopiq-premium-sleeve-14', product_family: 'laptop-sleeve-premium',
  name: 'ShopiQ Premium Leather Sleeve 14"', brand: 'ShopiQ', category: 'laptop-accessories',
  segments: ['premium', 'travel'], short_description: 'Leather sleeve for 14-inch laptops.',
  price: 3499, mrp: 4499, sku: 'SHOPIQ-SLVP-14', stock: 12,
  specifications: { weight_kg: 0.35 }, performance: { build_quality: 9, value: 7 },
  use_cases: ['travel', 'professional'], tags: ['sleeve', 'premium', 'leather'],
  compatibility: { platform: 'universal', compatible_sizes: ['14'] }, image: IMG.laptop,
});
simple({
  id: 'shopiq-laptop-backpack', product_family: 'laptop-backpack',
  name: 'ShopiQ Laptop Backpack 16"', brand: 'ShopiQ', category: 'laptop-accessories',
  segments: ['travel', 'budget'], short_description: 'Padded backpack that carries up to a 16-inch laptop.',
  price: 2999, mrp: 3999, sku: 'SHOPIQ-BAG-16', stock: 25,
  specifications: { weight_kg: 0.9 }, performance: { build_quality: 8, value: 9 },
  use_cases: ['travel', 'college', 'office'], tags: ['bag', 'backpack', 'protection'],
  compatibility: { platform: 'universal', compatible_sizes: ['13', '14', '15', '16'] }, image: IMG.laptop,
});
simple({
  id: 'ugreen-usb-c-hub-7in1', product_family: 'usb-c-hub', name: 'Ugreen 7-in-1 USB-C Hub',
  brand: 'Ugreen', category: 'laptop-accessories', segments: ['premium'],
  short_description: 'HDMI, USB-A, SD and 100W pass-through from one USB-C port.',
  price: 3499, mrp: 4999, sku: 'UGREEN-HUB-7', stock: 20,
  specifications: { interface: 'USB-C', connector: 'USB-C', power_w: 100, connectivity: '7 ports' },
  performance: { build_quality: 8, value: 9 }, use_cases: ['office', 'programming', 'content_creation'],
  tags: ['hub', 'usb-c', 'connectivity'],
  compatibility: { platform: 'universal', attributes: { connector: 'USB-C' } }, image: IMG.laptop,
});
simple({
  id: 'cosmic-byte-cooling-pad', product_family: 'cooling-pad', name: 'Cosmic Byte Laptop Cooling Pad',
  brand: 'Cosmic Byte', category: 'laptop-accessories', segments: ['budget'],
  short_description: 'Five-fan cooling stand for gaming laptops.',
  price: 1799, mrp: 2499, sku: 'CB-COOL-5F', stock: 30,
  specifications: { weight_kg: 1.1, connectivity: 'USB-A' }, performance: { build_quality: 7, value: 9 },
  use_cases: ['gaming'], tags: ['cooling', 'gaming', 'budget'],
  compatibility: { platform: 'universal', compatible_sizes: ['13', '14', '15', '16'] }, image: IMG.laptop,
});

// ---- phone accessories ------------------------------------------------
const phoneAcc = [
  ['ShopiQ', 'Clear Case for iPhone', 'SHOPIQ-CASE-IP', 799, 1299, 80, 'Apple'],
  ['ShopiQ', 'Clear Case for Galaxy', 'SHOPIQ-CASE-SG', 799, 1299, 70, 'Samsung'],
  ['ShopiQ', 'Tempered Glass Screen Protector', 'SHOPIQ-SP-GLASS', 499, 999, 100, null],
  ['Spigen', 'Rugged Armor Case', 'SPIGEN-RA', 1499, 2299, 40, null],
];
for (const [brand, name, sku, price, mrp, stock, forBrand] of phoneAcc) {
  simple({
    id: slugify(`${brand} ${name}`), product_family: slugify(`${brand}-${name}`), name: `${brand} ${name}`, brand,
    category: 'phone-accessories', segments: ['budget'],
    short_description: forBrand ? `Protection for ${forBrand} phones.` : 'Phone protection.',
    price, mrp, sku, stock, specifications: { weight_kg: 0.05 },
    performance: { build_quality: 7, value: 9 }, use_cases: ['daily_use'],
    tags: ['case', 'protection', 'budget'],
    compatibility: {
      platform: 'mobile',
      ...(forBrand ? { claims: [{ predicate: 'recommended_for', brand: forBrand, category: 'smartphones', reason: `made for ${forBrand} phones` }] } : {}),
    },
    image: IMG.phoneCharger,
  });
}

// ---- keyboards & mice --------------------------------------------------
const keyboards = [
  ['Logitech', 'MX Keys S', 'LOGI-MXKS', 9995, 12995, 20, ['office', 'premium'], 'Wireless', { office: 9, value: 8, build_quality: 9 }],
  ['Keychron', 'K2 Mechanical', 'KEYCH-K2', 7499, 8999, 15, ['premium', 'office'], 'Wireless', { office: 9, gaming: 7, build_quality: 9, value: 8 }],
  ['Razer', 'BlackWidow V4 X', 'RAZER-BWV4X', 8999, 11999, 12, ['gaming'], 'Wired', { gaming: 9, office: 7, build_quality: 8, value: 8 }],
  ['Logitech', 'K380 Multi-Device', 'LOGI-K380', 2795, 3495, 45, ['office', 'budget'], 'Wireless', { office: 8, value: 10, build_quality: 7 }],
  ['Redragon', 'K552 Mechanical', 'REDR-K552', 2999, 4499, 35, ['gaming', 'budget'], 'Wired', { gaming: 8, office: 6, value: 10, build_quality: 7 }],
];
for (const [brand, name, sku, price, mrp, stock, segments, conn, performance] of keyboards) {
  simple({
    id: slugify(`${brand} ${name}`), product_family: slugify(`${brand}-${name}`), name: `${brand} ${name}`, brand,
    category: 'keyboards', segments, short_description: `${conn} keyboard.`,
    price, mrp, sku, stock, specifications: { connectivity: conn, connector: conn === 'Wired' ? 'USB-A' : 'USB-C' },
    performance, use_cases: segments.includes('gaming') ? ['gaming', 'office'] : ['office', 'programming', 'productivity'],
    tags: [conn.toLowerCase(), ...(segments.includes('gaming') ? ['gaming'] : ['productivity'])],
    compatibility: { platform: 'universal' }, image: IMG.keyboard,
  });
}

const mice = [
  ['Logitech', 'MX Master 3S', 'LOGI-MXM3S', 8495, 10995, 22, ['office', 'ergonomic'], { office: 10, gaming: 5, build_quality: 9, value: 8 }],
  ['Logitech', 'G502 X', 'LOGI-G502X', 6495, 8995, 18, ['gaming'], { gaming: 9, office: 7, build_quality: 9, value: 8 }],
  ['Razer', 'DeathAdder V3', 'RAZER-DAV3', 5499, 6999, 20, ['gaming'], { gaming: 9, office: 6, build_quality: 8, value: 8 }],
  ['Logitech', 'M240 Silent', 'LOGI-M240', 1295, 1995, 60, ['office', 'budget'], { office: 8, gaming: 3, build_quality: 7, value: 10 }],
  ['Zebronics', 'Zeb-Transformer', 'ZEB-TRANS', 799, 1299, 70, ['gaming', 'budget'], { gaming: 6, office: 6, build_quality: 6, value: 10 }],
];
for (const [brand, name, sku, price, mrp, stock, segments, performance] of mice) {
  const gaming = segments.includes('gaming');
  simple({
    id: slugify(`${brand} ${name}`), product_family: slugify(`${brand}-${name}`), name: `${brand} ${name}`, brand,
    category: 'mice', segments,
    short_description: gaming ? 'Gaming mouse.' : 'Wireless mouse for everyday work.',
    price, mrp, sku, stock, specifications: { connectivity: 'Wireless' }, performance,
    use_cases: gaming ? ['gaming'] : ['office', 'programming', 'productivity'],
    tags: gaming ? ['gaming', 'mouse'] : ['mouse', 'wireless', 'productivity'],
    compatibility: { platform: 'universal' }, image: IMG.mouse,
  });
}

// ---- monitors ---------------------------------------------------------
const monitors = [
  ['Dell', 'S2425H 24" FHD', 'DELL-S2425H', 11999, 15999, 25, ['office', 'budget'], 24, 'FHD', 100, 'IPS', { office: 8, value: 9 }],
  ['LG', '27MP60G 27" FHD', 'LG-27MP60G', 14999, 18999, 20, ['office'], 27, 'FHD', 75, 'IPS', { office: 8, value: 9 }],
  ['Samsung', 'Odyssey G4 25" FHD 240Hz', 'SAMSUNG-G4-25', 24999, 32999, 12, ['gaming'], 25, 'FHD', 240, 'IPS', { gaming: 9, office: 7, value: 8 }],
  ['LG', 'UltraGear 27" QHD 180Hz', 'LG-UG27-QHD', 29999, 38999, 15, ['gaming'], 27, 'QHD', 180, 'IPS', { gaming: 9, content_creation: 8, value: 8 }],
  ['Dell', 'U2723QE 27" 4K', 'DELL-U2723QE', 49999, 62999, 8, ['creator', 'professional'], 27, '4K', 60, 'IPS', { content_creation: 9, office: 9, value: 7 }],
  ['BenQ', 'PD2705U 27" 4K Designer', 'BENQ-PD2705U', 54999, 67999, 6, ['creator', 'professional'], 27, '4K', 60, 'IPS', { content_creation: 10, office: 9, value: 7 }],
  ['Acer', 'Nitro 32" QHD 170Hz', 'ACER-NITRO-32', 27999, 35999, 10, ['gaming'], 32, 'QHD', 170, 'VA', { gaming: 9, value: 8 }],
  ['Samsung', 'ViewFinity S8 32" 4K', 'SAMSUNG-S8-32', 44999, 54999, 7, ['creator', 'office'], 32, '4K', 60, 'IPS', { content_creation: 9, office: 9, value: 8 }],
];
for (const [brand, name, sku, price, mrp, stock, segments, size, res, hz, panel, performance] of monitors) {
  simple({
    id: slugify(`${brand} ${name}`), product_family: slugify(`${brand}-${name}`), name: `${brand} ${name}`, brand,
    category: 'monitors', segments, short_description: `${size}-inch ${res} ${hz} Hz monitor.`,
    price, mrp, sku, stock,
    specifications: { display_size_in: size, resolution: res, refresh_rate_hz: hz, panel_type: panel, connector: 'HDMI' },
    performance: { ...performance, display_quality: res === '4K' ? 9 : 8 },
    use_cases: segments.includes('gaming') ? ['gaming', 'office'] : ['office', 'content_creation', 'programming'],
    tags: [res.toLowerCase(), `${hz}hz`, ...segments],
    compatibility: { platform: 'universal', attributes: { connector: 'HDMI' } }, image: IMG.monitor,
  });
}

// ---- televisions ------------------------------------------------------
// Two of these meet what a PS5 can drive; two deliberately do not, so the
// compatibility requirement has something to exclude.
const tvs = [
  ['Sony', 'BRAVIA 7 55" 4K 120Hz', 'SONY-BRAVIA7-55', 139990, 169990, 6, 55, 120, 2.1, 'Mini-LED', ['gaming', 'premium']],
  ['LG', 'C4 OLED 65" 4K 120Hz', 'LG-C4-65', 199990, 249990, 4, 65, 120, 2.1, 'OLED', ['gaming', 'premium']],
  ['Samsung', 'Crystal 4K 50"', 'SAMSUNG-CU-50', 39990, 54990, 14, 50, 60, 2.0, 'VA', ['home_entertainment', 'budget']],
  ['TCL', 'P7K 43" 4K', 'TCL-P7K-43', 27990, 36990, 18, 43, 60, 2.0, 'VA', ['home_entertainment', 'budget']],
];
for (const [brand, name, sku, price, mrp, stock, size, hz, hdmi, panel, segments] of tvs) {
  simple({
    id: slugify(`${brand} ${name}`), product_family: slugify(`${brand}-${name}`), name: `${brand} ${name}`, brand,
    category: 'televisions', segments,
    short_description: `${size}-inch 4K television at ${hz} Hz over HDMI ${hdmi}.`,
    price, mrp, sku, stock,
    specifications: { display_size_in: size, resolution: '4K', refresh_rate_hz: hz,
      hdmi_version: hdmi, panel_type: panel, audio_output_w: 20, connector: 'HDMI' },
    performance: { gaming: hz >= 120 ? 9 : 5, display_quality: panel === 'OLED' ? 10 : 8, value: hz >= 120 ? 7 : 9 },
    use_cases: ['home_entertainment', ...(hz >= 120 ? ['gaming'] : [])],
    tags: ['4k', `${hz}hz`, ...(hdmi >= 2.1 ? ['hdmi2.1'] : []), panel.toLowerCase()],
    compatibility: { platform: 'universal', attributes: { connector: 'HDMI' } }, image: IMG.monitor,
  });
}

// ---- PlayStation ecosystem --------------------------------------------
const consoles = [
  ['PlayStation 5 Slim Digital Edition', 'SONY-PS5-SLIM-DIG', 44990, 49990, 12, 1024, 'No disc drive. Downloads only.'],
  ['PlayStation 5 Slim Disc Edition', 'SONY-PS5-SLIM-DISC', 54990, 59990, 10, 1024, 'With a 4K Blu-ray drive.'],
  ['PlayStation 5 Digital Edition', 'SONY-PS5-DIG', 39990, 49990, 5, 825, 'The original digital console.'],
  ['PlayStation 5 Pro', 'SONY-PS5-PRO', 79990, 89990, 3, 2048, 'The most capable PS5, for 4K high-refresh play.'],
];
for (const [name, sku, price, mrp, stock, storage, short] of consoles) {
  simple({
    product_family: 'ps5', name, brand: 'Sony', category: 'playstation', segments: ['gaming'],
    short_description: short, price, mrp, sku, stock,
    configuration: { storage_gb: storage },
    specifications: { storage_gb: storage, resolution: '4K', refresh_rate_hz: 120,
      hdmi_version: 2.1, connector: 'HDMI', storage_type: 'SSD' },
    performance: { gaming: name.includes('Pro') ? 10 : 9, display_quality: 9, value: 8 },
    use_cases: ['gaming', 'home_entertainment'], tags: ['console', 'playstation', '4k', '120hz'],
    compatibility: {
      platform: 'console', attributes: { connector: 'HDMI' },
      compatible_accessory_types: ['controller', 'gaming_headset', 'charging_station', 'television'],
    },
    image: IMG.ps5,
  });
}

simple({
  id: 'sony-dualsense-controller', product_family: 'dualsense',
  name: 'DualSense Wireless Controller', brand: 'Sony', category: 'controllers',
  segments: ['gaming'], short_description: 'Haptic feedback and adaptive triggers, on PC as well as PS5.',
  price: 5990, mrp: 6990, sku: 'SONY-DUALSENSE', stock: 40,
  specifications: { connectivity: 'Bluetooth, USB-C', battery_hours: 12, connector: 'USB-C' },
  performance: { gaming: 9, build_quality: 9, value: 8 }, use_cases: ['gaming'],
  tags: ['controller', 'playstation', 'gaming'],
  compatibility: { platform: 'universal', attributes: { connector: 'USB-C' } }, image: IMG.dualsense,
});
simple({
  id: 'sony-dualsense-edge', product_family: 'dualsense',
  name: 'DualSense Edge Wireless Controller', brand: 'Sony', category: 'controllers',
  segments: ['gaming'], short_description: 'The pro controller, with swappable sticks and back paddles.',
  price: 18990, mrp: 20990, sku: 'SONY-DUALSENSE-EDGE', stock: 6,
  specifications: { connectivity: 'Bluetooth, USB-C', battery_hours: 10, connector: 'USB-C' },
  performance: { gaming: 10, build_quality: 10, value: 6 }, use_cases: ['gaming'],
  tags: ['controller', 'playstation', 'gaming', 'premium'],
  compatibility: { platform: 'universal', attributes: { connector: 'USB-C' } }, image: IMG.dualsense,
});
simple({
  id: 'sony-dualsense-charging-station', product_family: 'ps5-accessories',
  name: 'DualSense Charging Station', brand: 'Sony', category: 'gaming-accessories',
  segments: ['gaming'], short_description: 'Charges two DualSense controllers without the console.',
  price: 2490, mrp: 2990, sku: 'SONY-DS-CHARGE', stock: 25,
  specifications: { connectivity: 'AC', power_w: 10 }, performance: { build_quality: 8, value: 9 },
  use_cases: ['gaming'], tags: ['playstation', 'charging', 'gaming'],
  compatibility: { platform: 'console' }, image: IMG.dualsense,
});
simple({
  id: 'sony-pulse-3d-headset', product_family: 'ps5-audio',
  name: 'PULSE 3D Wireless Headset', brand: 'Sony', category: 'gaming-headsets',
  segments: ['gaming'], short_description: 'Tempest 3D audio headset for PS5.',
  price: 8990, mrp: 10990, sku: 'SONY-PULSE3D', stock: 18,
  specifications: { connectivity: 'Wireless 2.4GHz', battery_hours: 12, driver_type: '40mm' },
  performance: { gaming: 9, audio_quality: 8, value: 8 }, use_cases: ['gaming'],
  tags: ['headset', 'playstation', 'gaming', 'wireless'],
  compatibility: { platform: 'universal' }, image: IMG.headphones,
});
simple({
  id: 'hyperx-cloud-iii-headset', product_family: 'hyperx-cloud',
  name: 'HyperX Cloud III Gaming Headset', brand: 'HyperX', category: 'gaming-headsets',
  segments: ['gaming', 'budget'], short_description: 'Wired gaming headset with a detachable mic.',
  price: 7490, mrp: 9990, sku: 'HYPERX-CLOUD3', stock: 22,
  specifications: { connectivity: 'Wired 3.5mm / USB', driver_type: '53mm', connector: '3.5 mm' },
  performance: { gaming: 9, audio_quality: 8, value: 9 }, use_cases: ['gaming', 'calls'],
  tags: ['headset', 'gaming', 'wired'],
  compatibility: { platform: 'universal' }, image: IMG.headphones,
});

/* ------------------------------------------------------------------ write */

const catalog = {
  catalog_version: '1.0.0',
  generated_at: new Date().toISOString(),
  demo_dataset: true,
  products,
};

const out = path.join(process.cwd(), 'data', 'catalog', 'catalog.json');
fs.writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);

const byCategory = {};
for (const product of products) {
  byCategory[product.category] = (byCategory[product.category] ?? 0) + 1;
}
const families = new Set(products.map((p) => p.product_family).filter(Boolean));

console.log(`wrote ${products.length} products to data/catalog/catalog.json`);
console.log(`product families: ${families.size}`);
for (const [category, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${category.padEnd(22)} ${count}`);
}
