import 'server-only';

import { z } from 'zod';

import { resolveProvider, type AIProvider } from '@/lib/ai/provider';
import {
  emptyRequirements,
  type AgentIntent,
  type PreferenceKey,
  type ShoppingRequirements,
  type SpecConstraint,
  type UseCase,
} from '@/lib/ai/types';
import { cleanKeywords, extractRequirementsWithRules, type CategoryVocabularyEntry } from './rules';

/**
 * Requirement extraction.
 *
 * The model is asked for a strict JSON shape (Zod-enforced by the provider),
 * then the deterministic rules run over the same text and **override** the
 * model wherever they are confident. A regex cannot invent a budget that is
 * not in the message; a model can. Where the rules are silent, the model's
 * reading wins — that is what buys us Hinglish and paraphrase handling.
 */

const USE_CASE_VALUES = [
  'programming',
  'gaming',
  'college',
  'office',
  'travel',
  'gym',
  'photography',
  'video_editing',
  'music',
  'commute',
  'casual',
] as const;

const PREFERENCE_VALUES = [
  'portability',
  'performance',
  'battery_life',
  'camera',
  'noise_cancellation',
  'comfort',
  'display',
  'build_quality',
  'value',
] as const;

const INTENT_VALUES = [
  'recommend',
  'refine',
  'compare',
  'product_question',
  'availability',
  'browse_categories',
  'smalltalk',
  'cart_add',
  'cart_remove',
  'cart_update',
  'cart_clear',
  'cart_view',
  'cross_sell',
  'checkout',
] as const;

/**
 * The schema the model fills in. Every field is nullable and the prompt is
 * explicit that unknown means null — Phase 2 §14 forbids assuming anything the
 * shopper did not say.
 */
const extractionSchema = z.object({
  intent: z.enum(INTENT_VALUES),
  category_slug: z
    .string()
    .nullable()
    .describe('A slug from the provided category list, or null if unclear.'),
  budget_min: z.number().nullable(),
  budget_max: z.number().nullable(),
  use_cases: z.array(z.enum(USE_CASE_VALUES)),
  preferences: z.array(z.enum(PREFERENCE_VALUES)),
  brands: z.array(z.string()),
  spec_constraints: z.array(
    z.object({
      key: z.string().describe('lower_snake_case spec key, e.g. ram_gb, weight_kg, gpu'),
      op: z.enum(['gte', 'lte', 'eq', 'contains']),
      value: z.string(),
      hard: z.boolean(),
    }),
  ),
  require_in_stock: z.boolean(),
  min_rating: z.number().nullable(),
  keywords: z.array(z.string()),
  /** Product ordinals the shopper referred to: "the first one" → [1]. */
  referenced_positions: z.array(z.number().int().min(1).max(20)),
  /** True when the message adjusts an earlier request rather than starting over. */
  is_refinement: z.boolean(),
});

type ExtractionOutput = z.infer<typeof extractionSchema>;

export interface ExtractionContext {
  vocabulary: CategoryVocabularyEntry[];
  knownBrands: string[];
  /** The requirement state carried in from earlier turns. */
  previous: ShoppingRequirements | null;
  /** Products shown in the last assistant turn, for "the first one". */
  lastShownProductIds: string[];
}

export interface ExtractionResult {
  requirements: ShoppingRequirements;
  intent: AgentIntent;
  referencedProductIds: string[];
  isRefinement: boolean;
  /** True when the rules alone produced this (no model was involved). */
  deterministic: boolean;
}

