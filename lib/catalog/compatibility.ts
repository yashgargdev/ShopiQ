import 'server-only';

import { matchesRule, readField, type RuleSubject } from './rules';
import { categoryAncestors, vocabulary } from './config';

/**
 * Does this actually fit?
 *
 * Compatibility is the one recommendation signal that is not a preference. A
 * SO-DIMM stick will not go into a desktop, and no amount of good ranking on
 * price, rating or brand makes it a sensible thing to put in front of someone
 * building a PC. So this file produces exclusions and hard requirements, not
 * scores — a verdict of `incompatible` removes a candidate before ranking ever
 * sees it.
 *
 * The asymmetry is deliberate. An unknown fit is NOT treated as compatible:
 * saying "this might fit" is a judgement the customer can act on, while
 * silently listing a part that does not fit is one they cannot.
 */

export type Verdict = 'compatible' | 'incompatible' | 'unknown';

export interface CompatibilityClaim {
  predicate: string;
  product_id?: string;
  product_family?: string;
  category?: string;
  brand?: string;
  attributes?: Record<string, unknown>;
  reason?: string;
}

export interface CompatibilityFacts {
  platform?: string | null;
  attributes?: Record<string, unknown>;
  compatible_sizes?: string[];
  compatible_accessory_types?: string[];
  claims?: CompatibilityClaim[];
}

export interface CompatibilitySubject extends RuleSubject {
  compatibility_facts?: CompatibilityFacts | null;
}

export interface CompatibilityResult {
  verdict: Verdict;
  /** Why, in the customer's terms. Empty only when the verdict is `unknown`. */
  reasons: string[];
}

