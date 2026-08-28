import {
  emptyRequirements,
  type PreferenceKey,
  type ShoppingRequirements,
  type SpecConstraint,
  type UseCase,
} from '@/lib/ai/types';

/**
 * Deterministic requirement extraction.
 *
 * This runs on every message regardless of whether an LLM is configured. Two
 * reasons:
 *   1. It is the whole extraction path when no provider is available, so the
 *      storefront's AI never hard-depends on a model being reachable.
 *   2. When a provider IS available it acts as a cross-check — anything the
 *      rules are certain about (a stated budget, an explicit "under 2 kg")
 *      overrides the model, because a regex cannot hallucinate a number that
 *      is not in the text.
 *
 * Pure and dependency-free by design: the category vocabulary is passed in, so
 * this is unit-testable without a database.
 */

export interface CategoryVocabularyEntry {
  slug: string;
  name: string;
}

/** Words that point at a category, beyond the category's own name. */
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  laptops: ['laptop', 'laptops', 'notebook', 'macbook', 'ultrabook', 'lappy'],
  'gaming-laptops': ['gaming laptop', 'gaming laptops', 'gaming notebook', 'gaming lappy'],
  smartphones: ['phone', 'phones', 'smartphone', 'smartphones', 'mobile', 'iphone', 'android'],
  headphones: [
    'headphone',
    'headphones',
    'earphone',
    'earphones',
    'earbud',
    'earbuds',
    'tws',
    'buds',
    'airpods',
  ],
  'gaming-headsets': ['gaming headset', 'gaming headsets', 'gaming headphone'],
  monitors: ['monitor', 'monitors', 'display', 'screen'],
  keyboards: ['keyboard', 'keyboards', 'keeb', 'mechanical keyboard'],
  mice: ['mouse', 'mice', 'gaming mouse'],
  controllers: ['controller', 'controllers', 'gamepad', 'joystick'],
  'gaming-accessories': ['mousepad', 'mouse pad', 'deskmat', 'desk mat', 'charger', 'hub', 'dock'],
  shoes: ['shoe', 'shoes', 'sneaker', 'sneakers', 'footwear', 'joota', 'jute', 'trainers'],
  't-shirts': ['t-shirt', 'tshirt', 't shirt', 'tee', 'tees'],
  jackets: ['jacket', 'jackets', 'hoodie', 'windcheater'],
  bags: ['bag', 'bags', 'backpack', 'rucksack', 'sling', 'sleeve', 'laptop bag'],
  'home-accessories': ['lamp', 'desk lamp', 'bottle', 'flask', 'power bank', 'powerbank'],
};

const USE_CASE_PATTERNS: Array<[UseCase, RegExp]> = [
  ['programming', /\b(programming|coding|code|development|developer|dev\b|software|compil\w*|docker|android studio)\b/i],
  ['gaming', /\b(gaming|games?|gameplay|fps|esports?|khel\w*)\b/i],
  ['college', /\b(college|school|university|study|studies|student|padh\w*|classes)\b/i],
  ['office', /\b(office|work|business|professional|meetings?|excel|spreadsheet)\b/i],
  ['travel', /\b(travel(ling)?|trip|flight|journey|safar)\b/i],
  ['gym', /\b(gym|workout|running|fitness|exercise|jogging)\b/i],
  ['photography', /\b(photograph\w*|photos?|shooting|camera work)\b/i],
  ['video_editing', /\b(video editing|editing|premiere|davinci|rendering|4k edit\w*)\b/i],
  ['music', /\b(music|songs?|audio|listening)\b/i],
  ['commute', /\b(commut\w*|metro|train ride|daily travel)\b/i],
];

