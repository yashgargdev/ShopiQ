/**
 * Conversational product references.
 *
 * "Add the second one", "remove the laptop", "the cheaper one", "the one you
 * recommended" — all of these have to become a concrete product id or cart
 * item id before any tool runs.
 *
 * This is deliberately deterministic rather than left to the model. The LLM is
 * allowed to *suggest* which position the shopper meant, but the mapping from
 * a position to an id happens here, against the list that was actually shown.
 * A model that hallucinates a product id therefore cannot reach the cart.
 *
 * Pure and dependency-free, so it can be unit-tested without a database.
 */

export interface ReferenceProduct {
  productId: string;
  name: string;
  brand: string;
  price: number;
  score?: number;
  category?: string;
  specs?: Record<string, string | number>;
}

export interface ReferenceCartLine {
  cartItemId: string;
  productId: string;
  name: string;
  brand: string;
  price: number;
  quantity: number;
  category?: string;
}

export interface ReferenceScope {
  /** Products shown in the most recent assistant turn, in display order. */
  shown: ReferenceProduct[];
  /** The current cart. */
  cart: ReferenceCartLine[];
}

export type ReferenceConfidence = 'exact' | 'inferred' | 'ambiguous' | 'none';

export interface ResolvedReference {
  productIds: string[];
  cartItemIds: string[];
  confidence: ReferenceConfidence;
  /** How we read the phrase, for the assistant to echo back. */
  label: string | null;
  /** Set when several candidates matched equally well. */
  candidates?: string[];
}

const NONE: ResolvedReference = {
  productIds: [],
  cartItemIds: [],
  confidence: 'none',
  label: null,
};

/* ------------------------------------------------------------------ ordinals */

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|1st|pehla|pehle|phla|pahla)\b/i, 1],
  [/\b(second|2nd|dusra|doosra|dusre|dusara)\b/i, 2],
  [/\b(third|3rd|teesra|tisra|teesre)\b/i, 3],
  [/\b(fourth|4th|chautha|chotha)\b/i, 4],
  [/\b(fifth|5th|panchwa|paanchwa)\b/i, 5],
];

/** "the last one", "the final one" → the end of the shown list. */
const LAST_PATTERN = /\b(last one|last wala|final one|aakhri)\b/i;