function facts(subject: CompatibilitySubject): CompatibilityFacts {
  return subject.compatibility_facts ?? {};
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Does a claim point at this candidate? */
function claimTargets(claim: CompatibilityClaim, candidate: CompatibilitySubject): boolean {
  if (claim.product_id && candidate.id) return claim.product_id === candidate.id;
  if (claim.product_family && candidate.product_family) {
    return claim.product_family === candidate.product_family;
  }
  if (claim.brand && !sameValue(claim.brand, candidate.brand)) return false;

  if (claim.category) {
    const matchesCategory =
      sameValue(claim.category, candidate.category) ||
      categoryAncestors(candidate.category).includes(claim.category);
    if (!matchesCategory) return false;
  }

  if (claim.attributes) {
    const candidateAttributes = facts(candidate).attributes ?? {};
    const all = Object.entries(claim.attributes).every(([key, value]) =>
      sameValue(candidateAttributes[key], value),
    );
    if (!all) return false;
  }

  // A claim naming only a brand still targets, provided the brand matched.
  return Boolean(claim.category || claim.brand || claim.attributes);
}

/**
 * Assess whether `candidate` fits `anchor`.
 *
 * Order matters: an explicit `not_compatible_with` wins over everything,
 * because refusing to sell someone a part that will not fit is worth more than
 * making the sale.
 */
export function assessCompatibility(
  anchor: CompatibilitySubject,
  candidate: CompatibilitySubject,
): CompatibilityResult {
  const reasons: string[] = [];
  const anchorFacts = facts(anchor);
  const candidateFacts = facts(candidate);

  // -- explicit exclusions, from either side ------------------------------
  for (const [owner, other] of [
    [anchor, candidate],
    [candidate, anchor],
  ] as const) {
    for (const claim of facts(owner).claims ?? []) {
      if (claim.predicate !== 'not_compatible_with') continue;
      if (claimTargets(claim, other)) {
        return {
          verdict: 'incompatible',
          reasons: [claim.reason ?? 'the catalogue records these as incompatible'],
        };
      }
    }
  }

  // -- an accessory made for a different brand ----------------------------
  //
  // A claim that names a brand is a claim about WHICH products this fits, not
  // merely a preference. A "Clear Case for Galaxy" carries
  // recommended_for { brand: Samsung, category: smartphones }; offering it
  // beside an iPhone is offering a case that does not fit the phone.
  //
  // Scoped to the anchor's own category so it only bites where the claim
  // applies: a Samsung charger is still fine for an Apple laptop.
  for (const claim of candidateFacts.claims ?? []) {
    if (claim.predicate === 'not_compatible_with' || !claim.brand) continue;

    const claimCoversAnchorCategory =
      !claim.category ||
      sameValue(claim.category, anchor.category) ||
      categoryAncestors(anchor.category).includes(claim.category);

    if (claimCoversAnchorCategory && !sameValue(claim.brand, anchor.brand)) {
      return {
        verdict: 'incompatible',
        reasons: [`made for ${claim.brand} devices, not ${anchor.brand ?? 'this one'}`],
      };
    }
  }

  // -- attribute contradictions -------------------------------------------
  // Only keys BOTH declare are compared. A candidate that says nothing about
  // its socket is unknown, not wrong.
  const anchorAttributes = anchorFacts.attributes ?? {};
  const candidateAttributes = candidateFacts.attributes ?? {};

  for (const [key, anchorValue] of Object.entries(anchorAttributes)) {
    const candidateValue = candidateAttributes[key];
    if (candidateValue === undefined || candidateValue === null) continue;

    if (!sameValue(anchorValue, candidateValue)) {
      return {
        verdict: 'incompatible',
        reasons: [`${key.replace(/_/g, ' ')} does not match — ${anchorValue} vs ${candidateValue}`],
      };
    }
    reasons.push(`${key.replace(/_/g, ' ')} matches (${candidateValue})`);
  }

  // -- physical size, for carriers ----------------------------------------
  const sizes = candidateFacts.compatible_sizes;
  const anchorSize = readField(anchor, 'specifications.display_size_in');
  if (sizes && sizes.length > 0 && anchorSize !== undefined && anchorSize !== null) {
    const fits = sizes.some((size) => Math.abs(Number(size) - Number(anchorSize)) < 0.6);
    if (!fits) {
      return {
        verdict: 'incompatible',
        reasons: [`sized for ${sizes.join('", "')}", not a ${anchorSize}" device`],
      };
    }
    reasons.push(`fits a ${anchorSize}" device`);
  }

  // -- positive claims -----------------------------------------------------
  for (const [owner, other] of [
    [anchor, candidate],
    [candidate, anchor],
  ] as const) {
    for (const claim of facts(owner).claims ?? []) {
      if (claim.predicate === 'not_compatible_with') continue;
      if (!vocabulary.compatibility_predicates.values.includes(claim.predicate)) continue;
      if (claimTargets(claim, other)) {
        reasons.push(claim.reason ?? `${claim.predicate.replace(/_/g, ' ')} this`);
      }
    }
  }

  // -- accepted accessory kinds -------------------------------------------
  const accepted = anchorFacts.compatible_accessory_types ?? [];
  for (const type of accepted) {
    const slug = vocabulary.accessory_types[type];
    if (!slug) continue;
    if (
      slug === candidate.category ||
      categoryAncestors(candidate.category).includes(slug)
    ) {
      reasons.push(`a ${type.replace(/_/g, ' ')}, which this accepts`);
    }
  }

  if (reasons.length === 0) return { verdict: 'unknown', reasons: [] };
  return { verdict: 'compatible', reasons };
}

/**
 * The requirements a candidate must meet to be worth offering with an anchor.
 *
 * Used to turn "a TV for my PS5" into an actual filter, so the search returns
 * screens the console can drive rather than any television at all.
 */
export function requirementsFor(
  anchor: CompatibilitySubject,
): Record<string, unknown> | null {
  const anchorAttributes = facts(anchor).attributes ?? {};
  const required: Record<string, unknown> = {};

  // Attributes an anchor declares are requirements for parts in the same
  // build: a DDR5 board wants DDR5 memory.
  for (const key of ['memory_type', 'socket', 'form_factor', 'platform', 'connector']) {
    if (anchorAttributes[key] !== undefined) required[key] = anchorAttributes[key];
  }

  return Object.keys(required).length > 0 ? required : null;
}

/** Filter a candidate list to what fits, keeping unknowns out of the way. */
export function filterCompatible<T extends CompatibilitySubject>(
  anchor: CompatibilitySubject,
  candidates: T[],
): Array<{ candidate: T; result: CompatibilityResult }> {
  return candidates
    .map((candidate) => ({ candidate, result: assessCompatibility(anchor, candidate) }))
    .filter((entry) => entry.result.verdict !== 'incompatible');
}

/** Does a subject satisfy an explicit requirement block? */
export function meetsRequirements(
  subject: RuleSubject,
  require: Record<string, unknown> | null | undefined,
): boolean {
  if (!require) return true;
  return matchesRule(subject, require as Record<string, never>);
}
