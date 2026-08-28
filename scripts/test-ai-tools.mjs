/**
 * Integration tests for the AI tool layer against the real ShopiQ catalogue.
 *
 *   node -r dotenv/config scripts/test-ai-tools.mjs dotenv_config_path=.env.local
 *
 * Covers all six tools, the allowlist, argument validation, the tool budget,
 * and the audit log. Runs with the anonymous Supabase role — the same reach
 * the AI actually has.
 */
import 'dotenv/config';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

register('./scripts/ts-loader.mjs', pathToFileURL('./'));

const { runTool, TOOL_NAMES, isToolName, ToolBudget, providerToolDefinitions, toolMetadata } = await import(
  '../lib/ai/tools/registry.ts'
);
const { toDbSpecFilters } = await import('../lib/ai/tools/schemas.ts');

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
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

// A throwaway conversation so tool-log rows can be asserted and cleaned up.
const { data: conversation } = await admin
  .from('conversations')
  .insert({ session_token: `tooltest-${Date.now()}`, state: {} })
  .select('id')
  .single();
const conversationId = conversation.id;

console.log(`ShopiQ AI tool tests\n${'='.repeat(56)}`);

// ============================================================== the registry
section('Registry and allowlist');

// Phase 2 registered six read-only tools; Phase 3 added the cart and
// checkout-preview tools, four of which mutate. What must stay true is that
// nothing here can place an order or take money.
check(
  'every registered tool has a unique name',
  new Set(TOOL_NAMES).size === TOOL_NAMES.length && TOOL_NAMES.length >= 16,
  TOOL_NAMES.join(','),
);
check(
  'the Phase 2 read tools are all still there',
  ['search_products', 'get_product', 'compare_products', 'check_inventory', 'get_categories', 'get_related_products'].every(
    (name) => TOOL_NAMES.includes(name),
  ),
);
// Phase 4 added create_payment deliberately — the assistant may START a
// payment the customer approved. What must still not exist is any tool that
// creates an order directly, or that settles, captures or refunds money:
// an order appears only after server-side verification of a real payment.
check(
  'no tool creates an order or settles money',
  !TOOL_NAMES.some((name) =>
    /create_order|place_order|verify_payment|capture_payment|settle|refund/i.test(name),
  ),
  TOOL_NAMES.join(','),
);
check(
  'exactly one tool can start a charge',
  TOOL_NAMES.filter((name) => toolMetadata(name).level === 4 && toolMetadata(name).mutates)
    .length === 1,
  TOOL_NAMES.filter((name) => toolMetadata(name).level === 4).join(','),
);
check('isToolName rejects a made-up name', isToolName('drop_table') === false);

const unknown = await runTool('delete_all_products', {}, { conversationId });
check('unknown tool is rejected', unknown.ok === false && unknown.code === 'UNKNOWN_TOOL');
check(
  'rejection lists the allowed tools',
  unknown.ok === false && unknown.error.includes('search_products'),
);

const sqlish = await runTool("search_products'; DROP TABLE products;--", {}, { conversationId });
check('SQL-looking tool name is rejected, not executed', sqlish.ok === false && sqlish.code === 'UNKNOWN_TOOL');

const definitions = providerToolDefinitions();
check(
  'JSON schemas are generated for every tool',
  definitions.length === TOOL_NAMES.length,
  definitions.length + ' schemas for ' + TOOL_NAMES.length + ' tools',
);
check(
  'each schema has a description and an object schema',
  definitions.every((tool) => tool.description.length > 20 && tool.inputSchema.type === 'object'),
);

// ========================================================== search_products
section('search_products');

const search = await runTool('search_products', { query: 'gaming laptop', limit: 5 }, { conversationId });
check('returns results', search.ok && search.output.products.length > 0);
check('reports a total', search.ok && typeof search.output.total === 'number');

const first = search.ok ? search.output.products[0] : null;
check('price is a number', typeof first?.price === 'number', typeof first?.price);
check('currency is separate', first?.currency === 'INR');
check('availability is included', typeof first?.available === 'boolean');
check('key specs are included', first?.key_specs && Object.keys(first.key_specs).length > 0);
check(
  'no internal fields leak (no reserved stock, no timestamps)',
  first && !('reserved_quantity' in first) && !('created_at' in first) && !('updated_at' in first),
);
check(
  'top hit for "gaming laptop" is a gaming laptop',
  /TUF|Legion|Katana|Victus|Zephyrus/i.test(first?.name ?? ''),
  first?.name,
);

