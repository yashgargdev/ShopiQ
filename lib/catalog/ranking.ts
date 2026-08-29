import 'server-only';

import { rankingProfile, recommendations, settingValue } from './config';
import type { RuleSubject } from './rules';

/**
 * Deterministic ranking, with reasons.
 *
 * Two rules govern everything here.
 *
 * First, the score is computed in code from catalogue values — never by a
 * model. The model is handed the finished ranking and the reasons behind it,
 * and its whole job is to say them in English.
 *
 * Second, no recommendation may carry a score without reasons (§81). A number
 * on its own cannot be argued with, corrected, or audited; "0.91" tells a
 * customer nothing and tells a merchant less. Every signal that moves the
 * score appends a reason as it does so, so the explanation is a by-product of
 * the arithmetic rather than a story told afterwards.
 */

export interface RankingSignals {
  /** 0–1 each. Anything a profile does not weight is simply ignored. */
  budget?: number;
  useCase?: number;
  specification?: number;
  preference?: number;
  rating?: number;
  value?: number;
  relationship?: number;
  compatibility?: number;
  priceProportion?: number;
  availability?: number;
}

export interface RankedItem<T> {
  item: T;
  /** 0–1, so callers can present it as a percentage without re-scaling. */
  score: number;
  /** What each weighted signal contributed, for auditing a surprising order. */
  breakdown: Record<string, number>;
  /** Machine-readable, short, and true. Never empty for a returned item. */
  reasons: string[];
}

export interface ScoreInput<T> {
  item: T;
  signals: RankingSignals;
  reasons: string[];
  /** From recommendation_profile.boost. Bounded by the schema. */
  boost?: number;
}

/**
 * Combine weighted signals into one score.
 *
 * Normalised by the weight of the signals actually present, so a profile
 * scoring four of its six signals is not permanently capped below a profile
 * that scores all of them.
 */
export function scoreWith<T>(
  input: ScoreInput<T>,
  profileName?: string,
): RankedItem<T> {
  const weights = rankingProfile(profileName);
  const breakdown: Record<string, number> = {};

  let earned = 0;
  let available = 0;

  for (const [signal, weight] of Object.entries(weights)) {
    const value = input.signals[signal as keyof RankingSignals];
    if (value === undefined) continue;
    const clamped = Math.max(0, Math.min(1, value));
    const contribution = clamped * weight;
    breakdown[signal] = Math.round(contribution * 10) / 10;
    earned += contribution;
    available += weight;
  }

  const base = available > 0 ? earned / available : 0;
  const boosted = base + (input.boost ?? 0) / 100;

  return {
    item: input.item,
    score: Math.max(0, Math.min(1, Math.round(boosted * 1000) / 1000)),
    breakdown,
    reasons: input.reasons.filter(Boolean).slice(0, 5),
  };
}

/* ------------------------------------------------------------- diversity */

export interface DiversityOptions {
  maxPerBrand: number;
  limit: number;
}

/**
 * Spread the results across brands.
 *
 * Three results from one brand reads as a paid placement even when the ranking
 * was honest. Applied AFTER scoring so it reorders rather than rescoring —
 * demoting a product for its brand would be a different and much harder thing
 * to justify.
 *
 * Never returns fewer than `limit` when candidates exist: once the diverse
 * picks are exhausted, the best of the rest fill the remaining slots.
 */
export function diversify<T>(
  ranked: Array<RankedItem<T>>,
  brandOf: (item: T) => string | null,
  options: DiversityOptions,
): Array<RankedItem<T>> {
  const counts = new Map<string, number>();
  const chosen: Array<RankedItem<T>> = [];
  const overflow: Array<RankedItem<T>> = [];

  for (const entry of ranked) {
    const brand = (brandOf(entry.item) ?? '').toLowerCase();
    const seen = counts.get(brand) ?? 0;

    if (brand && seen >= options.maxPerBrand) {
      overflow.push(entry);
      continue;
    }
    counts.set(brand, seen + 1);
    chosen.push(entry);
    if (chosen.length >= options.limit) return chosen;
  }

  // Better a fourth ASUS than three results when five were asked for.
  return [...chosen, ...overflow].slice(0, options.limit);
}

/** The configured brand cap, for callers that do not override it. */
export function defaultDiversity(): number {
  const diversity = recommendations.settings.diversity as { max_per_brand?: number } | undefined;
  return diversity?.max_per_brand ?? 2;
}

/* ---------------------------------------------------------------- signals */

/**
 * How well a price sits inside a budget.
 *
 * Full marks anywhere under it, then a slope rather than a cliff: something
 * 5% over is very nearly right and should be shown and labelled, not hidden.
 * `null` when no budget was stated — the caller drops the signal rather than
 * scoring it zero, which would punish every product equally for a question
 * nobody asked.
 */