function buildSystemPrompt(context: ExtractionContext): string {
  const categories = context.vocabulary
    .map((entry) => `${entry.slug} (${entry.name})`)
    .join(', ');

  return [
    'You extract structured shopping requirements from a customer message for ShopiQ, an Indian e-commerce store. Prices are in INR.',
    '',
    'Rules:',
    '- Extract ONLY what the customer actually said or clearly implied. Never invent a budget, brand, or specification.',
    '- Unknown values must be null (or an empty array). Do not guess.',
    '- Indian number words: "hazaar"/"hazar"/"k" = thousand, "lakh"/"lac" = 100,000. "80 hazaar" and "80k" both mean 80000.',
    '- The customer may write in English, Hindi, or Hinglish. Understand all three.',
    '- Negative requirements become constraints: "nothing heavier than 2kg" => {key:"weight_kg", op:"lte", value:"2", hard:true}.',
    '- "at least 16GB RAM" => {key:"ram_gb", op:"gte", value:"16", hard:true}.',
    '- Spec keys are lower_snake_case and must come from this vocabulary where possible: ram_gb, storage_gb, weight_kg, gpu, processor, display_size, refresh_rate_hz, battery_hours, battery_mah, noise_cancellation, connection, type, water_resistance.',
    '- `hard` is true only when the customer stated it as a requirement, not a preference.',
    '',
    `Available category slugs: ${categories}.`,
    'Choose category_slug only from that list. If the customer named something not in the list, use null.',
    '',
    'Intent:',
    '- "recommend": they want product suggestions.',
    '- "refine": they are adjusting a previous request ("lighter ones", "cheaper", "show more").',
    '- "compare": they want two or more products compared.',
    '- "product_question": a factual question about a specific product.',
    '- "availability": asking whether something is in stock.',
    '- "browse_categories": asking what is available generally.',
    '- "cart_add": they want something put in the cart ("add the second one", "cart mein daal do").',
    '- "cart_remove": they want something taken out of the cart.',
    '- "cart_update": they want a quantity changed ("make it two", "one less").',
    '- "cart_clear": they want the whole cart emptied.',
    '- "cart_view": they want to see what is in the cart, or the cart total.',
    '- "cross_sell": they are asking what else they need, or for accessories.',
    '- "checkout": they are ready to buy or want the checkout summary.',
    '- "smalltalk": greetings or anything not about shopping.',
    '',
    'referenced_positions: if they say "the first one" use [1], "compare the first and second" use [1,2]. Empty if they name no positions.',
  ].join('\n');
}

function buildUserPrompt(message: string, context: ExtractionContext): string {
  const parts = [`Customer message: """${message}"""`];

  if (context.previous) {
    const previous = context.previous;
    const known: string[] = [];
    if (previous.categorySlug) known.push(`category: ${previous.categorySlug}`);
    if (previous.budget.max) known.push(`budget max: ${previous.budget.max}`);
    if (previous.useCases.length) known.push(`use cases: ${previous.useCases.join(', ')}`);
    if (Object.keys(previous.preferences).length) {
      known.push(`preferences: ${Object.keys(previous.preferences).join(', ')}`);
    }
    if (known.length) {
      parts.push(
        `Already known from earlier in this conversation (do not repeat unless the customer changes it): ${known.join('; ')}`,
      );
    }
  }

  if (context.lastShownProductIds.length) {
    parts.push(
      `The last reply showed ${context.lastShownProductIds.length} products, numbered 1 to ${context.lastShownProductIds.length}.`,
    );
  }

  return parts.join('\n\n');
}

export async function extractRequirements(
  message: string,
  context: ExtractionContext,
  provider: AIProvider = resolveProvider(),
): Promise<ExtractionResult> {
  const ruleBased = extractRequirementsWithRules(
    message,
    context.vocabulary,
    context.knownBrands,
  );

  if (!provider.available) {
    return finish(ruleBased, null, message, context, true);
  }

  try {
    const output = await provider.generateStructuredOutput<ExtractionOutput>({
      system: buildSystemPrompt(context),
      messages: [{ role: 'user', content: buildUserPrompt(message, context) }],
      schema: extractionSchema,
      schemaName: 'shopping_requirements',
      effort: 'low',
      maxTokens: 1200,
    });
    return finish(ruleBased, output, message, context, false);
  } catch {
    // A provider failure must not take the assistant down — fall back to rules.
    return finish(ruleBased, null, message, context, true);
  }
}

/**
 * Merge the two readings. Rules win on anything they detected, because they
 * are grounded in literal text; the model fills the gaps.
 */