const budgeted = await runTool(
  'search_products',
  { category: 'laptops', max_price: 80000, limit: 10 },
  { conversationId },
);
check(
  'max_price is honoured',
  budgeted.ok && budgeted.output.products.every((product) => product.price <= 80000),
);
check(
  'category is honoured',
  budgeted.ok && budgeted.output.products.every((product) => product.category === 'Laptops'),
);

const specFiltered = await runTool(
  'search_products',
  { filters: { ram_gb_min: 32, storage_gb_max: 512 }, limit: 10 },
  { conversationId },
);
// Verified against the database rather than the trimmed key_specs, so the
// assertion tests the filter and not the display shortlist.
const filteredIds = specFiltered.ok ? specFiltered.output.products.map((product) => product.id) : [];
const { data: filteredSpecs } = await admin
  .from('products')
  .select('name, specs')
  .in('id', filteredIds.length > 0 ? filteredIds : ['00000000-0000-4000-8000-000000000000']);

check(
  'spec filters work (ram >= 32, storage <= 512)',
  specFiltered.ok &&
    filteredIds.length > 0 &&
    (filteredSpecs ?? []).every(
      (product) => Number(product.specs.ram_gb) >= 32 && Number(product.specs.storage_gb) <= 512,
    ),
  JSON.stringify((filteredSpecs ?? []).map((p) => p.name + ':' + p.specs.ram_gb + 'GB/' + p.specs.storage_gb + 'GB')),
);

// key_specs is a shortlist, so what matters is WHICH specs survive it: the
// ones a laptop is actually chosen on. Truncating away the processor or the
// memory would leave the assistant describing a machine it cannot distinguish.
check(
  'the deciding specs survive the key_specs shortlist for laptops',
  specFiltered.ok &&
    specFiltered.output.products.every(
      (product) => 'ram_gb' in product.key_specs && 'processor' in product.key_specs,
    ),
  specFiltered.ok ? Object.keys(specFiltered.output.products[0]?.key_specs ?? {}).join(',') : '',
);

const gpuFiltered = await runTool(
  'search_products',
  { filters: { gpu: 'RTX 4060' }, limit: 10 },
  { conversationId },
);
check(
  'text spec filter matches on substring',
  gpuFiltered.ok &&
    gpuFiltered.output.products.length > 0 &&
    gpuFiltered.output.products.every((product) => /RTX 4060/i.test(String(product.key_specs.gpu))),
);

const inStock = await runTool('search_products', { in_stock_only: true, limit: 20 }, { conversationId });
check(
  'in_stock_only excludes out-of-stock products',
  inStock.ok && inStock.output.products.every((product) => product.available === true),
);

check(
  'applied_filters is echoed back',
  budgeted.ok && budgeted.output.applied_filters.max_price === 80000,
);

// -- validation
const badLimit = await runTool('search_products', { limit: 5000 }, { conversationId });
check('limit above the cap is rejected', badLimit.ok === false && badLimit.code === 'INVALID_ARGUMENTS');

const badRange = await runTool(
  'search_products',
  { min_price: 90000, max_price: 10000 },
  { conversationId },
);
check('inverted price range is rejected', badRange.ok === false && badRange.code === 'INVALID_ARGUMENTS');

const badCategory = await runTool('search_products', { category: 'Laptops; DROP' }, { conversationId });
check('non-slug category is rejected', badCategory.ok === false && badCategory.code === 'INVALID_ARGUMENTS');

const badSpecKey = await runTool(
  'search_products',
  { filters: { "ram_gb'; drop table products;--": 16 } },
  { conversationId },
);
check('malformed spec key is rejected', badSpecKey.ok === false && badSpecKey.code === 'INVALID_ARGUMENTS');

const extraField = await runTool('search_products', { query: 'x', evil: true }, { conversationId });
check('unknown argument is rejected (strict schema)', extraField.ok === false);

const negativeRating = await runTool('search_products', { min_rating: 99 }, { conversationId });
check('out-of-range rating is rejected', negativeRating.ok === false);

// ============================================================== get_product
section('get_product');

const slug = first?.slug;
const detail = await runTool('get_product', { product_id: slug }, { conversationId });
check('resolves by slug', detail.ok, detail.ok ? '' : detail.error);
check('includes description', detail.ok && typeof detail.output.description === 'string');
check('includes images', detail.ok && Array.isArray(detail.output.images) && detail.output.images.length > 0);
check(
  'includes full specifications',
  detail.ok && Object.keys(detail.output.specifications).length >= 5,
);
check('includes availability', detail.ok && typeof detail.output.available === 'boolean');
check('includes related products', detail.ok && Array.isArray(detail.output.related_products));

