/**
 * Unit tests for the deterministic AI core — requirement extraction, hard
 * constraints and scoring. No database, no network, no API key.
 *
 *   npm run test:ai-unit
 *
 * These are the tests that matter most: they cover the parts of the pipeline
 * that must never depend on a model being reachable or well-behaved.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Compile the TypeScript sources on the fly.
register('./scripts/ts-loader.mjs', pathToFileURL('./'));

const {
  extractBudget,
  extractCategory,
  extractUseCases,
  extractPreferences,
  extractSpecConstraints,
  extractStockRequirement,
  extractMinRating,
  extractRequirementsWithRules,
} = await import('../lib/ai/requirements/rules.ts');

const { checkHardConstraints, scoreProduct, rankCandidates, WEIGHTS } = await import(
  '../lib/ai/recommend/engine.ts'
);

const { extractPositionsWithRules, mergeRequirements } = await import(
  '../lib/ai/requirements/extract.ts'
);

const { emptyRequirements } = await import('../lib/ai/types.ts');

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

const VOCAB = [
  { slug: 'laptops', name: 'Laptops' },
  { slug: 'gaming-laptops', name: 'Gaming Laptops' },
  { slug: 'smartphones', name: 'Smartphones' },
  { slug: 'headphones', name: 'Headphones' },
  { slug: 'shoes', name: 'Shoes' },
  { slug: 'monitors', name: 'Monitors' },
  { slug: 'keyboards', name: 'Keyboards' },
  { slug: 'bags', name: 'Bags' },
];

const BRANDS = ['ASUS', 'Apple', 'Lenovo', 'Samsung', 'boAt', 'Sony', 'Nike'];

// ============================================================ budget parsing
section('Budget extraction');

const budgetCases = [
  ['under 80k', null, 80000],
  ['under ₹80,000', null, 80000],
  ['less than ₹80,000', null, 80000],
  ['around 80 thousand', null, 80000],
  ['budget is 75-80k', 75000, 80000],
  ['Budget around 80 hazaar hai', null, 80000],
  ['80 hazaar ke andar', null, 80000],
  ['mujhe 80 hazaar ke andar laptop chahiye', null, 80000],
  ['budget 1.5 lakh', null, 150000],
  ['upto 2500', null, 2500],
  ['maximum ₹5,000', null, 5000],
  ['80k tak', null, 80000],
  ['80 hazaar se kam', null, 80000],
  ['between 60k and 80k', 60000, 80000],
  ['no budget mentioned at all', null, null],
];

for (const [text, expectedMin, expectedMax] of budgetCases) {
  const result = extractBudget(text);
  check(
    `"${text}" → ${expectedMin ?? '-'}/${expectedMax ?? '-'}`,
    result.min === expectedMin && result.max === expectedMax,
    `got ${result.min}/${result.max}`,
  );
}

// ========================================================== category mapping
section('Category extraction');

const categoryCases = [
  ['I need a laptop for college', 'laptops'],
  ['mujhe ek gaming laptop chahiye', 'gaming-laptops'],
  ['looking for a new phone', 'smartphones'],
  ['show me earbuds', 'headphones'],
  ['need running shoes', 'shoes'],
  ['want a mechanical keyboard', 'keyboards'],
  ['a backpack for travel', 'bags'],
  ['I want something nice', null],
];

for (const [text, expected] of categoryCases) {
  const result = extractCategory(text, VOCAB);
  check(
    `"${text}" → ${expected ?? 'null'}`,
    (result?.slug ?? null) === expected,
    `got ${result?.slug ?? 'null'}`,
  );
}

check(
  '"gaming laptop" beats plain "laptop"',
  extractCategory('gaming laptop under 80k', VOCAB)?.slug === 'gaming-laptops',
);

// ================================================================ use cases
section('Use-case extraction');

check(
  'programming + gaming',
  (() => {
    const cases = extractUseCases('Programming bhi karni hai aur thodi gaming bhi');
    return cases.includes('programming') && cases.includes('gaming');
  })(),
);
check('college', extractUseCases('college ke liye chahiye').includes('college'));
check('gym', extractUseCases('something for the gym').includes('gym'));
check('travel', extractUseCases('I travel a lot for work').includes('travel'));
check('no false positives', extractUseCases('show me a red one').length === 0);

// ============================================================== preferences
section('Preference extraction');

check('lightweight → portability', extractPreferences('something lightweight').portability === 'high');
check('lighter → portability', extractPreferences('show me lighter ones').portability === 'high');
check('halka → portability', extractPreferences('thoda halka chahiye').portability === 'high');
check('battery life', extractPreferences('battery life achhi honi chahiye').battery_life === 'high');
check('noise cancellation', extractPreferences('with good noise cancellation').noise_cancellation === 'high');
check('performance', extractPreferences('needs to be really fast').performance === 'high');

// ====================================================== negative constraints
section('Negative / specification constraints');

const weight = extractSpecConstraints("I don't want anything heavier than 2kg");
const weightConstraint = weight.find((entry) => entry.key === 'weight_kg');
check(
  '"heavier than 2kg" → weight_kg lte 2 (hard)',
  weightConstraint?.op === 'lte' && weightConstraint?.value === 2 && weightConstraint?.hard === true,
  JSON.stringify(weightConstraint),
);

const weightHinglish = extractSpecConstraints('2 kg se kam hona chahiye');
check(
  '"2 kg se kam" → weight_kg lte 2',
  weightHinglish.find((entry) => entry.key === 'weight_kg')?.value === 2,
);

const ram = extractSpecConstraints('at least 16GB RAM chahiye');
check(
  '"at least 16GB RAM" → ram_gb gte 16 (hard)',
  (() => {
    const entry = ram.find((item) => item.key === 'ram_gb');
    return entry?.op === 'gte' && entry?.value === 16 && entry?.hard === true;
  })(),
  JSON.stringify(ram),
);

const gpu = extractSpecConstraints('must have an RTX 4060');
check(
  '"RTX 4060" → gpu contains RTX 4060',
  (() => {
    const entry = gpu.find((item) => item.key === 'gpu');
    return entry?.op === 'contains' && String(entry?.value).includes('RTX 4060');
  })(),
  JSON.stringify(gpu),
);

check(
  '"1TB storage" → storage_gb gte 1024',
  extractSpecConstraints('with 1TB storage').find((entry) => entry.key === 'storage_gb')?.value ===
    1024,
);

check('no constraints when none stated', extractSpecConstraints('show me a nice laptop').length === 0);

// ==================================================== stock / rating / misc
section('Stock, rating and referents');

check('"available now" → requireInStock', extractStockRequirement('I need it available now') === true);
check('"abhi chahiye" → requireInStock', extractStockRequirement('abhi chahiye') === true);
check('no stock requirement by default', extractStockRequirement('show me laptops') === false);
check('"4 star and above" → 4', extractMinRating('4 star and above') === 4);
check('"highly rated" → 4', extractMinRating('show me highly rated ones') === 4);
check('no rating stated → null', extractMinRating('show me laptops') === null);

check('"the first one" → [1]', JSON.stringify(extractPositionsWithRules('tell me about the first one')) === '[1]');
check(
  '"compare the first and second" → [1,2]',
  JSON.stringify(extractPositionsWithRules('compare the first and second ones')) === '[1,2]',
);
check(
  '"pehla wala" → [1]',
  JSON.stringify(extractPositionsWithRules('pehla wala better kyun hai?')) === '[1]',
);

// ================================================= full Hinglish extraction
section('Full Hinglish extraction (the §36 scenario)');

const hinglish = extractRequirementsWithRules(
  'Mujhe college ke liye laptop chahiye. Programming aur thodi gaming karni hai. Budget 80 hazaar hai.',
  VOCAB,
  BRANDS,
);

check('category → laptops', hinglish.categorySlug === 'laptops', hinglish.categorySlug);
check('budget max → 80000', hinglish.budget.max === 80000, String(hinglish.budget.max));
check('use case: college', hinglish.useCases.includes('college'));
check('use case: programming', hinglish.useCases.includes('programming'));
check('use case: gaming', hinglish.useCases.includes('gaming'));
check('nothing invented (no brands)', hinglish.brands.length === 0);
check('nothing invented (no rating)', hinglish.minRating === null);
check('nothing invented (no stock rule)', hinglish.requireInStock === false);

// ============================================================ missing info
section('Missing information stays null');

const vague = extractRequirementsWithRules('I need a laptop', VOCAB, BRANDS);
check('category found', vague.categorySlug === 'laptops');
check('budget stays null', vague.budget.max === null && vague.budget.min === null);
check('use cases stay empty', vague.useCases.length === 0);
check('constraints stay empty', vague.specConstraints.length === 0);

// ======================================================== hard constraints
section('Hard constraint enforcement');

const product = (overrides = {}) => ({
  id: overrides.id ?? 'p1',
  name: overrides.name ?? 'Test Laptop',
  slug: 'test-laptop',
  brand: overrides.brand ?? 'ASUS',
  sku: 'SQ-TEST',
  shortDescription: overrides.shortDescription ?? 'A laptop.',
  price: overrides.price ?? 70000,
  compareAtPrice: null,
  currency: 'INR',
  rating: overrides.rating ?? 4.5,
  reviewCount: 100,
  isFeatured: false,
  tags: overrides.tags ?? [],
  specs: overrides.specs ?? { ram_gb: 16, weight_kg: 2.0, gpu: 'NVIDIA RTX 4060 8 GB' },
  category: { id: 'c1', name: 'Laptops', slug: 'laptops' },
  image: null,
  imageAlt: null,
  availability: overrides.availability ?? { available: 5, inStock: true, lowStock: false },
});

const budgetReq = { ...emptyRequirements(), budget: { min: null, max: 80000, currency: 'INR' } };
check(
  '₹70,000 passes an ₹80,000 budget',
  checkHardConstraints(product({ price: 70000 }), budgetReq).passes,
);
check(
  '₹95,000 FAILS an ₹80,000 budget',
  checkHardConstraints(product({ price: 95000 }), budgetReq).passes === false,
);

const stockReq = { ...emptyRequirements(), requireInStock: true };
check(
  'out-of-stock fails "available now"',
  checkHardConstraints(
    product({ availability: { available: 0, inStock: false, lowStock: false } }),
    stockReq,
  ).passes === false,
);

const weightReq = {
  ...emptyRequirements(),
  specConstraints: [{ key: 'weight_kg', op: 'lte', value: 2, hard: true }],
};
check(
  '2.2kg fails a 2kg ceiling',
  checkHardConstraints(product({ specs: { weight_kg: 2.2 } }), weightReq).passes === false,
);
check(
  '1.8kg passes a 2kg ceiling',
  checkHardConstraints(product({ specs: { weight_kg: 1.8 } }), weightReq).passes,
);
check(
  'a product with no weight spec fails a weight ceiling',
  checkHardConstraints(product({ specs: { ram_gb: 16 } }), weightReq).passes === false,
);

const ramReq = {
  ...emptyRequirements(),
  specConstraints: [{ key: 'ram_gb', op: 'gte', value: 16, hard: true }],
};
check('8GB fails a 16GB floor', checkHardConstraints(product({ specs: { ram_gb: 8 } }), ramReq).passes === false);
check('32GB passes a 16GB floor', checkHardConstraints(product({ specs: { ram_gb: 32 } }), ramReq).passes);

const brandReq = { ...emptyRequirements(), brands: ['Apple'] };
check(
  'ASUS fails an Apple-only request',
  checkHardConstraints(product({ brand: 'ASUS' }), brandReq).passes === false,
);

// ================================================================== scoring
section('Scoring');

const weightsSum = Object.values(WEIGHTS).reduce((sum, value) => sum + value, 0);
check('weights sum to 100', weightsSum === 100, String(weightsSum));

const req = {
  ...emptyRequirements(),
  categorySlug: 'laptops',
  budget: { min: null, max: 80000, currency: 'INR' },
  useCases: ['programming', 'gaming'],
};

const strong = scoreProduct(
  product({
    price: 75000,
    rating: 4.6,
    specs: { ram_gb: 32, storage_gb: 1024, refresh_rate_hz: 144, weight_kg: 2.2 },
    tags: ['gaming', 'programming'],
  }),
  req,
);
const weak = scoreProduct(
  product({
    price: 79000,
    rating: 4.0,
    specs: { ram_gb: 8, storage_gb: 256, refresh_rate_hz: 60, weight_kg: 2.4 },
    tags: [],
  }),
  req,
);

check('better specs score higher', strong.score > weak.score, `${strong.score} vs ${weak.score}`);
check('score stays within 0–100', strong.score <= 100 && weak.score >= 0);
check('match reasons are produced', strong.matchReasons.length > 0);
check(
  'reasons cite real values',
  strong.matchReasons.some((reason) => /32|GB|₹/.test(reason)),
  JSON.stringify(strong.matchReasons),
);

const overBudget = scoreProduct(product({ price: 95000 }), req);
check(
  'over-budget product is flagged as a limitation',
  overBudget.limitations.some((limitation) => limitation.includes('over your budget')),
  JSON.stringify(overBudget.limitations),
);

const outOfStock = scoreProduct(
  product({ availability: { available: 0, inStock: false, lowStock: false } }),
  req,
);
check(
  'out-of-stock is flagged as a limitation',
  outOfStock.limitations.some((limitation) => limitation.includes('out of stock')),
);

check(
  'scoring is deterministic across runs',
  scoreProduct(product({ price: 75000 }), req).score ===
    scoreProduct(product({ price: 75000 }), req).score,
);

// ================================================================= ranking
section('Ranking and relaxation');

const candidates = [
  product({ id: 'a', name: 'In budget, great specs', price: 78000, specs: { ram_gb: 32, weight_kg: 2.2 } }),
  product({ id: 'b', name: 'In budget, weak specs', price: 60000, specs: { ram_gb: 8, weight_kg: 2.4 } }),
  product({ id: 'c', name: 'Over budget', price: 120000, specs: { ram_gb: 32, weight_kg: 1.9 } }),
];

const ranked = rankCandidates(candidates, req, { limit: 3 });
check('outcome is "matches"', ranked.kind === 'matches', ranked.kind);
check(
  'over-budget product is excluded entirely',
  ranked.kind === 'matches' && !ranked.recommendations.some((entry) => entry.product.id === 'c'),
);
check(
  'best specs rank first',
  ranked.kind === 'matches' && ranked.recommendations[0].product.id === 'a',
  ranked.kind === 'matches' ? ranked.recommendations[0].product.id : '',
);

const tightBudget = { ...req, budget: { min: null, max: 50000, currency: 'INR' } };
const relaxed = rankCandidates(candidates, tightBudget, { limit: 3 });
check('nothing under budget → "relaxed", not silence', relaxed.kind === 'relaxed', relaxed.kind);
check(
  'relaxation is named',
  relaxed.kind === 'relaxed' && relaxed.relaxed.length > 0,
  relaxed.kind === 'relaxed' ? relaxed.relaxed.join(',') : '',
);
check(
  'relaxed results still carry the over-budget caveat',
  relaxed.kind === 'relaxed' &&
    relaxed.recommendations[0].limitations.some((limitation) =>
      limitation.includes('over your budget'),
    ),
);

check('empty candidate list → "empty"', rankCandidates([], req).kind === 'empty');

// ====================================================== conversation state
section('Conversation state merging');

const turn1 = {
  ...emptyRequirements(),
  categorySlug: 'laptops',
  category: 'Laptops',
  budget: { min: null, max: 80000, currency: 'INR' },
};
const turn2 = { ...emptyRequirements(), useCases: ['programming', 'gaming'] };
const merged = mergeRequirements(turn1, turn2, false);

check('budget survives the next turn', merged.budget.max === 80000);
check('category survives the next turn', merged.categorySlug === 'laptops');
check('new use cases are added', merged.useCases.length === 2);

const turn3 = { ...emptyRequirements(), preferences: { portability: 'high' } };
const merged3 = mergeRequirements(merged, turn3, true);
check('"lighter ones" keeps the earlier budget', merged3.budget.max === 80000);
check('"lighter ones" keeps the earlier use cases', merged3.useCases.length === 2);
check('"lighter ones" adds the preference', merged3.preferences.portability === 'high');

const newCategory = {
  ...emptyRequirements(),
  categorySlug: 'headphones',
  category: 'Headphones',
};
const switched = mergeRequirements(merged3, newCategory, false);
check('switching category drops the old use cases', switched.useCases.length === 0);
check('switching category keeps the budget', switched.budget.max === 80000);

// ================================================================= language
section('Reply language detection');

const { detectLanguage } = await import('../lib/ai/language.ts');

const LANGUAGE_CASES = [
  // [message, sticky previous language, expected]
  ['Mujhe 90 hazaar ke andar phone chahiye', null, 'hinglish'],
  ['gaming laptop dikhao', null, 'hinglish'],
  ['sabse sasta wala batao', null, 'hinglish'],
  ['show me gaming laptops under 80000', null, 'en'],
  ['what is the price of the MacBook Pro M5 Pro Max', null, 'en'],
  // Must NOT read as Hindi: "do" and "to" are deliberately not markers, or
  // every English cart instruction would be translated.
  ['add the 2 TB one to my cart', null, 'en'],
  ['I want to compare these two', null, 'en'],
  // An explicit instruction beats the shape of the sentence.
  ['reply in hindi', null, 'hi'],
  ['answer in english please', 'hi', 'en'],
  // Stickiness: a one-word answer carries no language evidence of its own.
  ['haan', 'hi', 'hi'],
  ['yes', 'hinglish', 'hinglish'],
  ['ok', 'en', 'en'],
];

for (const [message, previous, expected] of LANGUAGE_CASES) {
  const got = detectLanguage(message, previous);
  check(
    '"' + message.slice(0, 40) + '" (prev=' + (previous ?? 'none') + ') -> ' + expected,
    got === expected,
    'got ' + got,
  );
}

const devanagari = detectLanguage('मुझे एक अच्छा फोन चाहिए', null);
check('Devanagari input is detected as Hindi', devanagari === 'hi', 'got ' + devanagari);

// ================================================================== account
section('Account intent routing');

// The bug this guards: none of these intents existed, so every account request
// fell through to the product classifier. "change my phone number" searched the
// smartphone category and "add a new address" offered to add a Galaxy S26. The
// tools were registered the whole time — nothing routed to them.
const ACCOUNT_VOCAB = [
  { slug: 'smartphones', name: 'Smartphones' },
  { slug: 'laptops', name: 'Laptops' },
  { slug: 'gaming-laptops', name: 'Gaming Laptops' },
];
const ACCOUNT_BRANDS = ['Apple', 'Samsung', 'ASUS', 'Sony'];
const NO_PROVIDER = { name: 'none', available: false };

const { extractRequirements } = await import('../lib/ai/requirements/extract.ts');

async function intentOf(message) {
  const result = await extractRequirements(
    message,
    { vocabulary: ACCOUNT_VOCAB, knownBrands: ACCOUNT_BRANDS, previous: null, lastShownProductIds: [] },
    NO_PROVIDER,
  );
  return result.intent;
}

const ACCOUNT_CASES = [
  ['what is my profile', 'profile_view'],
  ['show me my account details', 'profile_view'],
  ['who am I', 'profile_view'],
  ['change my phone number to +91 98765 43210', 'profile_update'],
  ['update my name to Yash Garg', 'profile_update'],
  ['what are my saved addresses', 'address_list'],
  ['show my addresses', 'address_list'],
  ['add a new address', 'address_add'],
  ['show me my orders', 'order_list'],
  ['list all my orders', 'order_list'],
  ['order history', 'order_list'],
  ['cancel my order', 'order_cancel'],
  ['I want to return this order', 'order_support'],
  ['replacement for my order', 'order_support'],
  // A stated order number is enough on its own.
  ['what is the status of order SQ-2026-1055', 'order_status'],
];

for (const [message, expected] of ACCOUNT_CASES) {
  const got = await intentOf(message);
  check('"' + message.slice(0, 42) + '" -> ' + expected, got === expected, 'got ' + got);
}

// The other half of the guard: shopping must NOT be swallowed by the account
// patterns. Every one of these contains a word an account pattern looks for.
const NOT_ACCOUNT = [
  'show me phones under 90000',
  'I want to buy a new phone',
  'add iPhone 17 to my cart',
  'add the first one',
  'what is in my cart',
  'gaming laptop dikhao',
  'compare the first and second',
];

for (const message of NOT_ACCOUNT) {
  const got = await intentOf(message);
  check(
    '"' + message.slice(0, 42) + '" stays a shopping intent',
    !/^(profile_|address_|order_list|order_cancel|order_support)/.test(got),
    'got ' + got,
  );
}

// ================================================================== summary
console.log(`\n${'='.repeat(56)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
