/**
 * Provider-contract tests using a mock AIProvider.
 *
 *   node scripts/test-ai-provider.mjs
 *
 * No API key needed. These cover the parts of the LLM path that cannot be
 * checked by running in deterministic mode:
 *   - the model's reading is merged with the rules, and the rules win where
 *     they are confident ("never trust the LLM", §39)
 *   - a hallucinated category, brand or spec key is discarded
 *   - a provider failure degrades to the deterministic path instead of erroring
 *   - malformed model output is rejected by the schema, not absorbed
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./scripts/ts-loader.mjs', pathToFileURL('./'));

const { extractRequirements } = await import('../lib/ai/requirements/extract.ts');
const { AIProviderError } = await import('../lib/ai/provider/types.ts');

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
  { slug: 'headphones', name: 'Headphones' },
  { slug: 'smartphones', name: 'Smartphones' },
];
const BRANDS = ['ASUS', 'Apple', 'Lenovo', 'boAt'];

const CONTEXT = {
  vocabulary: VOCAB,
  knownBrands: BRANDS,
  previous: null,
  lastShownProductIds: [],
};

/** A provider whose structured output we control exactly. */
function mockProvider(structured, options = {}) {
  return {
    name: options.name ?? 'mock',
    model: 'mock-1',
    available: options.available ?? true,
    async generateResponse() {
      if (options.throwOnGenerate) throw new AIProviderError('boom', undefined, true);
      return { text: options.text ?? 'Mock prose.', provider: 'mock', model: 'mock-1' };
    },
    async generateStructuredOutput() {
      if (options.throwOnStructured) throw new AIProviderError('boom', undefined, true);
      return structured;
    },
    async executeToolCalls() {
      throw new AIProviderError('not supported');
    },
  };
}

const baseOutput = {
  intent: 'recommend',
  category_slug: null,
  budget_min: null,
  budget_max: null,
  use_cases: [],
  preferences: [],
  brands: [],
  spec_constraints: [],
  require_in_stock: false,
  min_rating: null,
  keywords: [],
  referenced_positions: [],
  is_refinement: false,
};

console.log(`ShopiQ AI provider-contract tests\n${'='.repeat(56)}`);

// ================================================= the model fills the gaps
section('The model supplies what the rules miss');

const paraphrase = await extractRequirements(
  'I want a machine for building software, nothing too pricey',
  CONTEXT,
  mockProvider({
    ...baseOutput,
    category_slug: 'laptops',
    use_cases: ['programming'],
  }),
);

check('model-supplied category is used', paraphrase.requirements.categorySlug === 'laptops');
check('model-supplied use case is used', paraphrase.requirements.useCases.includes('programming'));
check('deterministic flag is false when the model ran', paraphrase.deterministic === false);

// =============================================== the rules override the model
section('The rules override the model where they are confident');

const conflicting = await extractRequirements(
  'laptop under 80k',
  CONTEXT,
  // The model claims a different budget and category than the text states.
  mockProvider({
    ...baseOutput,
    category_slug: 'headphones',
    budget_max: 500000,
  }),
);

check(
  'the stated budget wins over the model',
  conflicting.requirements.budget.max === 80000,
  String(conflicting.requirements.budget.max),
);
check(
  'the stated category wins over the model',
  conflicting.requirements.categorySlug === 'laptops',
  conflicting.requirements.categorySlug,
);

const weightConflict = await extractRequirements(
  'nothing heavier than 2kg',
  CONTEXT,
  mockProvider({
    ...baseOutput,
    spec_constraints: [{ key: 'weight_kg', op: 'gte', value: '10', hard: true }],
  }),
);
const weightRule = weightConflict.requirements.specConstraints.find(
  (constraint) => constraint.key === 'weight_kg' && constraint.op === 'lte',
);
check(
  'the rule-derived weight ceiling is kept',
  weightRule?.value === 2,
  JSON.stringify(weightConflict.requirements.specConstraints),
);

// ============================================== hallucinations are discarded
section('Hallucinated values are discarded');

const hallucinated = await extractRequirements(
  'show me something nice',
  CONTEXT,
  mockProvider({
    ...baseOutput,
    // None of these exist in the catalogue vocabulary.
    category_slug: 'flying-cars',
    brands: ['Wayne Enterprises', 'ACME'],
    spec_constraints: [
      { key: 'Warp Drive!!', op: 'gte', value: '9', hard: true },
      { key: 'ram_gb', op: 'gte', value: 'not-a-number', hard: true },
    ],
    min_rating: 47,
    budget_max: -5000,
  }),
);