const byId = await runTool('get_product', { product_id: detail.output.id }, { conversationId });
check('resolves by uuid too', byId.ok && byId.output.id === detail.output.id);

const missing = await runTool('get_product', { product_id: 'no-such-product-here' }, { conversationId });
check('unknown product → NOT_FOUND', missing.ok === false && missing.code === 'NOT_FOUND');
check(
  'not-found message is safe (no SQL, no table names)',
  missing.ok === false && !/relation|column|select|pgrst/i.test(missing.error),
  missing.ok === false ? missing.error : '',
);

const badRef = await runTool('get_product', { product_id: '../../etc/passwd' }, { conversationId });
check('path-traversal-shaped id is rejected', badRef.ok === false && badRef.code === 'INVALID_ARGUMENTS');

// ========================================================= compare_products
section('compare_products');

const twoIds = search.ok ? search.output.products.slice(0, 2).map((product) => product.id) : [];
const comparison = await runTool('compare_products', { product_ids: twoIds }, { conversationId });
check('compares two products', comparison.ok, comparison.ok ? '' : comparison.error);
check('returns both products', comparison.ok && comparison.output.products.length === 2);
check(
  'includes a price row',
  comparison.ok && comparison.output.comparison.price !== undefined,
);
check(
  'price row values are real numbers',
  comparison.ok && comparison.output.comparison.price.values.every((value) => typeof value === 'number'),
);
check(
  'price winner is the cheaper one (lower is better)',
  comparison.ok &&
    (() => {
      const row = comparison.output.comparison.price;
      if (row.winner === null) return true;
      const values = row.values;
      return values[row.winner] === Math.min(...values);
    })(),
);
check(
  'only differing attributes are shown',
  comparison.ok &&
    Object.entries(comparison.output.comparison)
      .filter(([key]) => key !== 'price' && key !== 'rating')
      .every(([, row]) => new Set(row.values.map(String)).size > 1),
);
check(
  'higher_is_better is declared per row',
  comparison.ok &&
    Object.values(comparison.output.comparison).every((row) => 'higher_is_better' in row),
);

const oneProduct = await runTool('compare_products', { product_ids: [twoIds[0]] }, { conversationId });
check('a single product is rejected', oneProduct.ok === false && oneProduct.code === 'INVALID_ARGUMENTS');

const tooMany = await runTool(
  'compare_products',
  { product_ids: [...twoIds, ...twoIds, ...twoIds] },
  { conversationId },
);
check('more than four products is rejected', tooMany.ok === false);

// ========================================================== check_inventory
section('check_inventory');

const stock = await runTool('check_inventory', { product_id: twoIds[0] }, { conversationId });
check('returns availability', stock.ok && typeof stock.output.available === 'boolean');
check('returns a quantity', stock.ok && typeof stock.output.quantity === 'number');
check(
  'exposes only product_id, available and quantity',
  stock.ok && JSON.stringify(Object.keys(stock.output).sort()) === '["available","product_id","quantity"]',
  stock.ok ? Object.keys(stock.output).join(',') : '',
);

// Cross-check against the database.
const { data: trueStock } = await admin
  .from('inventory')
  .select('quantity, reserved_quantity, available')
  .eq('product_id', twoIds[0])
  .single();
check(
  'quantity matches the database (quantity - reserved)',
  stock.ok && stock.output.quantity === Math.max(trueStock.available, 0),
  stock.ok ? `tool ${stock.output.quantity} vs db ${trueStock.available}` : '',
);

// =========================================================== get_categories
section('get_categories');

const categories = await runTool('get_categories', {}, { conversationId });
check('returns categories', categories.ok && categories.output.categories.length > 0);
check(
  'leaf categories only by default',
  categories.ok && categories.output.categories.length === 15,
  categories.ok ? String(categories.output.categories.length) : '',
);
check(
  'each has id, name, slug and a count',
  categories.ok &&
    categories.output.categories.every(
      (category) => category.id && category.name && category.slug && typeof category.product_count === 'number',
    ),
);

const withParents = await runTool('get_categories', { include_parents: true }, { conversationId });
check(
  'include_parents adds the departments',
  withParents.ok && withParents.output.categories.length === 19,
  withParents.ok ? String(withParents.output.categories.length) : '',
);

// ====================================================== get_related_products
section('get_related_products');