function finish(
  rules: ShoppingRequirements,
  model: ExtractionOutput | null,
  message: string,
  context: ExtractionContext,
  deterministic: boolean,
): ExtractionResult {
  const merged = emptyRequirements();
  const validSlugs = new Set(context.vocabulary.map((entry) => entry.slug));

  // -- category -------------------------------------------------------------
  if (rules.categorySlug) {
    merged.categorySlug = rules.categorySlug;
    merged.category = rules.category;
  } else if (model?.category_slug && validSlugs.has(model.category_slug)) {
    merged.categorySlug = model.category_slug;
    merged.category =
      context.vocabulary.find((entry) => entry.slug === model.category_slug)?.name ?? null;
  }

  // -- budget ---------------------------------------------------------------
  if (rules.budget.max !== null || rules.budget.min !== null) {
    merged.budget = rules.budget;
  } else if (model && (model.budget_max !== null || model.budget_min !== null)) {
    merged.budget = {
      min: sanitiseMoney(model.budget_min),
      max: sanitiseMoney(model.budget_max),
      currency: 'INR',
    };
  }

  // -- use cases / preferences / brands -------------------------------------
  merged.useCases = unique([
    ...rules.useCases,
    ...((model?.use_cases ?? []) as UseCase[]),
  ]).slice(0, 6);

  merged.preferences = { ...rules.preferences };
  for (const preference of model?.preferences ?? []) {
    if (!(preference in merged.preferences)) {
      merged.preferences[preference as PreferenceKey] = 'high';
    }
  }

  const brandLookup = new Map(context.knownBrands.map((brand) => [brand.toLowerCase(), brand]));
  merged.brands = unique([
    ...rules.brands,
    // Only brands that actually exist in the catalogue survive.
    ...(model?.brands ?? [])
      .map((brand) => brandLookup.get(brand.trim().toLowerCase()))
      .filter((brand): brand is string => Boolean(brand)),
  ]).slice(0, 6);

  // -- spec constraints -----------------------------------------------------
  const constraints: SpecConstraint[] = [...rules.specConstraints];
  const seen = new Set(constraints.map((constraint) => `${constraint.key}:${constraint.op}`));

  for (const candidate of model?.spec_constraints ?? []) {
    const key = candidate.key.trim().toLowerCase();
    if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(key)) continue;

    const identity = `${key}:${candidate.op}`;
    if (seen.has(identity)) continue;

    const isRange = candidate.op === 'gte' || candidate.op === 'lte';
    const numeric = Number(candidate.value);

    // A range comparison with a non-numeric value is nonsense. Dropping it is
    // the only safe move: keeping it would make every product fail the check
    // and turn a hallucination into a bogus "no results".
    if (isRange && !Number.isFinite(numeric)) continue;

    // Nor is a non-positive one. Every spec ShopiQ ranges over is a physical
    // quantity — weight, memory, storage, battery — and none can be zero or
    // negative. This is not hypothetical: "lighter ones dikhao" was extracted
    // as `weight_kg <= 0`, a hard filter no product on earth satisfies, which
    // turned a simple refinement into "nothing matches your requirements".
    if (isRange && numeric <= 0) continue;

    const value = isRange ? numeric : candidate.value.trim();
    if (value === '') continue;

    seen.add(identity);
    constraints.push({ key, op: candidate.op, value, hard: Boolean(candidate.hard) });
  }
  merged.specConstraints = constraints.slice(0, 12);

  // -- misc -----------------------------------------------------------------
  merged.requireInStock = rules.requireInStock || Boolean(model?.require_in_stock);
  merged.minRating = rules.minRating ?? sanitiseRating(model?.min_rating ?? null);
  // Cleaned here rather than at each source, because the model's keywords are
  // the ones that need it most: it returns phrases like "under 90000", which
  // match no product name and empty the search on their own.
  merged.keywords = cleanKeywords(
    [...rules.keywords, ...(model?.keywords ?? [])],
    merged.categorySlug !== null,
  );

  // -- referents ------------------------------------------------------------
  const positions = model?.referenced_positions ?? extractPositionsWithRules(message);
  const referencedProductIds = positions
    .map((position) => context.lastShownProductIds[position - 1])
    .filter((id): id is string => Boolean(id));

  const intent = decideIntent(message, model, merged, referencedProductIds);

  return {
    requirements: merged,
    intent,
    referencedProductIds,
    isRefinement: Boolean(model?.is_refinement) || looksLikeRefinement(message),
    deterministic,
  };
}