export function extractOrdinals(message: string): number[] {
  const found = new Set<number>();

  for (const [pattern, position] of ORDINALS) {
    if (pattern.test(message)) found.add(position);
  }

  // "compare 1 and 3", "add number 2", "#2" — bare digits, but only when the
  // message is clearly talking about the list rather than a price or quantity.
  //
  // `#` is deliberately outside the \b group: a word boundary before a
  // non-word character never matches at the start of a string, so `\b#`
  // silently failed on the most natural form of all — "#2".
  const NUMBERED = /(?:\b(?:number|no\.?|option|item)|#)\s*([1-9])\b/gi;
  for (const match of message.matchAll(NUMBERED)) {
    found.add(Number(match[1]));
  }

  return [...found].sort((a, b) => a - b);
}

/* -------------------------------------------------------------- superlatives */

type Superlative = {
  pattern: RegExp;
  label: string;
  pick: (products: ReferenceProduct[]) => ReferenceProduct | null;
};

function numericSpec(product: ReferenceProduct, key: string): number | null {
  const value = product.specs?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickBy(
  products: ReferenceProduct[],
  value: (product: ReferenceProduct) => number | null,
  direction: 'min' | 'max',
): ReferenceProduct | null {
  const scored = products
    .map((product) => ({ product, value: value(product) }))
    .filter((entry): entry is { product: ReferenceProduct; value: number } => entry.value !== null);

  if (scored.length === 0) return null;

  scored.sort((a, b) => (direction === 'min' ? a.value - b.value : b.value - a.value));
  // A tie between the top two is not a reference we can resolve confidently.
  if (scored.length > 1 && scored[0].value === scored[1].value) return null;
  return scored[0].product;
}

const SUPERLATIVES: Superlative[] = [
  {
    pattern: /\b(cheaper|cheapest|less expensive|lowest price|sasta|sabse sasta|budget one)\b/i,
    label: 'the cheapest of those',
    pick: (products) => pickBy(products, (product) => product.price, 'min'),
  },
  {
    pattern: /\b(costlier|most expensive|priciest|highest price|mehnga|premium one)\b/i,
    label: 'the most expensive of those',
    pick: (products) => pickBy(products, (product) => product.price, 'max'),
  },
  {
    pattern: /\b(more powerful|most powerful|fastest|strongest|best performance|powerful one|zyada powerful)\b/i,
    label: 'the most powerful of those',
    // RAM is the most consistently populated performance signal across the
    // catalogue; fall back to the engine's own score, then to price.
    pick: (products) =>
      pickBy(products, (product) => numericSpec(product, 'ram_gb'), 'max') ??
      pickBy(products, (product) => product.score ?? null, 'max') ??
      pickBy(products, (product) => product.price, 'max'),
  },
  {
    pattern: /\b(lightest|lighter one|most portable|halka|sabse halka)\b/i,
    label: 'the lightest of those',
    pick: (products) =>
      pickBy(products, (product) => numericSpec(product, 'weight_kg'), 'min') ??
      pickBy(products, (product) => numericSpec(product, 'weight_g'), 'min'),
  },
  {
    pattern: /\b(best rated|highest rated|top rated|best reviewed)\b/i,
    label: 'the best rated of those',
    pick: (products) => pickBy(products, (product) => product.score ?? null, 'max'),
  },
  {
    pattern:
      /\b(you recommended|your recommendation|your pick|top pick|recommended one|jo aapne bataya|jo tumne bataya|the one you suggested)\b/i,
    label: 'my top recommendation',
    // The engine already ranked these; position 1 is the recommendation.
    pick: (products) => products[0] ?? null,
  },
];

/* ----------------------------------------------------------- name matching */

/** Words too generic to identify a product on their own. */
const GENERIC_TERMS = new Set([
  'one',
  'it',
  'that',
  'this',
  'them',
  'those',
  'product',
  'item',
  'thing',
  'wala',
  'waala',
]);

/**
 * Words in a message that could identify a product, ignoring the instruction
 * wrapped around them.
 *
 * "add that Apple charger only" leaves ["apple", "charger"]; "add it" and "add
 * the first one" leave nothing. Two or more of these means the shopper named
 * something specific, and any guess that contradicts them is wrong.
 *
 * Colours and ordinals are excluded deliberately: "the black one" picks from
 * what is already on screen rather than naming a different product.
 */
const INSTRUCTION_WORDS = new Set([
  'add', 'adding', 'put', 'remove', 'delete', 'buy', 'order', 'want', 'need',
  'please', 'kindly', 'just', 'only', 'too', 'also', 'and', 'but', 'the', 'for',
  'cart', 'basket', 'okay', 'okey', 'fine', 'then', 'yes', 'yeah', 'yep', 'sure',
  'karo', 'kar', 'daal', 'dedo', 'chahiye', 'bhi', 'mein', 'mera', 'meri',
  'first', 'second', 'third', 'fourth', 'fifth', 'last', 'next', 'other',
  'cheaper', 'cheapest', 'costlier', 'lighter', 'best', 'worst',
  'black', 'white', 'blue', 'green', 'red', 'pink', 'purple', 'orange', 'yellow',
  'grey', 'gray', 'silver', 'gold', 'teal', 'sage', 'lavender', 'cream', 'beige',
]);

function contentTokens(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 2 && !GENERIC_TERMS.has(word) && !INSTRUCTION_WORDS.has(word),
    );
}

function nameTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !GENERIC_TERMS.has(token));
}

/**
 * Score how well a message names a product. Brand and distinctive model words
 * count; category words count for less, because several products share them.
 */
function nameMatchScore(message: string, product: { name: string; brand: string; category?: string }): number {
  const haystack = ` ${message.toLowerCase()} `;
  let score = 0;

  if (haystack.includes(` ${product.brand.toLowerCase()} `)) score += 3;

  for (const token of nameTokens(product.name)) {
    if (haystack.includes(token)) score += 2;
  }

  if (product.category) {
    for (const token of nameTokens(product.category)) {
      if (haystack.includes(token)) score += 1;
    }
  }

  return score;
}

/**
 * Does this message actually name this product?
 *
 * The guard between "search returned something" and "the shopper asked for
 * it". Full-text search always ranks *something* first, so a request for an
 * Apple charger came back with a pair of headphones and they were added
 * without a word. A brand (3) or a distinctive model word (2) clears the bar;
 * a category word alone (1) does not, because every product in the aisle
 * shares it.
 */
export function namesProduct(
  message: string,
  product: { name: string; brand: string; category?: string },
): boolean {
  return nameMatchScore(message, product) >= 2;
}