const PREFERENCE_PATTERNS: Array<[PreferenceKey, RegExp]> = [
  ['portability', /\b(lightweight|light\s?weight|lighter|light\b|portable|portability|slim|thin|halka|halke|carry)\b/i],
  ['battery_life', /\b(battery|backup|long.?lasting|charge lasts|battery life)\b/i],
  ['performance', /\b(performance|powerful|fast|speed|smooth|lag.?free|heavy work|tez)\b/i],
  ['camera', /\b(camera|photo quality|selfie|megapixel)\b/i],
  ['noise_cancellation', /\b(noise.?cancel\w*|anc\b|noise isolation)\b/i],
  ['comfort', /\b(comfort\w*|cushion\w*|soft|aaram)\b/i],
  ['display', /\b(display quality|screen quality|oled|amoled|colour accur\w*|color accur\w*|bright screen)\b/i],
  ['build_quality', /\b(build quality|sturdy|durable|premium build|mazboot)\b/i],
  ['value', /\b(value for money|budget friendly|cheap|sasta|affordable|paisa vasool)\b/i],
];

/** hazaar/k → ×1000, lakh → ×100000, crore → ×10⁷. */
const UNIT_MULTIPLIERS: Array<[RegExp, number]> = [
  [/^(k|thousand|hazaar|hazar|hajaar|hajar|hzr)$/i, 1_000],
  [/^(l|lakh|lac|lakhs|lacs)$/i, 100_000],
  [/^(cr|crore|crores)$/i, 10_000_000],
];

function unitMultiplier(unit: string | undefined): number {
  if (!unit) return 1;
  for (const [pattern, multiplier] of UNIT_MULTIPLIERS) {
    if (pattern.test(unit.trim())) return multiplier;
  }
  return 1;
}