function sanitiseMoney(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value > 0 && value <= 100_000_000 ? Math.round(value) : null;
}

function sanitiseRating(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 5 ? value : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** "the first one", "second", "पहला wala", "1 and 3". */
export function extractPositionsWithRules(message: string): number[] {
  const lower = message.toLowerCase();
  const ordinals: Array<[RegExp, number]> = [
    [/\b(first|1st|pehla|pehle|phla)\b/, 1],
    [/\b(second|2nd|dusra|doosra|dusre)\b/, 2],
    [/\b(third|3rd|teesra|tisra)\b/, 3],
    [/\b(fourth|4th|chautha)\b/, 4],
    [/\b(fifth|5th|panchwa)\b/, 5],
  ];

  const positions = new Set<number>();
  for (const [pattern, position] of ordinals) {
    if (pattern.test(lower)) positions.add(position);
  }

  // "compare 1 and 3"
  if (/\b(compare|vs|versus|difference)\b/.test(lower)) {
    for (const match of lower.matchAll(/\b([1-9])\b/g)) {
      positions.add(Number(match[1]));
    }
  }
  return [...positions].sort((a, b) => a - b);
}

function looksLikeRefinement(message: string): boolean {
  return /\b(lighter|cheaper|costlier|smaller|bigger|better|more|less|instead|other|another|different|show more|aur dikhao|thoda|kuch aur)\b/i.test(
    message,
  );
}

/**
 * Phrases that decide the intent on their own, checked before the model's
 * guess. A cart mutation is too consequential to leave to a soft signal: if the
 * shopper said "remove", we route to remove. Order matters — the most specific
 * and most destructive patterns are tested first.
 */
const INTENT_OVERRIDES: Array<[AgentIntent, RegExp]> = [
  // ------------------------------------------------------------- account
  // These come first, and it matters. Account requests are full of words the
  // product patterns want: "change my PHONE number" matched the smartphone
  // category and returned a catalogue search; "ADD a new address" matched
  // cart_add and offered to put a Galaxy S26 in the cart. Both are real
  // behaviours that shipped. Deciding account intent before any of that runs
  // is what stops a question about the customer from being read as a question
  // about the catalogue.
  //
  // Each pattern is anchored on a first-person possessive ("my", "mera") or an
  // explicit account noun, so "show me phones" and "delivery address for this
  // order" are not swept up.
  [
    'profile_update',
    /\b(?:change|update|edit|set|correct|fix)\b[^.?!]{0,20}\bmy\b[^.?!]{0,20}\b(?:name|phone|mobile|number|contact|profile|details?)\b|\bmy\b\s+(?:name|phone|mobile|number)\b[^.?!]{0,20}\b(?:is|should be|badal|change)\b|\b(?:naam|number)\s+(?:badal|change kar)/i,
  ],
  [
    'address_add',
    /\b(?:add|save|create|new|register)\b[^.?!]{0,20}\b(?:address|pata|delivery location)\b|\baddress\b[^.?!]{0,15}\b(?:add kar|save kar|daal)\b/i,
  ],
  [
    'address_list',
    /\b(?:my|mere|meri|saved|all)\b[^.?!]{0,15}\baddress(?:es)?\b|\baddress(?:es)?\b[^.?!]{0,15}\b(?:dikhao|list|batao|kya hai)\b|\bwhere do i live\b/i,
  ],
  [
    'order_cancel',
    /\b(?:cancel|cancell?ing|rad|radd)\b[^.?!]{0,20}\b(?:order|purchase|booking)\b|\border\b[^.?!]{0,15}\bcancel\b/i,
  ],
  [
    'order_support',
    /\b(?:return|refund|replace|replacement|exchange|wapas|badal)\b[^.?!]{0,25}\b(?:order|item|product|it|this|delivery)\b|\b(?:order|item|product)\b[^.?!]{0,20}\b(?:return|replace|refund|wapas)\b|\bi want to (?:return|replace|exchange)\b/i,
  ],
  [
    // The plural list, distinct from order_status below which answers about
    // one specific order.
    'order_list',
    /\b(?:my|mere|meri|all my|show my|list my)\b[^.?!]{0,15}\borders?\b(?!\s*(?:number|status|id))|\border history\b|\bpast orders?\b|\bprevious orders?\b|\bpurchases?\b[^.?!]{0,10}\b(?:list|history|dikhao)\b/i,
  ],
  [
    // Asking about any single field counts, not just the word "profile".
    // "what is my name" used to fall through to a catalogue search, because
    // nothing in the account patterns matched and the product classifier is
    // happy to take anything.
    //
    // Ordered after profile_update, so "change my name to X" is still an edit
    // rather than a question about the current value.
    'profile_view',
    /\bmy\b[^.?!]{0,15}\b(?:profile|account details?|account info\w*)\b|\b(?:show|view|what(?:'?s| is)|tell me|do you know)\b[^.?!]{0,15}\bmy (?:profile|account|details?|full name|name|phone|mobile|number|email|contact)\b|\bwho am i\b|\bmera (?:profile|naam)\b|\bmy name kya\b/i,
  ],

  // Phase 4 first: "did my payment go through" and "what did I buy" both
  // contain words the checkout and cart patterns below would otherwise claim.
  [
    'payment_status',
    /\b(did (my |the )?payment (go through|work|succeed|fail)|payment (status|hua|ho gaya|successful|failed)\??|was (my|the) payment|has (my|the) payment|paisa (kat|cut) gaya|payment kaisa)\b/i,
  ],
  [
    'order_status',
    // The last two alternatives matter: "what is the status of order
    // SQ-2026-1055" matched none of the original phrasings and fell through to
    // smalltalk, so a question about one specific order was answered with a
    // generic greeting. A stated order number is now sufficient on its own.
    /\b(what did i (just )?(buy|order)|my order (number|status|id)|what'?s my order|order (number|status) (kya|hai)|is my order confirmed|how much did i pay|kitna pay kiya|order confirm hua|track my order|where is my order)\b|\b(?:status|track|where is|kahan)\b[^.?!]{0,20}\border\b|\bSQ-\d{4}-\d+\b/i,
  ],
  [
    'cart_clear',
    /\b(clear|empty|remove everything|remove all|delete everything|delete all|khali kar|saaf kar|sab hata)\b.*\b(cart|basket)\b|\b(cart|basket)\b.*\b(clear|empty|khali|saaf|sab hata)\b/i,
  ],
  [
    'checkout',
    /\b(ready to (buy|order|check ?out)|take me to (the )?checkout|proceed to checkout|checkout|check out|place (the |my )?order|buy (it|them) now|khareed|order kar)\b/i,
  ],
  [
    // The bare phrase "my cart" is deliberately guarded on both sides.
    // "Add the first one to my cart" and "pehla wala my cart mein daal do" are
    // ADD requests that happen to name the cart; without the guards this
    // pattern claimed them and the assistant cheerfully read out an empty
    // cart instead of putting anything in it.
    'cart_view',
    /\b(what'?s in my cart|show (me )?(my )?cart|view (my )?cart|cart dikhao|cart mein kya|cart status|how much is the total|what'?s (my|the) total|total kitna|kitna hua)\b|(?<!\b(?:add|put|daal|remove|delete|hata|nikal)\b(?:\s+\w+){0,5}\s+)\bmy cart\b(?![^.?!]{0,25}\b(?:daal|dal|add|hata|nikal|remove)\b)/i,
  ],
  [
    'cross_sell',
    /\b(what else|anything else|accessor\w+|add.?ons?|aur kya|kya aur|complete (the )?setup|goes with|go with (it|this)|useful hoga|useful rahega)\b/i,
  ],
  [
    // "remove one" / "remove 2" is a quantity change, not a deletion — checked
    // before cart_remove so the more specific reading wins.
    'cart_update',
    /\b(make it|set it to|change it to|one more|1 more|another one|one less|1 less|increase|decrease|reduce|ek aur|aur ek|ek kam|(?:remove|take off|kam kar)\s+(?:one|two|three|1|2|3|ek)\b)/i,
  ],
  [
    'cart_remove',
    /\b(remove|take out|delete|drop it|hata do|hatao|nikal do|nikaal do|get rid of)\b/i,
  ],
  [
    'cart_add',
    /\b(add\b|cart me(i?n)? daal|daal do|daal de|put (it|that|this|them) in|le lo|add karo|add kar do|buy this)\b/i,
  ],
];

function decideIntent(
  message: string,
  model: ExtractionOutput | null,
  requirements: ShoppingRequirements,
  referencedProductIds: string[],
): AgentIntent {
  const lower = message.toLowerCase();

  // An explicit compare phrase beats whatever the model guessed.
  if (/\b(compare|vs\.?|versus|difference between|dono compare|kaunsa better|which is better|better kyun|why is (?:the )?(?:first|second)|inme se)\b/i.test(lower)) {
    return 'compare';
  }

  for (const [intent, pattern] of INTENT_OVERRIDES) {
    if (pattern.test(message)) return intent;
  }
  if (/\b(in stock|available|stock hai|kitne bache|do you have)\b/i.test(lower) && referencedProductIds.length > 0) {
    return 'availability';
  }
  if (model?.intent) return model.intent;

  if (/\b(what categories|what do you sell|categories|kya kya hai)\b/i.test(lower)) {
    return 'browse_categories';
  }
  if (/\b(why|kyun|kyu|explain|batao)\b/i.test(lower) && referencedProductIds.length > 0) {
    return 'product_question';
  }
  if (
    requirements.categorySlug ||
    requirements.budget.max !== null ||
    requirements.useCases.length > 0
  ) {
    return 'recommend';
  }
  if (looksLikeRefinement(message)) return 'refine';
  return 'recommend';
}

/**
 * Fold a new turn's requirements into the running conversation state.
 * A refinement adjusts; a fresh request with a new category replaces.
 */
export function mergeRequirements(
  previous: ShoppingRequirements | null,
  next: ShoppingRequirements,
  isRefinement: boolean,
): ShoppingRequirements {
  if (!previous) return next;

  // Changing category means a new shopping task — keep nothing but the budget,
  // which shoppers rarely restate.
  const categoryChanged =
    next.categorySlug !== null && next.categorySlug !== previous.categorySlug;

  if (categoryChanged && !isRefinement) {
    return {
      ...next,
      budget: next.budget.max !== null ? next.budget : previous.budget,
      // Shopping for something else does not mean switching language.
      language: previous.language,
    };
  }

  return {
    category: next.category ?? previous.category,
    categorySlug: next.categorySlug ?? previous.categorySlug,
    budget: next.budget.max !== null || next.budget.min !== null ? next.budget : previous.budget,
    useCases: unique([...previous.useCases, ...next.useCases]).slice(0, 6),
    preferences: { ...previous.preferences, ...next.preferences },
    brands: next.brands.length > 0 ? next.brands : previous.brands,
    specConstraints: mergeConstraints(previous.specConstraints, next.specConstraints),
    keywords: unique([...next.keywords, ...previous.keywords]).slice(0, 8),
    language: previous.language,
    requireInStock: next.requireInStock || previous.requireInStock,
    minRating: next.minRating ?? previous.minRating,
  };
}

/** A newer constraint on the same key replaces the older one. */
function mergeConstraints(
  previous: SpecConstraint[],
  next: SpecConstraint[],
): SpecConstraint[] {
  const byKey = new Map<string, SpecConstraint>();
  for (const constraint of previous) byKey.set(`${constraint.key}:${constraint.op}`, constraint);
  for (const constraint of next) byKey.set(`${constraint.key}:${constraint.op}`, constraint);
  return [...byKey.values()].slice(0, 12);
}