export function budgetFit(price: number, maxBudget: number | null): number | null {
  if (maxBudget === null || maxBudget <= 0) return null;
  if (price <= maxBudget) return 1;
  const over = (price - maxBudget) / maxBudget;
  return Math.max(0, 1 - over * 4);
}

/** Overlap between what was asked for and what the product claims to suit. */
export function useCaseFit(wanted: string[], declared: string[] | undefined): number | null {
  if (wanted.length === 0) return null;
  if (!declared || declared.length === 0) return 0;
  const matched = wanted.filter((useCase) => declared.includes(useCase)).length;
  return matched / wanted.length;
}

/**
 * Editorial performance, for the purposes asked about.
 *
 * A recommendation signal, not a benchmark — see vocabulary.json. Returns null
 * when the product declares nothing, so an unrated product is not ranked below
 * a mediocre one purely for having no entry.
 */
export function performanceFit(
  wanted: string[],
  performance: Record<string, number> | undefined,
): number | null {
  if (!performance || wanted.length === 0) return null;
  const scores = wanted
    .map((dimension) => performance[dimension])
    .filter((value): value is number => typeof value === 'number');
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length / 10;
}

/**
 * Rating, damped by how many people rated it.
 *
 * One five-star review must not outrank fifty four-star ones, and a product
 * with no reviews should sit mid-table rather than last — absence of evidence
 * is not evidence of a bad product.
 */
export function ratingFit(rating: number, reviewCount: number): number {
  if (reviewCount === 0) return 0.5;
  const confidence = Math.min(1, reviewCount / 50);
  return (rating / 5) * confidence + 0.5 * (1 - confidence);
}

/** Price against the going rate for its category. Rewards the honest deal. */
export function valueFit(price: number, categoryMedian: number | null): number | null {
  if (categoryMedian === null || categoryMedian <= 0) return null;
  const ratio = price / categoryMedian;
  if (ratio <= 0.7) return 1;
  if (ratio >= 1.6) return 0;
  return 1 - (ratio - 0.7) / 0.9;
}

/** Whether an accessory costs a sensible fraction of what it accessorises. */
export function priceProportionFit(accessoryPrice: number, anchorPrice: number): number | null {
  if (anchorPrice <= 0) return null;
  const ratio = accessoryPrice / anchorPrice;
  const ideal = settingValue('accessory_budget_ratio', 0.15);
  if (ratio <= ideal) return 1;
  if (ratio >= settingValue('max_accessory_price_ratio', 1)) return 0;
  return Math.max(0, 1 - (ratio - ideal) / (1 - ideal));
}

/** Rule priority (1–10) as a 0–1 signal. */
export function relationshipFit(priority: number): number {
  return Math.max(0, Math.min(1, priority / 10));
}

/** Stock depth, once out-of-stock has already been excluded. */
export function availabilityFit(available: number): number {
  if (available <= 0) return 0;
  return Math.min(1, available / 10);
}

/* ------------------------------------------------------------ exclusions */

export interface Exclusions {
  brands?: string[];
  categories?: string[];
  productIds?: string[];
  maxPrice?: number | null;
  maxWeightKg?: number | null;
}

/**
 * Negative preferences, applied as filters rather than penalties.
 *
 * "I don't want Apple" is not a mild preference to be outweighed by a good
 * price — it is an instruction, and a system that shows an iPhone anyway has
 * not listened. Section 49.
 */
export function isExcluded(subject: RuleSubject, exclusions: Exclusions): string | null {
  const brand = (subject.brand ?? '').toLowerCase();

  if (exclusions.brands?.some((excluded) => excluded.toLowerCase() === brand)) {
    return `${subject.brand} was excluded`;
  }
  if (exclusions.categories?.includes(subject.category)) {
    return `${subject.category} was excluded`;
  }
  if (subject.id && exclusions.productIds?.includes(subject.id)) {
    return 'already seen';
  }
  if (
    exclusions.maxPrice !== null &&
    exclusions.maxPrice !== undefined &&
    typeof subject.price === 'number' &&
    subject.price > exclusions.maxPrice
  ) {
    return `over ${exclusions.maxPrice}`;
  }
  if (exclusions.maxWeightKg !== null && exclusions.maxWeightKg !== undefined) {
    const weight = Number(subject.specifications?.weight_kg);
    if (Number.isFinite(weight) && weight > exclusions.maxWeightKg) {
      return `heavier than ${exclusions.maxWeightKg} kg`;
    }
  }
  return null;
}