// Relatedness needs a product that HAS relatives. The gaming-laptops category
// holds exactly one product, so asking it for siblings correctly returns
// nothing — a fact about the catalogue, not a broken tool. A phone has eleven.
const phoneSearch = await runTool(
  'search_products',
  { category: 'smartphones', limit: 5 },
  { conversationId },
);
const relatedAnchor = phoneSearch.ok ? phoneSearch.output.products[0]?.id : twoIds[0];

const related = await runTool(
  'get_related_products',
  { product_id: relatedAnchor },
  { conversationId },
);
check('returns related products', related.ok && related.output.products.length > 0);
check(
  'never returns the product itself',
  related.ok && related.output.products.every((product) => product.id !== relatedAnchor),
);
check('names the relationship used', related.ok && typeof related.output.relationship === 'string');

const sameBrand = await runTool(
  'get_related_products',
  { product_id: twoIds[0], relationship: 'same_brand' },
  { conversationId },
);
const sourceBrand = search.ok ? search.output.products[0].brand : null;
check(
  'same_brand really returns that brand',
  sameBrand.ok && sameBrand.output.products.every((product) => product.brand === sourceBrand),
  sameBrand.ok ? sameBrand.output.products.map((p) => p.brand).join(',') : '',
);

const accessories = await runTool(
  'get_related_products',
  { product_id: twoIds[0], relationship: 'accessories' },
  { conversationId },
);
check(
  'accessories come from paired categories, not the same one',
  accessories.ok &&
    (accessories.output.products.length === 0 ||
      accessories.output.products.every((product) => product.category !== 'Gaming Laptops')),
  accessories.ok ? accessories.output.products.map((p) => p.category).join(',') : '',
);

const badRelationship = await runTool(
  'get_related_products',
  { product_id: twoIds[0], relationship: 'random' },
  { conversationId },
);
check('an invented relationship is rejected', badRelationship.ok === false);

// =============================================================== tool budget
section('Tool budget');

const budget = new ToolBudget(2);
const call1 = await runTool('get_categories', {}, { conversationId, budget });
const call2 = await runTool('get_categories', {}, { conversationId, budget });
const call3 = await runTool('get_categories', {}, { conversationId, budget });
check('calls within budget succeed', call1.ok && call2.ok);
check('the call past the budget is refused', call3.ok === false, call3.ok ? 'ran anyway' : '');
check('budget reports what it spent', budget.spent === 2 && budget.remaining === 0);

// ================================================================ audit log
section('Audit log');

const { data: logs } = await admin
  .from('ai_tool_logs')
  .select('tool_name, status, execution_time_ms, input, output, error')
  .eq('conversation_id', conversationId)
  .order('created_at', { ascending: true });

check('every call was logged', (logs?.length ?? 0) >= 30, `logged ${logs?.length ?? 0}`);
check('successes are recorded', logs.some((log) => log.status === 'success'));
check('rejections are recorded', logs.some((log) => log.status === 'rejected'));
check(
  'execution time is captured',
  logs.every((log) => typeof log.execution_time_ms === 'number' && log.execution_time_ms >= 0),
);
check('tool inputs are captured', logs.some((log) => log.input && Object.keys(log.input).length > 0));
check(
  'the unknown-tool attempt is logged as rejected',
  logs.some((log) => log.tool_name === 'delete_all_products' && log.status === 'rejected'),
);
check(
  'no secret ever reaches the log',
  !JSON.stringify(logs).match(/eyJhbGciOi|SUPABASE_SERVICE|R2_SECRET|sk-ant/),
);

// ====================================================== filter translation
section('Spec filter translation');

check(
  '*_min becomes gte',
  JSON.stringify(toDbSpecFilters({ ram_gb_min: 16 })) ===
    JSON.stringify([{ key: 'ram_gb', op: 'gte', value: '16' }]),
);
check(
  '*_max becomes lte',
  JSON.stringify(toDbSpecFilters({ weight_kg_max: 2 })) ===
    JSON.stringify([{ key: 'weight_kg', op: 'lte', value: '2' }]),
);
check(
  'text becomes a substring match',
  JSON.stringify(toDbSpecFilters({ gpu: 'RTX 4060' })) ===
    JSON.stringify([{ key: 'gpu', op: 'contains', value: 'RTX 4060' }]),
);
check('empty values are dropped', toDbSpecFilters({ gpu: '' }).length === 0);

// ================================================================== cleanup
await admin.from('conversations').delete().eq('id', conversationId);

console.log(`\n${'='.repeat(56)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  · ${failure}`);
}
process.exit(failed > 0 ? 1 : 0);
