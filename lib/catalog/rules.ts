import 'server-only';

import {
  categoryAncestors,
  recommendations,
  type Condition,
  type Operator,
  type RecommendationRule,
  type RecommendationTarget,
} from './config';

/**
 * The rule engine.
 *
 * Rules are data, not code: `recommendations.json` says what kinds of product
 * go together, and this file decides whether a given product matches. Keeping
 * it declarative is what lets the catalogue grow without the recommendation
 * logic being rewritten each time.
 *
 * Every operator here is total — an unknown field, a null, or a type mismatch
 * yields `false` rather than throwing. A malformed rule must not be able to
 * take down a product search; it should simply match nothing, and the config
 * validator is what catches it before it ships.
 */

/** The facts a rule can be evaluated against. */
export interface RuleSubject {
  id?: string;
  category: string;
  subcategory?: string | null;
  brand?: string | null;
  segments?: string[];
  use_cases?: string[];
  tags?: string[];
  price?: number;
  specifications?: Record<string, unknown>;
  performance?: Record<string, number>;
  compatibility?: Record<string, unknown>;
  product_family?: string | null;
}

/* --------------------------------------------------------------- operators */

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    // Tolerate "16 GB" from a sloppy import, but only when a number leads.
    const match = /^-?\d+(\.\d+)?/.exec(value.trim());
    if (match) return Number(match[0]);
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/** Case-insensitive for strings, strict otherwise. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  const left = toNumber(a);
  const right = toNumber(b);
  if (left !== null && right !== null) return left === right;
  return a === b;
}

function compare(
  operator: Operator,
  actual: unknown,
  expected: unknown,
): boolean {
  switch (operator) {
    case 'exists':
      // `exists: false` asserts absence, which is how a rule says "only
      // products that do NOT declare this".
      return expected === false
        ? actual === undefined || actual === null
        : actual !== undefined && actual !== null;

    case 'equals':
      return asArray(actual).some((value) => looseEquals(value, expected));

    case 'not_equals':
      return !asArray(actual).some((value) => looseEquals(value, expected));

    case 'contains': {
      // On a list, membership. On a string, substring. Both are what "contains"
      // means to whoever wrote the rule.
      if (Array.isArray(actual)) {
        return actual.some((value) => looseEquals(value, expected));
      }
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.toLowerCase().includes(expected.toLowerCase());
      }
      return false;
    }

    case 'in':
      return asArray(expected).some((candidate) =>
        asArray(actual).some((value) => looseEquals(value, candidate)),
      );

    case 'not_in':
      return !asArray(expected).some((candidate) =>
        asArray(actual).some((value) => looseEquals(value, candidate)),
      );

    case 'greater_than':
    case 'greater_than_or_equal':
    case 'less_than':
    case 'less_than_or_equal': {
      const left = toNumber(Array.isArray(actual) ? actual[0] : actual);
      const right = toNumber(expected);
      // A range comparison against something non-numeric is not "false because
      // smaller" — it is unanswerable, and answering it would silently drop or
      // admit products on a comparison that never happened.
      if (left === null || right === null) return false;
      if (operator === 'greater_than') return left > right;
      if (operator === 'greater_than_or_equal') return left >= right;
      if (operator === 'less_than') return left < right;
      return left <= right;
    }

    default:
      return false;
  }
}

/** Read `specifications.ram_gb` style paths off a subject. */
export function readField(subject: RuleSubject, field: string): unknown {
  if (!field.includes('.')) {
    return (subject as unknown as Record<string, unknown>)[field];
  }
  let current: unknown = subject;
  for (const part of field.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate one condition.
 *
 * A bare value is shorthand for `equals`, because `{ "category": "phones" }`
 * reads better than `{ "category": { "equals": "phones" } }` and rules are
 * meant to be edited by hand.
 */
export function matchesCondition(
  subject: RuleSubject,
  field: string,
  condition: Condition,
): boolean {
  const actual = readField(subject, field);

  if (condition === null || typeof condition !== 'object') {
    // Category is special: a rule on `laptops` should match a gaming laptop,
    // because the taxonomy says one is a kind of the other.
    if (field === 'category' && typeof condition === 'string') {
      return (
        looseEquals(actual, condition) ||
        categoryAncestors(String(actual ?? '')).includes(condition)
      );
    }
    return compare('equals', actual, condition);
  }

  const entries = Object.entries(condition as Record<string, unknown>);
  if (entries.length === 0) return true;

  // Several operators on one field are ANDed: { greater_than: 4, less_than: 9 }.
  return entries.every(([operator, expected]) => {
    if (field === 'category' && operator === 'in') {
      const wanted = asArray(expected).map(String);
      const actualCategory = String(actual ?? '');
      return (
        wanted.some((slug) => looseEquals(actualCategory, slug)) ||
        categoryAncestors(actualCategory).some((ancestor) => wanted.includes(ancestor))
      );
    }
    return compare(operator as Operator, actual, expected);
  });
}

/** Every field in `when` must match. */
export function matchesRule(subject: RuleSubject, when: Record<string, Condition>): boolean {
  return Object.entries(when).every(([field, condition]) =>
    matchesCondition(subject, field, condition),
  );
}

/* ------------------------------------------------------------------ lookup */

export interface MatchedTarget extends RecommendationTarget {
  ruleId: string;
}

/**
 * Which recommendation targets apply to this product.
 *
 * Higher priority first, and de-duplicated by category so two rules both
 * suggesting accessories do not produce the same category twice — the stronger
 * priority and its reason win.
 */
export function targetsFor(subject: RuleSubject): MatchedTarget[] {
  const matched: MatchedTarget[] = [];

  for (const rule of recommendations.rules as RecommendationRule[]) {
    if (!matchesRule(subject, rule.when)) continue;
    for (const target of rule.recommend) {
      matched.push({ ...target, ruleId: rule.id });
    }
  }

  matched.sort((a, b) => b.priority - a.priority);

  const seen = new Set<string>();
  return matched.filter((target) => {
    const key = `${target.category}:${target.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Does a candidate satisfy a target's extra requirements? */
export function satisfiesTargetRequirements(
  candidate: RuleSubject,
  target: RecommendationTarget,
): boolean {
  if (!target.require) return true;
  return matchesRule(candidate, target.require);
}

/** Brand ecosystem boost, when the pairing is one the brand actually makes. */
export function ecosystemBoost(anchorBrand: string | null, candidate: RuleSubject): number {
  if (!anchorBrand) return 0;
  const ecosystem = recommendations.brand_ecosystems[anchorBrand];
  if (!ecosystem) return 0;
  if (!looseEquals(candidate.brand ?? '', anchorBrand)) return 0;

  const relevant =
    ecosystem.categories.includes(candidate.category) ||
    categoryAncestors(candidate.category).some((slug) => ecosystem.categories.includes(slug));

  return relevant ? ecosystem.boost : 0;
}
