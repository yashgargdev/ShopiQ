/**
 * Catalogue architecture tests.
 *
 *   npm run test:catalog
 *
 * No database, no network, no API key. These exercise the parts that decide
 * what gets recommended — the rule engine, compatibility, ranking and the
 * compact AI context — against the fixture in data/catalog/fixtures, which is
 * NOT the ShopiQ catalogue and is never imported anywhere.
 *
 * The point of most of these is the negative case. A recommender that returns
 * something plausible for every question looks fine in a demo and is wrong in
 * exactly the situations that cost money: parts that do not fit, screens a
 * console cannot drive, an empty catalogue answered with a guess.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

register('./scripts/ts-loader.mjs', pathToFileURL('./'));

const { validateCatalogConfig, validateSchemaFile, categoryWithDescendants, categoryAncestors, categoryExists, rankingProfile, settingValue } =
  await import('../lib/catalog/config.ts');
const { matchesRule, matchesCondition, targetsFor, satisfiesTargetRequirements, ecosystemBoost, readField } =
  await import('../lib/catalog/rules.ts');
const { assessCompatibility, filterCompatible } = await import('../lib/catalog/compatibility.ts');
const {
  scoreWith, diversify, budgetFit, useCaseFit, performanceFit, ratingFit,
  valueFit, priceProportionFit, relationshipFit, availabilityFit, isExcluded,
} = await import('../lib/catalog/ranking.ts');
const { keySpecsFor, toCompact } = await import('../lib/catalog/context.ts');

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

// The fixture, as rule subjects.
const fixture = JSON.parse(fs.readFileSync('data/catalog/fixtures/test-catalog.json', 'utf8'));
const subjects = Object.fromEntries(
  fixture.products.map((product) => [
    product.id,
    {
      id: product.id,
      product_family: product.product_family ?? null,
      category: product.category,
      brand: product.brand,
      price: product.pricing.selling_price,
      segments: product.segments ?? [],
      use_cases: product.use_cases ?? [],
      tags: product.tags ?? [],
      specifications: product.specifications ?? {},
      performance: product.performance ?? {},
      compatibility_facts: product.compatibility ?? {},
    },
  ]),
);

// ============================================================ configuration
section('Catalogue configuration');

const problems = validateCatalogConfig();
check(
  'taxonomy, vocabulary, rules and ranking agree',
  problems.length === 0,
  problems.map((p) => `${p.file}: ${p.problem}`).join(' | '),
);

const schemaProblems = validateSchemaFile();
check(
  'schema.json describes the documented product shape',
  schemaProblems.length === 0,
  schemaProblems.map((p) => p.problem).join(' | '),
);

check('the fixture is marked as a demo dataset', fixture.demo_dataset === true);
check(
  'every fixture product names a real category',
  fixture.products.every((product) => categoryExists(product.category)),
);
check(
  'no fixture product invents an image URL',
  fixture.products.every((product) => (product.images ?? []).length === 0),
);

// ================================================================= taxonomy
section('Taxonomy');

check('a parent includes its children', categoryWithDescendants('laptops').includes('gaming-laptops'));
check('a leaf includes itself', categoryWithDescendants('ssd').includes('ssd'));
check('ancestors walk to the root', categoryAncestors('gaming-laptops').includes('electronics'));
check('an unknown slug has no ancestors', categoryAncestors('nonsense').length === 0);
check('an unknown category is reported as unknown', categoryExists('nonsense') === false);

// ============================================================ rule operators
section('Rule operators');

const laptop = subjects['fx-tuf-a15-16-512'];

check('equals (bare shorthand)', matchesCondition(laptop, 'brand', 'ASUS'));
check('equals is case-insensitive', matchesCondition(laptop, 'brand', 'asus'));
check('not_equals', matchesCondition(laptop, 'brand', { not_equals: 'Lenovo' }));
check('greater_than', matchesCondition(laptop, 'specifications.ram_gb', { greater_than: 8 }));
check('greater_than is strict', !matchesCondition(laptop, 'specifications.ram_gb', { greater_than: 16 }));
check('greater_than_or_equal', matchesCondition(laptop, 'specifications.ram_gb', { greater_than_or_equal: 16 }));
check('less_than', matchesCondition(laptop, 'price', { less_than: 100000 }));
check('less_than_or_equal', matchesCondition(laptop, 'price', { less_than_or_equal: 74999 }));
check('contains on a list', matchesCondition(laptop, 'segments', { contains: 'gaming' }));
check('contains on a string', matchesCondition(laptop, 'specifications.gpu', { contains: 'RTX' }));
check('in', matchesCondition(laptop, 'category', { in: ['laptops', 'phones'] }));
check('not_in', matchesCondition(laptop, 'brand', { not_in: ['Apple', 'Google'] }));
check('exists', matchesCondition(laptop, 'specifications.gpu', { exists: true }));
check('exists:false asserts absence', matchesCondition(laptop, 'specifications.camera_mp', { exists: false }));

// A range comparison against something non-numeric is unanswerable. Answering
// it either way would silently admit or drop products on a comparison that
// never happened.
check(
  'a range against a non-numeric value is false, not true',
  !matchesCondition(laptop, 'specifications.processor', { greater_than: 5 }),
);
check('an unknown field does not match', !matchesCondition(laptop, 'specifications.nonsense', { exists: true }));
check('several operators on one field are ANDed', matchesRule(laptop, { price: { greater_than: 50000, less_than: 80000 } }));
check('a category rule matches a subcategory', matchesCondition(laptop, 'category', 'laptops'));
check('readField walks a dotted path', readField(laptop, 'specifications.ram_gb') === 16);

// ============================================================ rule matching
section('Recommendation rules');

const laptopTargets = targetsFor(laptop);
check('a gaming laptop matches rules', laptopTargets.length > 0);
check(
  'gaming accessories are the top target',
  laptopTargets[0]?.category === 'gaming-accessories',
  laptopTargets.map((t) => t.category).join(','),
);
check('every target carries a reason', laptopTargets.every((t) => t.reason && t.reason.length > 8));
check('targets are de-duplicated by category', new Set(laptopTargets.map((t) => `${t.category}:${t.type}`)).size === laptopTargets.length);

const phoneTargets = targetsFor(subjects['fx-galaxy-s-12-256']);
check('a phone matches the phone rules', phoneTargets.some((t) => t.category === 'phone-accessories'));
check('a phone does NOT match gaming laptop rules', !phoneTargets.some((t) => t.category === 'gaming-accessories'));

const consoleTargets = targetsFor(subjects['fx-console']);
check('a console matches the ecosystem rule', consoleTargets.some((t) => t.category === 'controllers'));

// ===================================================== television for a console
section('PS5 television requirement (section 24)');

const tvTarget = consoleTargets.find((t) => t.category === 'televisions');
check('the console rule offers televisions', Boolean(tvTarget));
check('the television target carries a requirement', Boolean(tvTarget?.require));
check(
  'a 4K 120Hz HDMI 2.1 television qualifies',
  satisfiesTargetRequirements(subjects['fx-tv-55-4k120'], tvTarget),
);
check(
  'a 60Hz HDMI 2.0 television does NOT qualify',
  !satisfiesTargetRequirements(subjects['fx-tv-43-60hz'], tvTarget),
  'a screen the console cannot drive must not be offered as one it can',
);

// ============================================================ compatibility
section('Compatibility');

const desktopRam = subjects['fx-ram-32-dimm'];
const laptopRam = subjects['fx-ram-32-sodimm'];
const desktopAnchor = { category: 'pc-components', compatibility_facts: { attributes: { form_factor: 'DIMM', memory_type: 'DDR5' } } };

check('DIMM memory fits a DIMM board', assessCompatibility(desktopAnchor, desktopRam).verdict === 'compatible');
check(
  'SO-DIMM memory does NOT fit a desktop board',
  assessCompatibility(desktopAnchor, laptopRam).verdict === 'incompatible',
  'section 77: recommending a stick that will not fit is worse than recommending nothing',
);
check(
  'the incompatibility says why',
  assessCompatibility(desktopAnchor, laptopRam).reasons[0]?.includes('form factor'),
  assessCompatibility(desktopAnchor, laptopRam).reasons.join(','),
);

const sleeve = subjects['fx-sleeve-14'];
check(
  'a 13-14" sleeve does not fit a 15.6" laptop',
  assessCompatibility(laptop, sleeve).verdict === 'incompatible',
);
check(
  'the same sleeve fits a 14" laptop',
  assessCompatibility(subjects['fx-thinkbook-14'], sleeve).verdict === 'compatible',
);

check(
  'an unknown fit is "unknown", never assumed compatible',
  assessCompatibility({ category: 'phones' }, { category: 'ssd' }).verdict === 'unknown',
);
check(
  'filterCompatible drops the incompatible and keeps the unknown',
  filterCompatible(desktopAnchor, [desktopRam, laptopRam]).length === 1,
);

check(
  'an accepted accessory type is recognised',
  assessCompatibility(laptop, subjects['fx-gaming-mouse']).reasons.some((r) => r.includes('gaming mouse')),
  assessCompatibility(laptop, subjects['fx-gaming-mouse']).reasons.join(','),
);

// ================================================================== ranking
section('Ranking signals');

check('budget fit is full under budget', budgetFit(50000, 60000) === 1);
check('budget fit degrades above budget', budgetFit(66000, 60000) < 1 && budgetFit(66000, 60000) > 0);
check('budget fit bottoms out well over', budgetFit(200000, 60000) === 0);
check('no budget means no signal, not a zero', budgetFit(50000, null) === null);

check('use-case fit is proportional', useCaseFit(['gaming', 'programming'], ['gaming']) === 0.5);
check('no stated use case means no signal', useCaseFit([], ['gaming']) === null);
check('a product declaring none scores zero', useCaseFit(['gaming'], []) === 0);

check('performance fit reads the asked-for dimensions', performanceFit(['gaming'], { gaming: 9 }) === 0.9);
check('an unrated product yields no signal', performanceFit(['gaming'], undefined) === null);

check('an unreviewed product sits mid-table, not last', ratingFit(0, 0) === 0.5);
check(
  'many good reviews beat one perfect review',
  ratingFit(4.5, 200) > ratingFit(5, 1),
  `${ratingFit(4.5, 200)} vs ${ratingFit(5, 1)}`,
);

check('value rewards the cheaper-than-median', valueFit(50000, 80000) === 1);
check('value punishes well over median', valueFit(200000, 80000) === 0);

check('a cheap accessory is proportional', priceProportionFit(1299, 74999) === 1);
check('an accessory dearer than its anchor scores zero', priceProportionFit(90000, 74999) === 0);

check('relationship priority maps to 0-1', relationshipFit(10) === 1 && relationshipFit(5) === 0.5);
check('out of stock scores zero', availabilityFit(0) === 0);

// ========================================================== score + reasons
section('Scoring and explanations');

const scored = scoreWith(
  {
    item: { id: 'x' },
    signals: { relationship: 1, compatibility: 1, priceProportion: 1, rating: 0.8, availability: 1 },
    reasons: ['Useful for gaming', 'Within budget'],
  },
  'accessory',
);

check('a score is 0-1', scored.score > 0 && scored.score <= 1, String(scored.score));
check('the breakdown names each weighted signal', Object.keys(scored.breakdown).length === 5);
check(
  'section 81: a score never travels without reasons',
  scored.reasons.length > 0,
);
check('reasons are capped, not unbounded', scoreWith(
  { item: {}, signals: { rating: 1 }, reasons: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
  'accessory',
).reasons.length <= 5);

// A profile only scores the signals it weights, normalised by what was
// present — otherwise a profile scoring 4 of 6 signals is permanently capped.
const partial = scoreWith({ item: {}, signals: { rating: 1 }, reasons: ['r'] }, 'accessory');
check('a partial signal set still reaches a full score', partial.score === 1, String(partial.score));

// ================================================================ diversity
section('Diversity (section 51)');

const sameBrand = ['ASUS', 'ASUS', 'ASUS', 'Lenovo', 'HP'].map((brand, index) => ({
  item: { brand, id: `p${index}` },
  score: 1 - index * 0.01,
  breakdown: {},
  reasons: ['r'],
}));

const spread = diversify(sameBrand, (item) => item.brand, { maxPerBrand: 2, limit: 3 });
check('the brand cap is applied', spread.filter((e) => e.item.brand === 'ASUS').length <= 2);
check('three results are still returned', spread.length === 3);
check('the cap does not starve the result', diversify(sameBrand, (i) => i.brand, { maxPerBrand: 1, limit: 5 }).length === 5);

// ======================================================= negative preferences
section('Negative preferences (section 49)');

check('an excluded brand is filtered out', isExcluded(laptop, { brands: ['ASUS'] }) !== null);
check('exclusion is case-insensitive', isExcluded(laptop, { brands: ['asus'] }) !== null);
check('an unrelated brand is kept', isExcluded(laptop, { brands: ['Apple'] }) === null);
check('a weight ceiling excludes the heavy one', isExcluded(laptop, { maxWeightKg: 1.5 }) !== null);
check('the same ceiling keeps the light one', isExcluded(subjects['fx-thinkbook-14'], { maxWeightKg: 1.5 }) === null);
check('an excluded category is filtered out', isExcluded(laptop, { categories: ['gaming-laptops'] }) !== null);
check('an already-seen product is filtered out', isExcluded(laptop, { productIds: [laptop.id] }) !== null);
check('the exclusion explains itself', typeof isExcluded(laptop, { brands: ['ASUS'] }) === 'string');

// ========================================================== brand ecosystem
section('Brand ecosystem (section 23)');

check(
  'a Sony console boosts a Sony television',
  ecosystemBoost('Sony', subjects['fx-tv-55-4k120']) > 0,
);
check(
  'it does not boost another brand',
  ecosystemBoost('Sony', subjects['fx-tv-43-60hz']) === 0,
);
check(
  'it does not boost an unrelated category',
  ecosystemBoost('Sony', subjects['fx-ram-32-dimm']) === 0,
);

// ============================================================= AI context
section('Compact AI context (section 60)');

const product = {
  id: 'p1',
  name: 'Fixture Laptop',
  brand: 'ASUS',
  price: 74999,
  compareAtPrice: 89999,
  rating: 4.4,
  reviewCount: 120,
  tags: [],
  specs: { gpu: 'RTX 4060', ram_gb: 16, storage_gb: 512, processor: 'Ryzen 7', weight_kg: 2.2, nonsense_key: 'x' },
  category: { id: 'c', name: 'Gaming Laptops', slug: 'gaming-laptops' },
  availability: { available: 12, inStock: true, lowStock: false },
};

const compact = toCompact(product, { score: 0.91, reasons: ['Within budget'] });
check('the compact form is small', Object.keys(compact).length <= 11, String(Object.keys(compact).length));
check('key specs are trimmed', Object.keys(compact.key_specs).length <= 5);
check('the deciding spec leads', 'gpu' in compact.key_specs);
check('a genuine MRP is included', compact.mrp === 89999);
check(
  'an MRP equal to the price is NOT presented as a saving',
  toCompact({ ...product, compareAtPrice: 74999 }).mrp === undefined,
);
check('an unreviewed product carries no rating', toCompact({ ...product, reviewCount: 0 }).rating === undefined);
check('score and reasons ride along', compact.score === 0.91 && compact.reasons.length === 1);
check(
  'an unknown category still yields specs',
  Object.keys(keySpecsFor('nonsense', { ram_gb: 8 })).length > 0,
);

// ================================================================== config
section('Configurable weights (section 46)');

const shopping = rankingProfile('shopping');
check('the default profile sums to 100', Object.values(shopping).reduce((a, b) => a + b, 0) === 100);
check('an unknown profile falls back to the default', JSON.stringify(rankingProfile('nope')) === JSON.stringify(shopping));
check('the accessory profile exists', Object.keys(rankingProfile('accessory')).length > 0);
check('settings are read from the file', settingValue('max_recommendations', 99) === 3);
check('a missing setting falls back', settingValue('nonexistent', 42) === 42);

// ================================================================== summary
console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