check(
  'an invented category slug is rejected',
  hallucinated.requirements.categorySlug === null,
  String(hallucinated.requirements.categorySlug),
);
check(
  'invented brands are rejected',
  hallucinated.requirements.brands.length === 0,
  JSON.stringify(hallucinated.requirements.brands),
);
check(
  'a malformed spec key is rejected',
  !hallucinated.requirements.specConstraints.some((constraint) => constraint.key.includes('!')),
  JSON.stringify(hallucinated.requirements.specConstraints),
);
check(
  'a non-numeric value for a numeric op is rejected',
  !hallucinated.requirements.specConstraints.some(
    (constraint) => constraint.key === 'ram_gb' && typeof constraint.value !== 'number',
  ),
);
check(
  'an out-of-range rating is rejected',
  hallucinated.requirements.minRating === null,
  String(hallucinated.requirements.minRating),
);
check(
  'a negative budget is rejected',
  hallucinated.requirements.budget.max === null,
  String(hallucinated.requirements.budget.max),
);

// ================================================ known brands are preserved
section('Real values from the model are kept');

const realBrand = await extractRequirements(
  'show me something from that brand',
  CONTEXT,
  mockProvider({ ...baseOutput, brands: ['asus'] }),
);
check(
  'a real brand is kept and normalised to catalogue casing',
  realBrand.requirements.brands.includes('ASUS'),
  JSON.stringify(realBrand.requirements.brands),
);

// ============================================== provider failure degradation
section('Provider failure degrades, never errors');

const failing = await extractRequirements(
  'gaming laptop under 80 hazaar',
  CONTEXT,
  mockProvider(null, { throwOnStructured: true }),
);

check('extraction still returns a result', failing.requirements !== undefined);
check('it is flagged as deterministic', failing.deterministic === true);
check(
  'the rules still found the budget',
  failing.requirements.budget.max === 80000,
  String(failing.requirements.budget.max),
);
check(
  'the rules still found the category',
  failing.requirements.categorySlug === 'gaming-laptops',
  failing.requirements.categorySlug,
);

const unavailable = await extractRequirements(
  'laptop under 60k',
  CONTEXT,
  mockProvider(null, { available: false }),
);
check('an unavailable provider is not called', unavailable.deterministic === true);
check('the rules still work', unavailable.requirements.budget.max === 60000);

// ============================================================ intent routing
section('Intent routing');

const compareIntent = await extractRequirements(
  'compare the first and second ones',
  { ...CONTEXT, lastShownProductIds: ['id-a', 'id-b', 'id-c'] },
  mockProvider({ ...baseOutput, intent: 'recommend', referenced_positions: [1, 2] }),
);
check(
  'an explicit "compare" phrase overrides the model intent',
  compareIntent.intent === 'compare',
  compareIntent.intent,
);
check(
  'positional references resolve to real product ids',
  JSON.stringify(compareIntent.referencedProductIds) === '["id-a","id-b"]',
  JSON.stringify(compareIntent.referencedProductIds),
);

const outOfRange = await extractRequirements(
  'compare the first and fifth',
  { ...CONTEXT, lastShownProductIds: ['id-a', 'id-b'] },
  mockProvider({ ...baseOutput, referenced_positions: [1, 5] }),
);
check(
  'a reference beyond what was shown is dropped, not guessed',
  JSON.stringify(outOfRange.referencedProductIds) === '["id-a"]',
  JSON.stringify(outOfRange.referencedProductIds),
);

// ============================================================ no assumptions
section('Nothing is assumed');

const sparse = await extractRequirements('I need headphones', CONTEXT, mockProvider(baseOutput));
check('category found', sparse.requirements.categorySlug === 'headphones');
check('budget stays null', sparse.requirements.budget.max === null);
check('use cases stay empty', sparse.requirements.useCases.length === 0);
check('brands stay empty', sparse.requirements.brands.length === 0);
check('rating stays null', sparse.requirements.minRating === null);
check('stock requirement stays false', sparse.requirements.requireInStock === false);
check('constraints stay empty', sparse.requirements.specConstraints.length === 0);

console.log(`\n${'='.repeat(56)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
