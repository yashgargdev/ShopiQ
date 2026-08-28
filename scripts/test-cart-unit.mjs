/**
 * Unit tests for the Phase 3 deterministic core: conversational product
 * references, quantity parsing, the confirmation reader, and cross-sell
 * ranking. No database, no network, no API key.
 *
 *   npm run test:cart-unit
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./scripts/ts-loader.mjs', pathToFileURL('./'));

const {
  resolveReference,
  extractOrdinals,
  extractQuantity,
} = await import('../lib/ai/references.ts');

const { readConfirmation, buildPendingAction, isExpired, looksLikeClearCartRequest } =
  await import('../lib/ai/confirm.ts');

const { rankCrossSell, shouldCrossSell, accessoryCategoriesFor } = await import(
  '../lib/ai/crosssell.ts'
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
const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

// ------------------------------------------------------------------ fixtures

const SHOWN = [
  {
    productId: 'p1',
    name: 'TUF Gaming A15',
    brand: 'ASUS',
    price: 79999,
    score: 99,
    specs: { ram_gb: 32, weight_kg: 2.2 },
  },
  {
    productId: 'p2',
    name: 'Victus 15 RTX 4050',
    brand: 'HP',
    price: 67990,
    score: 95,
    specs: { ram_gb: 16, weight_kg: 2.29 },
  },
  {
    productId: 'p3',
    name: 'Zenbook 14 OLED',
    brand: 'ASUS',
    price: 86990,
    score: 90,
    specs: { ram_gb: 16, weight_kg: 1.2 },
  },
];

const CART = [
  { cartItemId: 'c1', productId: 'p1', name: 'TUF Gaming A15', brand: 'ASUS', price: 79999, quantity: 1 },
  { cartItemId: 'c2', productId: 'p9', name: 'Laptop Sleeve 14-inch', brand: 'Lenovo', price: 899, quantity: 2 },
];

const scope = (shown = SHOWN, cart = CART) => ({ shown, cart });

console.log(`ShopiQ Phase 3 unit tests\n${'='.repeat(56)}`);

// ================================================================== ordinals
section('Positional references');

check('"add the first one" → [1]', JSON.stringify(extractOrdinals('add the first one')) === '[1]');
check('"second" → [2]', JSON.stringify(extractOrdinals('add the second one')) === '[2]');
check('"third" → [3]', JSON.stringify(extractOrdinals('the third one please')) === '[3]');
check('"pehla wala" → [1]', JSON.stringify(extractOrdinals('pehla wala add karo')) === '[1]');
check('"dusra" → [2]', JSON.stringify(extractOrdinals('dusra wala')) === '[2]');
check('"option 2" → [2]', JSON.stringify(extractOrdinals('add option 2')) === '[2]');
check('no ordinal in plain text', extractOrdinals('add a laptop').length === 0);
check(
  'a price is not read as an ordinal',
  extractOrdinals('something under 80000').length === 0,
);

const first = resolveReference('add the first one', scope());
check('"first one" resolves to p1', first.productIds[0] === 'p1', first.productIds[0]);
check('confidence is exact', first.confidence === 'exact');

const second = resolveReference('add the second one', scope());
check('"second one" resolves to p2', second.productIds[0] === 'p2', second.productIds[0]);

const third = resolveReference('add the third one', scope());
check('"third one" resolves to p3', third.productIds[0] === 'p3');

const beyond = resolveReference('add the fifth one', scope());
check(
  'a position past the end resolves to nothing (never guesses)',
  beyond.productIds.length === 0 && beyond.confidence === 'ambiguous',
  beyond.confidence,
);

const last = resolveReference('add the last one', scope());
check('"the last one" resolves to p3', last.productIds[0] === 'p3');

// ============================================================== superlatives
section('Superlative references');

const cheaper = resolveReference('add the cheaper one', scope());
check('"cheaper one" → lowest price (p2)', cheaper.productIds[0] === 'p2', cheaper.productIds[0]);
check('and is labelled as inferred', cheaper.confidence === 'inferred');

const powerful = resolveReference('the more powerful one', scope());
check('"more powerful" → most RAM (p1)', powerful.productIds[0] === 'p1', powerful.productIds[0]);

const lightest = resolveReference('show me the lightest one', scope());
check('"lightest" → lowest weight (p3)', lightest.productIds[0] === 'p3', lightest.productIds[0]);

const recommended = resolveReference('add the one you recommended', scope());
check('"you recommended" → the top-ranked (p1)', recommended.productIds[0] === 'p1');

const priciest = resolveReference('the most expensive one', scope());
check('"most expensive" → p3', priciest.productIds[0] === 'p3', priciest.productIds[0]);

const tie = resolveReference('the cheaper one', {
  shown: [
    { productId: 'a', name: 'A', brand: 'X', price: 100 },
    { productId: 'b', name: 'B', brand: 'Y', price: 100 },
  ],
  cart: [],
});
check('a tie is ambiguous, not an arbitrary pick', tie.confidence === 'ambiguous', tie.confidence);

// ============================================================ name matching
section('Name and brand references');

const byName = resolveReference('remove the laptop sleeve', scope());
check('"laptop sleeve" resolves in the cart', byName.cartItemIds[0] === 'c2', byName.cartItemIds[0]);

const byBrand = resolveReference('add the ASUS one', {
  shown: [SHOWN[0], SHOWN[1]],
  cart: [],
});
check('brand name resolves', byBrand.productIds[0] === 'p1', byBrand.productIds[0]);

const removeCart = resolveReference('remove the TUF', scope());
check('a cart verb prefers the cart', removeCart.cartItemIds[0] === 'c1');

// ================================================================= pronouns
section('Pronoun references');

const single = resolveReference('add it', { shown: [SHOWN[0]], cart: [] });
check('"add it" with one shown resolves', single.productIds[0] === 'p1');

const many = resolveReference('add it', scope(SHOWN, []));
check(
  '"add it" with three shown is ambiguous',
  many.confidence === 'ambiguous' && many.productIds.length === 0,
  many.confidence,
);
check('and it lists the candidates', (many.candidates?.length ?? 0) === 3);

const oneCartLine = resolveReference('remove it', { shown: [], cart: [CART[0]] });
check('"remove it" with one cart line resolves', oneCartLine.cartItemIds[0] === 'c1');

const emptyScope = resolveReference('add it', { shown: [], cart: [] });
check('nothing to resolve against → none', emptyScope.confidence === 'none');

// ================================================================ quantities
section('Quantity parsing');

const cases = [
  ['make it two', 2, 'set'],
  ['make it 3', 3, 'set'],
  ['set it to 4', 4, 'set'],
  ['add one more', 1, 'increase'],
  ['one more please', 1, 'increase'],
  ['ek aur', 1, 'increase'],
  ['remove one', 1, 'decrease'],
  ['one less', 1, 'decrease'],
  ['reduce by 2', 2, 'decrease'],
  ['add 3', 3, 'set'],
];

for (const [text, quantity, relative] of cases) {
  const result = extractQuantity(text);
  check(
    `"${text}" → ${quantity} (${relative})`,
    result?.quantity === quantity && result?.relative === relative,
    JSON.stringify(result),
  );
}

check('no quantity in plain text', extractQuantity('show me laptops') === null);

// The bug this guards: "do" is Hindi for two AND the imperative particle.
check(
  '"daal do" is not read as "add two"',
  extractQuantity('First wala cart mein daal do') === null,
  JSON.stringify(extractQuantity('First wala cart mein daal do')),
);
check(
  '"kar do" is not read as a quantity',
  extractQuantity('add kar do') === null,
  JSON.stringify(extractQuantity('add kar do')),
);
check(
  'but "do piece" still means two',
  extractQuantity('do piece chahiye')?.quantity === 2,
  JSON.stringify(extractQuantity('do piece chahiye')),
);

// ============================================================= confirmation
section('Confirmation reading');

for (const yes of ['yes', 'Yes', 'yeah', 'sure', 'go ahead', 'do it', 'haan', 'ji haan', 'ok', 'confirm']) {
  check(`"${yes}" → yes`, readConfirmation(yes) === 'yes', readConfirmation(yes));
}
for (const no of ['no', 'nope', "don't", 'cancel', 'nahi', 'never mind', 'stop', 'leave it']) {
  check(`"${no}" → no`, readConfirmation(no) === 'no', readConfirmation(no));
}

check(
  'a new request is not a yes',
  readConfirmation('show me cheaper laptops instead') === 'unclear',
  readConfirmation('show me cheaper laptops instead'),
);
check(
  'a question is not a yes',
  readConfirmation('what is in my cart right now and how much does it cost') === 'unclear',
);
check('"No, don\'t clear it" → no', readConfirmation("No, don't clear it") === 'no');

const pendingAction = buildPendingAction('clear_cart', {}, 'Remove all 3 items');
check('a pending action starts awaiting_confirmation', pendingAction.status === 'awaiting_confirmation');
check('it carries a summary', pendingAction.summary === 'Remove all 3 items');
check('it is not expired on creation', isExpired(pendingAction) === false);
check(
  'an old action is expired',
  isExpired({ ...pendingAction, expiresAt: new Date(Date.now() - 1000).toISOString() }),
);

check('"clear my cart" is detected', looksLikeClearCartRequest('clear my cart'));
check('"empty the cart" is detected', looksLikeClearCartRequest('empty the cart please'));
check('"remove the laptop" is NOT a clear', looksLikeClearCartRequest('remove the laptop') === false);

// ============================================================== cross-sell
section('Cross-sell gating');

check('"what else do I need" opens the door', shouldCrossSell('what else would I need for college?', { justAddedToCart: false }));
check('"accessories" opens the door', shouldCrossSell('show me accessories for this', { justAddedToCart: false }));
check('"aur kya chahiye" opens the door', shouldCrossSell('aur kya chahiye', { justAddedToCart: false }));
check('adding to cart opens the door', shouldCrossSell('add the first one', { justAddedToCart: true }));

// The behaviour §21 exists to prevent.
check(
  '"hello" does NOT trigger a recommendation',
  shouldCrossSell('hello', { justAddedToCart: false }) === false,
);
check(
  'a plain search does NOT trigger one',
  shouldCrossSell('show me gaming laptops under 80000', { justAddedToCart: false }) === false,
);

check('laptops pair with bags', accessoryCategoriesFor('laptops').includes('bags'));
check('gaming laptops pair with mice', accessoryCategoriesFor('gaming-laptops').includes('mice'));
check('an unknown category has no pairings', accessoryCategoriesFor('nonsense').length === 0);

// ========================================================= cross-sell rank
section('Cross-sell ranking');

const product = (over = {}) => ({
  id: over.id ?? 'x',
  name: over.name ?? 'Thing',
  slug: 'thing',
  brand: over.brand ?? 'Brand',
  sku: 'SKU',
  shortDescription: null,
  price: over.price ?? 1000,
  compareAtPrice: null,
  currency: 'INR',
  rating: over.rating ?? 4.5,
  reviewCount: 100,
  isFeatured: false,
  tags: over.tags ?? [],
  specs: {},
  category: over.category ?? { id: 'c', name: 'Bags', slug: 'bags' },
  image: null,
  imageAlt: null,
  availability: over.availability ?? { available: 10, inStock: true, lowStock: false },
});

const anchor = product({
  id: 'anchor',
  name: 'TUF Gaming A15',
  price: 79999,
  category: { id: 'l', name: 'Gaming Laptops', slug: 'gaming-laptops' },
});

const candidates = [
  product({ id: 'mouse', name: 'Gaming Mouse', price: 8495, category: { id: 'm', name: 'Mice', slug: 'mice' } }),
  product({ id: 'bag', name: 'Laptop Backpack', price: 2699, category: { id: 'b', name: 'Bags', slug: 'bags' } }),
  product({ id: 'other-laptop', name: 'Another Laptop', price: 70000, category: { id: 'l', name: 'Gaming Laptops', slug: 'gaming-laptops' } }),
  product({ id: 'oos', name: 'Out Of Stock Mouse', price: 3000, category: { id: 'm', name: 'Mice', slug: 'mice' }, availability: { available: 0, inStock: false, lowStock: false } }),
  product({ id: 'monitor', name: 'Expensive Monitor', price: 120000, category: { id: 'mo', name: 'Monitors', slug: 'monitors' } }),
];

const ranked = rankCrossSell(anchor, candidates, ['gaming'], 5);
const rankedIds = ranked.map((entry) => entry.product.id);

check('ranking returns candidates', ranked.length > 0);
check(
  'a competing product from the same category is excluded',
  !rankedIds.includes('other-laptop'),
  rankedIds.join(','),
);
check('an out-of-stock candidate is excluded', !rankedIds.includes('oos'));
check(
  'an accessory costing more than the anchor is deprioritised',
  rankedIds.indexOf('monitor') === -1 || rankedIds.indexOf('monitor') > rankedIds.indexOf('bag'),
  rankedIds.join(','),
);
check('every candidate carries a reason', ranked.every((entry) => entry.reason.length > 10));
check('every score is 0–100', ranked.every((entry) => entry.score >= 0 && entry.score <= 100));
check(
  'reasons cite the real price',
  ranked.every((entry) => entry.reason.includes('₹')),
  ranked[0]?.reason,
);
check(
  'the anchor itself is never recommended',
  !rankedIds.includes('anchor'),
);

const collegeRanked = rankCrossSell(
  product({ id: 'lap', name: 'IdeaPad', price: 58499, category: { id: 'l', name: 'Laptops', slug: 'laptops' } }),
  candidates,
  ['college'],
  3,
);
check(
  'a college use case favours a bag',
  collegeRanked[0]?.product.id === 'bag',
  collegeRanked.map((entry) => `${entry.product.id}:${entry.score}`).join(','),
);
check(
  'and the reason names the use case',
  /college/i.test(collegeRanked[0]?.reason ?? ''),
  collegeRanked[0]?.reason,
);

check(
  'ranking is deterministic',
  JSON.stringify(rankCrossSell(anchor, candidates, ['gaming'], 5).map((e) => e.product.id)) ===
    JSON.stringify(rankedIds),
);

section('Product variants');

const {
  variantBase,
  storageLabel,
  statedStorage,
  storageOptionsOf,
  coloursFromImageKeys,
  statedColour,
  describeOptions,
} = await import('../lib/ai/variants.ts');

check('storage is stripped to a family name', variantBase('iPhone 17 512 GB') === 'iPhone 17');
check('a Pro stays a Pro', variantBase('iPhone 17 Pro 1 TB') === 'iPhone 17 Pro');
check(
  'a name without storage is unchanged',
  variantBase('TUF Gaming A14 (2024)') === 'TUF Gaming A14 (2024)',
);
check('the storage label is normalised', storageLabel('iPhone 17 Pro 1 TB') === '1 TB');
check('no storage label when there is none', storageLabel('MacBook Pro M5 Pro') === null);

const sizes = [
  { id: 'a', label: '256 GB' },
  { id: 'b', label: '512 GB' },
  { id: 'c', label: '1 TB' },
];
check('"512 GB" picks the 512', statedStorage('512 GB', sizes) === 'b');
check('"512gb" picks the 512', statedStorage('the 512gb one please', sizes) === 'b');
check('"1 TB" picks the terabyte', statedStorage('1 TB', sizes) === 'c');
check('a bare "256" is enough when unique', statedStorage('256', sizes) === 'a');
check('an unrelated message picks nothing', statedStorage('show me laptops', sizes) === null);

// The bug this guards: two phones offered at the same size must not resolve to
// whichever happened to come back from the search first.
const ambiguous = [
  { id: 'iphone16', label: '256 GB' },
  { id: 'iphone17', label: '256 GB' },
  { id: 'iphone17-512', label: '512 GB' },
];
check(
  'an ambiguous size resolves to nothing rather than guessing',
  statedStorage('256 GB', ambiguous) === null,
  String(statedStorage('256 GB', ambiguous)),
);
check(
  'an unambiguous size in the same set still resolves',
  statedStorage('512 GB', ambiguous) === 'iphone17-512',
);

check(
  'storage options skip products with no size',
  storageOptionsOf([
    { id: 'x', name: 'iPhone 17 256 GB' },
    { id: 'y', name: 'MacBook Pro M5' },
  ]).length === 1,
);

// Colours are read from image keys, which use three different conventions in
// the source folders.
const colours = coloursFromImageKeys([
  'products/x/base.webp',
  'products/x/colour-mist-blue.webp',
  'products/x/color-pink.webp',
  'products/x/cosmic-orange.webp',
]);
check('the base image is not a colour', !colours.includes('Base'), colours.join(','));
check('"colour-" is stripped and title-cased', colours.includes('Mist Blue'), colours.join(','));
check('"color-" is stripped too', colours.includes('Pink'), colours.join(','));
check('a bare colour filename is kept', colours.includes('Cosmic Orange'), colours.join(','));

check('a named colour is matched', statedColour('I want the Sage one', ['Black', 'Sage']) === 'Sage');
check('a one-word answer is matched', statedColour('sage', ['Black', 'Sage']) === 'Sage');
check(
  'the longer colour wins over a substring',
  statedColour('titanium black please', ['Black', 'Titanium Black']) === 'Titanium Black',
);
check('a colour we do not stock matches nothing', statedColour('teal', ['Black', 'White']) === null);

check('options render for a sentence', describeOptions({ colour: 'Sage' }) === ' (Sage)');
check('no options render as nothing', describeOptions({}) === '');

console.log(`\n${'='.repeat(56)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