function toAmount(raw: string, unit?: string): number | null {
  const cleaned = raw.replace(/[,\s₹]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;

  const amount = value * unitMultiplier(unit);
  // Guard against nonsense like "under 5 crore" for a t-shirt.
  return amount >= 1 && amount <= 100_000_000 ? Math.round(amount) : null;
}

const UNIT_GROUP = '(k|thousand|hazaar|hazar|hajaar|hajar|hzr|l|lakh|lac|lakhs|lacs|cr|crore|crores)';
const AMOUNT_GROUP = '(\\d[\\d,]*(?:\\.\\d+)?)';

/**
 * Budget. Handles "under 80k", "less than ₹80,000", "around 80 thousand",
 * "budget is 75-80k", "80 hazaar ke andar", "80 hazaar tak".
 */
export function extractBudget(text: string): { min: number | null; max: number | null } {
  const lower = text.toLowerCase();

  // Range first — "75-80k", "between 60k and 80k", "60 se 80 hazaar".
  const range = new RegExp(
    `${AMOUNT_GROUP}\\s*${UNIT_GROUP}?\\s*(?:-|–|to|se|and)\\s*${AMOUNT_GROUP}\\s*${UNIT_GROUP}?`,
    'i',
  ).exec(lower);

  if (range) {
    // "75-80k" — the unit on the second number applies to both.
    const trailingUnit = range[4] ?? range[2];
    const low = toAmount(range[1], range[2] ?? trailingUnit);
    const high = toAmount(range[3], range[4] ?? trailingUnit);
    if (low !== null && high !== null && low < high && high >= 100) {
      return { min: low, max: high };
    }
  }

  // Upper bound.
  const under = new RegExp(
    `(?:under|below|less than|lesser than|max|maximum|upto|up to|within|not more than|no more than|budget(?:\\s+(?:is|of|around|about))?|around|about|approx\\w*|near(?:ly)?)\\s*` +
      `(?:₹|rs\\.?|inr)?\\s*${AMOUNT_GROUP}\\s*${UNIT_GROUP}?`,
    'i',
  ).exec(lower);

  if (under) {
    const amount = toAmount(under[1], under[2]);
    if (amount !== null && amount >= 100) return { min: null, max: amount };
  }

  // Hindi postfix forms: "80 hazaar ke andar", "80k tak", "80 hazaar se kam".
  const postfix = new RegExp(
    `(?:₹|rs\\.?|inr)?\\s*${AMOUNT_GROUP}\\s*${UNIT_GROUP}?\\s*(?:ke\\s+andar|tak|se\\s+kam|ke\\s+neeche|or less|or under)`,
    'i',
  ).exec(lower);

  if (postfix) {
    const amount = toAmount(postfix[1], postfix[2]);
    if (amount !== null && amount >= 100) return { min: null, max: amount };
  }

  // A bare rupee amount is only treated as a budget when it is written as
  // currency or carries a magnitude unit — "₹80,000", "80k", "80 hazaar".
  const bare = new RegExp(
    `(?:₹|rs\\.?\\s*|inr\\s*)${AMOUNT_GROUP}\\s*${UNIT_GROUP}?|${AMOUNT_GROUP}\\s*${UNIT_GROUP}`,
    'i',
  ).exec(lower);

  if (bare) {
    const amount = bare[1]
      ? toAmount(bare[1], bare[2])
      : toAmount(bare[3], bare[4]);
    if (amount !== null && amount >= 100) return { min: null, max: amount };
  }

  return { min: null, max: null };
}

/** Resolve free text onto a real category slug from the live catalogue. */
export function extractCategory(
  text: string,
  vocabulary: CategoryVocabularyEntry[],
): { slug: string; name: string } | null {
  const lower = ` ${text.toLowerCase()} `;

  const candidates: Array<{ slug: string; name: string; weight: number }> = [];

  // Synonyms first, longest phrase wins ("gaming laptop" beats "laptop").
  for (const [slug, synonyms] of Object.entries(CATEGORY_SYNONYMS)) {
    const entry = vocabulary.find((item) => item.slug === slug);
    if (!entry) continue;
    for (const synonym of synonyms) {
      if (lower.includes(` ${synonym} `) || lower.includes(` ${synonym}s `)) {
        candidates.push({ slug, name: entry.name, weight: synonym.length });
      }
    }
  }

  // Then the catalogue's own names.
  for (const entry of vocabulary) {
    const name = entry.name.toLowerCase();
    if (lower.includes(` ${name} `)) {
      candidates.push({ slug: entry.slug, name: entry.name, weight: name.length });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.weight - a.weight);
  return { slug: candidates[0].slug, name: candidates[0].name };
}

export function extractUseCases(text: string): UseCase[] {
  const found = new Set<UseCase>();
  for (const [useCase, pattern] of USE_CASE_PATTERNS) {
    if (pattern.test(text)) found.add(useCase);
  }
  return [...found];
}

export function extractPreferences(
  text: string,
): Partial<Record<PreferenceKey, 'low' | 'high'>> {
  const preferences: Partial<Record<PreferenceKey, 'low' | 'high'>> = {};
  for (const [key, pattern] of PREFERENCE_PATTERNS) {
    if (pattern.test(text)) preferences[key] = 'high';
  }
  return preferences;
}

/**
 * Hard, machine-checkable constraints. This is where negative requirements
 * ("nothing heavier than 2kg") become something the filter can enforce.
 */
export function extractSpecConstraints(text: string): SpecConstraint[] {
  const lower = text.toLowerCase();
  const constraints: SpecConstraint[] = [];
  const seen = new Set<string>();

  const push = (constraint: SpecConstraint) => {
    const key = `${constraint.key}:${constraint.op}`;
    if (seen.has(key)) return;
    seen.add(key);
    constraints.push(constraint);
  };

  // Weight ceiling: "heavier than 2kg", "under 2 kg", "not more than 2kg",
  // "2 kg se kam", "below 1.5kg".
  const weightMax =
    /(?:heavier than|more than|above|over|under|below|less than|not more than|no more than|max(?:imum)?|upto|up to|within)\s*(\d+(?:\.\d+)?)\s*(kg|kgs|kilo\w*)/i.exec(
      lower,
    ) ?? /(\d+(?:\.\d+)?)\s*(kg|kgs|kilo\w*)\s*(?:se kam|ke andar|or less|or lighter)/i.exec(lower);

  if (weightMax) {
    const value = Number(weightMax[1]);
    if (Number.isFinite(value) && value > 0 && value < 30) {
      push({ key: 'weight_kg', op: 'lte', value, hard: true, source: weightMax[0].trim() });
    }
  }

  // RAM floor: "16gb ram", "at least 16 gb ram", "minimum 32gb".
  const ram = /(?:at least\s*|minimum\s*|min\s*|kam se kam\s*)?(\d{1,3})\s*gb\s*(?:of\s*)?(?:ram|memory)/i.exec(
    lower,
  );
  if (ram) {
    const value = Number(ram[1]);
    if (Number.isFinite(value) && value >= 2 && value <= 256) {
      push({ key: 'ram_gb', op: 'gte', value, hard: true, source: ram[0].trim() });
    }
  }

  // Storage floor: "512gb ssd", "1tb storage".
  const storageTb = /(\d+(?:\.\d+)?)\s*tb\s*(?:ssd|storage|nvme)?/i.exec(lower);
  const storageGb = /(\d{3,4})\s*gb\s*(?:ssd|storage|nvme)/i.exec(lower);
  if (storageTb) {
    const value = Number(storageTb[1]) * 1024;
    if (Number.isFinite(value)) {
      push({ key: 'storage_gb', op: 'gte', value, hard: false, source: storageTb[0].trim() });
    }
  } else if (storageGb) {
    const value = Number(storageGb[1]);
    if (Number.isFinite(value)) {
      push({ key: 'storage_gb', op: 'gte', value, hard: false, source: storageGb[0].trim() });
    }
  }

  // A named GPU is a strong signal and always checkable.
  const gpu = /\b(rtx\s?\d{4}|gtx\s?\d{3,4}|radeon\s?\w+)\b/i.exec(lower);
  if (gpu) {
    push({
      key: 'gpu',
      op: 'contains',
      value: gpu[1].replace(/\s+/g, ' ').toUpperCase(),
      hard: true,
      source: gpu[0].trim(),
    });
  }

  // Battery hours floor for audio: "at least 30 hours battery".
  const batteryHours = /(?:at least\s*|minimum\s*|min\s*)?(\d{1,3})\s*(?:hours?|hrs?)\s*(?:of\s*)?(?:battery|playback)/i.exec(
    lower,
  );
  if (batteryHours) {
    const value = Number(batteryHours[1]);
    if (Number.isFinite(value) && value > 0 && value <= 200) {
      push({
        key: 'battery_hours',
        op: 'gte',
        value,
        hard: false,
        source: batteryHours[0].trim(),
      });
    }
  }

  // "wireless only" is a hard constraint on how the thing connects.
  if (/\b(wireless|bluetooth|cordless)\b/i.test(lower) && !/\bwired\b/i.test(lower)) {
    push({ key: 'connection', op: 'contains', value: 'Bluetooth', hard: false, source: 'wireless' });
  }

  // Noise cancellation as a requirement, not just a preference.
  if (/\b(with anc|anc chahiye|must have noise.?cancel\w*|noise.?cancel\w* chahiye)\b/i.test(lower)) {
    push({
      key: 'noise_cancellation',
      op: 'contains',
      value: 'ANC',
      hard: true,
      source: 'noise cancellation',
    });
  }

  return constraints;
}

/** "available now", "in stock", "abhi chahiye". */
export function extractStockRequirement(text: string): boolean {
  return /\b(in stock|available now|available right now|abhi chahiye|turant|immediately|ready to ship|deliver(?:ed)? (?:today|tomorrow))\b/i.test(
    text,
  );
}

/** "4 star and above", "well reviewed", "highly rated". */
export function extractMinRating(text: string): number | null {
  const explicit = /(\d(?:\.\d)?)\s*(?:\+|star|stars|★)\s*(?:and above|\+|or above|and up)?/i.exec(
    text,
  );
  if (explicit) {
    const value = Number(explicit[1]);
    if (Number.isFinite(value) && value >= 1 && value <= 5) return value;
  }
  if (/\b(highly rated|well reviewed|best rated|top rated|good ratings?)\b/i.test(text)) return 4;
  return null;
}

export function extractBrands(text: string, knownBrands: string[]): string[] {
  const lower = ` ${text.toLowerCase()} `;
  return knownBrands.filter((brand) => lower.includes(` ${brand.toLowerCase()} `));
}

/**
 * Words worth keeping for full-text relevance, minus the filler that would
 * only dilute the search vector.
 */
const STOPWORDS = new Set([
  'i','me','my','need','want','looking','for','a','an','the','some','please','show','find','get','give',
  'chahiye','mujhe','muje','bhai','dikhao','dikha','do','ke','ka','ki','liye','hai','hoon','aur','bhi',
  'thodi','thoda','under','below','less','than','around','about','budget','price','with','and','or','in',
  'is','are','it','that','this','of','to','from','on','at','can','you','have','be','best','good','accha',
  'acha','wala','waala','kuch','koi','sab','se','par','par','main','mein','ho','hona','karni','karna','karta',
  // Money and quantity words. extractBudget() has already consumed these, but
  // they used to survive into `keywords` and then into the search query —
  // "Mujhe 90 hazaar ke andar phone chahiye" became a search for
  // "hazaar andar phone", which matches nothing and returned an empty result
  // for a request the catalogue could satisfy perfectly well.
  'hazaar','hazar','hajar','hazzar','hzaar','andar','tak','lakh','lakhs','crore','crores',
  'thousand','thousands','rupees','rupee','rupaye','rs','inr','approx','approximately',
  'near','nearly','only','just','max','maximum','minimum','range','within','upto','uptil',
  // Referring words left over once the reference itself has been resolved.
  'ones','one','wale','waale','type','kind','sort','option','options','model','models',
]);

/**
 * Words that name a whole category rather than distinguishing within one.
 *
 * Once "phones under 90000" has resolved to the smartphones category, the word
 * "phones" carries no further information: every product in that category is a
 * phone, and no product is literally NAMED "phones". Left in, it becomes a
 * full-text term that matches nothing and empties an otherwise good result —
 * the same failure as the budget words above, one step further along.
 *
 * This is deliberately NOT the CATEGORY_SYNONYMS list. "iphone" and "android"
 * point at a category too, but they discriminate inside it, so they stay.
 */
const GENERIC_CATEGORY_WORDS = new Set([
  'phone', 'phones', 'smartphone', 'smartphones', 'mobile', 'mobiles', 'handset', 'handsets',
  'laptop', 'laptops', 'notebook', 'notebooks',
  'headphone', 'headphones', 'earphone', 'earphones', 'earbud', 'earbuds', 'iem', 'iems',
  'controller', 'controllers', 'gamepad', 'gamepads', 'joystick',
  'monitor', 'monitors', 'keyboard', 'keyboards', 'mouse', 'mice',
  'bag', 'bags', 'backpack', 'tablet', 'tablets', 'watch', 'watches',
  'speaker', 'speakers', 'camera', 'cameras',
]);

/**
 * Written-out amounts, removed whole before tokenising.
 *
 * "2 lakh" splits into "2" and "lakh"; the word is a stopword but the digit
 * survives as a plausible model number and then matches a 2 TB phone. The
 * number only reads as an amount while the unit is still attached to it, so
 * this has to happen before the split.
 */
const AMOUNT_PHRASE =
  /\b\d+(?:\.\d+)?\s*(?:k|l|cr|lakh|lakhs|crore|crores|hazaar|hazar|hajar|thousand|thousands|rupees|rupaye|rs|inr)\b/gi;

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(AMOUNT_PHRASE, ' ')
    .replace(/[^a-z0-9\s.+-]/g, ' ')
    .split(/\s+/)
    .filter(
      (word) =>
        !STOPWORDS.has(word) &&
        // Amounts extractBudget() has already read: "90000", "90k", "1.5l".
        !isAmount(word) &&
        // Keep short model numbers ("16", "17"), drop other short noise.
        (word.length > 2 || /^\d{1,3}$/.test(word)),
    )
    .slice(0, 8);
}

/**
 * Reduce a raw keyword list to terms that can actually match a product name.
 *
 * Applied to whichever extractor produced the list. The model is the reason
 * this has to be shared: asked for keywords it returns phrases, and a phrase
 * like "under 90000" becomes a full-text term that matches no product and
 * empties a result the catalogue could satisfy. Splitting to words and then
 * dropping filler, amounts and category names leaves only terms that
 * discriminate between products.
 */
/**
 * A price or quantity, as opposed to a model number.
 *
 * "16" and "17" name a phone; "90000" and "90k" name a budget that
 * extractBudget() has already consumed. The line between them is length: no
 * product in the catalogue is identified by a four-digit bare number, and no
 * realistic rupee budget is under four digits once written out.
 */
function isAmount(word: string): boolean {
  if (/^\d+(\.\d+)?(k|l|cr|lakh|crore)$/.test(word)) return true;
  return /^\d{4,}$/.test(word);
}

/**
 * Is this word already captured as a scored signal?
 *
 * Use cases and preferences are soft: the ranking engine weighs them. Letting
 * them through as full-text terms as well makes them HARD filters, so "a
 * laptop for programming and some gaming" stops meaning "rank laptops by how
 * well they suit that" and starts meaning "only laptops with those words in
 * their name" — which in this catalogue is exactly one machine.
 */
function alreadyScored(word: string): boolean {
  const padded = ` ${word} `;
  for (const [, pattern] of USE_CASE_PATTERNS) {
    if (pattern.test(padded)) return true;
  }
  for (const [, pattern] of PREFERENCE_PATTERNS) {
    if (pattern.test(padded)) return true;
  }
  return false;
}

export function cleanKeywords(keywords: string[], hasCategory: boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of keywords) {
    const words = raw
      .toLowerCase()
      .replace(/[^a-z0-9\s.+-]/g, ' ')
      .split(/\s+/)
      // Trailing punctuation is why "chahiye." and "hai." used to slip past
      // STOPWORDS and end up as search terms matching no product at all.
      .map((word) => word.replace(/^[.+-]+|[.+-]+$/g, ''));

    for (const word of words) {
      if (alreadyScored(word)) continue;
      if (STOPWORDS.has(word)) continue;
      if (isAmount(word)) continue;
      if (hasCategory && GENERIC_CATEGORY_WORDS.has(word)) continue;
      // Model numbers are two characters ("16", "17") and matter enormously —
      // an iPhone 16 is not an iPhone 17. Every other short token is noise.
      if (word.length <= 2 && !/^\d{1,3}$/.test(word)) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      out.push(word);
    }
  }

  return out.slice(0, 8);
}

/** Full deterministic extraction for one message. */
export function extractRequirementsWithRules(
  text: string,
  vocabulary: CategoryVocabularyEntry[],
  knownBrands: string[] = [],
): ShoppingRequirements {
  const requirements = emptyRequirements();

  const category = extractCategory(text, vocabulary);
  if (category) {
    requirements.category = category.name;
    requirements.categorySlug = category.slug;
  }

  const budget = extractBudget(text);
  requirements.budget = { ...budget, currency: 'INR' };
  requirements.useCases = extractUseCases(text);
  requirements.preferences = extractPreferences(text);
  requirements.specConstraints = extractSpecConstraints(text);
  requirements.brands = extractBrands(text, knownBrands);
  requirements.keywords = cleanKeywords(extractKeywords(text), Boolean(category));
  requirements.requireInStock = extractStockRequirement(text);
  requirements.minRating = extractMinRating(text);

  return requirements;
}