function bestNameMatch<T extends { name: string; brand: string; category?: string }>(
  message: string,
  candidates: T[],
): { item: T; ambiguous: boolean } | null {
  const scored = candidates
    .map((item) => ({ item, score: nameMatchScore(message, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  return { item: scored[0].item, ambiguous: scored.length > 1 && scored[0].score === scored[1].score };
}

/* -------------------------------------------------------------- resolution */

/** Verbs that mean the shopper is talking about something already in the cart. */
const CART_VERBS =
  /\b(remove|delete|take out|drop|hata|nikal|nikaal|get rid of|update|change|make it|increase|decrease|reduce)\b/i;

const PRONOUNS = /\b(it|that|this|those|them|these|woh|wo|ye|yeh|usko|isko)\b/i;

/**
 * Resolve a phrase to concrete ids.
 *
 * `preferCart` biases towards cart lines — set it when the verb implies
 * modifying something already in the cart.
 */
export function resolveReference(
  message: string,
  scope: ReferenceScope,
  options: { preferCart?: boolean; modelPositions?: number[] } = {},
): ResolvedReference {
  const preferCart = options.preferCart ?? CART_VERBS.test(message);

  // ---- 1. explicit ordinals -------------------------------------------
  const ordinals = extractOrdinals(message);
  const positions = ordinals.length > 0 ? ordinals : (options.modelPositions ?? []);

  if (positions.length > 0) {
    // An ordinal after a cart verb refers to the cart list, not the search list.
    const list = preferCart && scope.cart.length > 0 ? scope.cart : scope.shown;
    const picked = positions
      .map((position) => list[position - 1])
      .filter((entry): entry is (typeof list)[number] => Boolean(entry));

    // An ordinal the shopper typed is a fact. A position the MODEL inferred is
    // a guess, and it must not outrank the shopper's own words: asked to "add
    // that Apple charger", the extractor pointed at whatever sat first on
    // screen — a pair of headphones — and it went into the cart silently.
    //
    // So when the message names something specific and the guess matches none
    // of it, drop the guess and let the later, evidence-based steps answer.
    const modelGuess = ordinals.length === 0;
    const namedSomething = contentTokens(message).length >= 2;
    const guessMatchesName =
      picked.length > 0 && picked.some((entry) => nameMatchScore(message, entry) >= 2);

    if (modelGuess && namedSomething && !guessMatchesName) {
      // fall through to name matching below
    } else if (picked.length > 0) {
      return {
        productIds: picked.map((entry) => entry.productId),
        cartItemIds: picked
          .map((entry) => ('cartItemId' in entry ? entry.cartItemId : null))
          .filter((id): id is string => Boolean(id)),
        confidence: 'exact',
        label: positions.length === 1 ? `the ${ordinalWord(positions[0])} one` : 'those',
      };
    }
    // Positions were named but point past the end of the list — say so rather
    // than silently falling through to a guess.
    if (list.length > 0) {
      return { ...NONE, confidence: 'ambiguous', label: null };
    }
  }

  // ---- 2. "the last one" ----------------------------------------------
  if (LAST_PATTERN.test(message)) {
    const list = preferCart && scope.cart.length > 0 ? scope.cart : scope.shown;
    const entry = list[list.length - 1];
    if (entry) {
      return {
        productIds: [entry.productId],
        cartItemIds: 'cartItemId' in entry ? [entry.cartItemId] : [],
        confidence: 'exact',
        label: 'the last one',
      };
    }
  }

  // ---- 3. superlatives -------------------------------------------------
  for (const superlative of SUPERLATIVES) {
    if (!superlative.pattern.test(message)) continue;

    const pool = preferCart && scope.cart.length > 0 ? cartAsProducts(scope.cart) : scope.shown;
    const picked = superlative.pick(pool);
    if (picked) {
      const cartLine = scope.cart.find((line) => line.productId === picked.productId);
      return {
        productIds: [picked.productId],
        cartItemIds: cartLine ? [cartLine.cartItemId] : [],
        confidence: 'inferred',
        label: superlative.label,
      };
    }
    // Matched the phrase but could not separate the candidates.
    return { ...NONE, confidence: 'ambiguous', label: superlative.label };
  }

  // ---- 4. by name / brand ---------------------------------------------
  if (preferCart && scope.cart.length > 0) {
    const match = bestNameMatch(message, scope.cart);
    if (match) {
      return {
        productIds: [match.item.productId],
        cartItemIds: [match.item.cartItemId],
        confidence: match.ambiguous ? 'ambiguous' : 'exact',
        label: match.item.name,
        candidates: match.ambiguous ? scope.cart.map((line) => line.name) : undefined,
      };
    }
  }

  const shownMatch = bestNameMatch(message, scope.shown);
  if (shownMatch) {
    const cartLine = scope.cart.find((line) => line.productId === shownMatch.item.productId);
    return {
      productIds: [shownMatch.item.productId],
      cartItemIds: cartLine ? [cartLine.cartItemId] : [],
      confidence: shownMatch.ambiguous ? 'ambiguous' : 'exact',
      label: shownMatch.item.name,
      candidates: shownMatch.ambiguous ? scope.shown.map((product) => product.name) : undefined,
    };
  }

  // ---- 5. bare pronoun -------------------------------------------------
  // "add it", "remove it" — only resolvable when there is exactly one thing it
  // could mean. Otherwise the assistant must ask.
  if (PRONOUNS.test(message)) {
    if (preferCart && scope.cart.length === 1) {
      const line = scope.cart[0];
      return {
        productIds: [line.productId],
        cartItemIds: [line.cartItemId],
        confidence: 'inferred',
        label: line.name,
      };
    }
    if (scope.shown.length === 1) {
      const product = scope.shown[0];
      const cartLine = scope.cart.find((line) => line.productId === product.productId);
      return {
        productIds: [product.productId],
        cartItemIds: cartLine ? [cartLine.cartItemId] : [],
        confidence: 'inferred',
        label: product.name,
      };
    }
    if (scope.shown.length > 1) {
      return {
        ...NONE,
        confidence: 'ambiguous',
        candidates: scope.shown.map((product) => product.name),
      };
    }
  }

  return NONE;
}

function cartAsProducts(cart: ReferenceCartLine[]): ReferenceProduct[] {
  return cart.map((line) => ({
    productId: line.productId,
    name: line.name,
    brand: line.brand,
    price: line.price,
    category: line.category,
  }));
}

function ordinalWord(position: number): string {
  return (
    { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth' }[position] ?? `${position}th`
  );
}

/* ---------------------------------------------------------------- quantity */

/**
 * "make it two", "add three", "increase by one", "2 le lo".
 * Returns an absolute quantity and whether it was stated as a delta.
 */
export function extractQuantity(
  message: string,
): { quantity: number; relative: 'set' | 'increase' | 'decrease' } | null {
  const lower = message.toLowerCase();

  const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5,
  };

  /**
   * "do" is both the Hindi word for two and the imperative particle in
   * "daal do" / "kar do" / "de do". Read as a number it turns "put it in the
   * cart" into "add two", so it only counts as a quantity when it is not
   * trailing one of those verbs.
   */
  const IMPERATIVE_DO = /\b(daal|daal|kar|de|le|bhej|nikaal|nikal|hata)\s+do\b/i;

  const numberFrom = (token: string): number | null => {
    const digits = Number(token);
    if (Number.isInteger(digits) && digits >= 0 && digits <= 99) return digits;
    if ((token === 'do' || token === 'de') && IMPERATIVE_DO.test(lower)) return null;
    return WORDS[token] ?? null;
  };

  // "make it two", "set it to 3", "change to 2"
  const setMatch = /\b(?:make it|set (?:it )?to|change (?:it )?to|kar do|kardo)\s+(\w+)\b/i.exec(lower);
  if (setMatch) {
    const value = numberFrom(setMatch[1]);
    if (value !== null) return { quantity: value, relative: 'set' };
  }

  // "add one more", "one more", "increase by 2", "ek aur"
  if (/\b(one more|1 more|another one|ek aur|aur ek|increase|add one)\b/i.test(lower)) {
    const byMatch = /\b(?:increase|add)\s*(?:by|it by)?\s*(\w+)\b/i.exec(lower);
    const value = byMatch ? numberFrom(byMatch[1]) : null;
    return { quantity: value ?? 1, relative: 'increase' };
  }

  // "remove one", "one less", "decrease by 1", "ek kam"
  if (/\b(one less|1 less|remove one|decrease|reduce|ek kam|kam kar)\b/i.test(lower)) {
    const byMatch = /\b(?:decrease|reduce|remove)\s*(?:by|it by)?\s*(\w+)\b/i.exec(lower);
    const value = byMatch ? numberFrom(byMatch[1]) : null;
    return { quantity: value ?? 1, relative: 'decrease' };
  }

  // "add 2", "2 add karo", "add two of them"
  const addMatch = /\b(?:add|daal do|daal|le lo|chahiye)\s+(\w+)\b/i.exec(lower);
  if (addMatch) {
    const value = numberFrom(addMatch[1]);
    if (value !== null && value > 0) return { quantity: value, relative: 'set' };
  }

  // A number followed by a counter: "2 units", "do piece", "teen nos".
  // Word-numbers are allowed here because the counter disambiguates them —
  // "do piece" cannot be the imperative particle.
  const quantityMatch = /\b([a-z0-9]{1,6})\s*(?:pieces?|units?|nos\.?|qty|quantity)\b/i.exec(lower);
  if (quantityMatch) {
    const value = numberFrom(quantityMatch[1]);
    if (value !== null && value > 0) return { quantity: value, relative: 'set' };
  }

  return null;
}
