import 'server-only';

import type { ProductSummary } from '@/types';
import { searchProductSummaries } from '@/lib/ai/tools/implementations';

import { categoryWithDescendants, settingValue } from './config';
import { assessCompatibility, type CompatibilitySubject } from './compatibility';
import { ecosystemBoost, satisfiesTargetRequirements, targetsFor, type RuleSubject } from './rules';
import {
  availabilityFit,
  defaultDiversity,
  diversify,
  isExcluded,
  priceProportionFit,
  ratingFit,
  relationshipFit,
  scoreWith,
  type Exclusions,
  type RankedItem,
} from './ranking';

/**
 * The recommendation service.
 *
 * Stage 1 is deterministic and happens here: rules decide which CATEGORIES are
 * worth offering, the database is asked for real products in them, anything
 * incompatible or excluded is dropped, and what survives is scored and ordered.
 * Stage 2 — turning that into a sentence — happens elsewhere, and receives only
 * the finished list.
 *
 * The model never sees the catalogue. It sees a handful of candidates that
 * already passed every filter, each carrying the reasons it passed, which is
 * what makes "the AI may only recommend products in the candidate set" (§29)
 * something the architecture enforces rather than something a prompt requests.
 */

export interface RecommendationInput {
  /** What the customer already has or is looking at. */
  anchor: ProductSummary;
  /** Facts about the anchor beyond the product row, when known. */
  anchorFacts?: CompatibilitySubject['compatibility_facts'];
  /** Restrict to one relationship kind — accessories only, say. */
  types?: string[];
  /** Restrict to one category, for "what TV goes with this?". */
  category?: string;
  limit?: number;
  exclusions?: Exclusions;
  /** The shopper's overall budget, when one was stated. */
  budget?: number | null;
}

export interface Recommendation {
  product: ProductSummary;
  score: number;
  reasons: string[];
  relationshipType: string;
  ruleId: string;
  breakdown: Record<string, number>;
}

export interface RecommendationResult {
  recommendations: Recommendation[];
  /** Which rules fired, so a surprising suggestion can be traced to its rule. */
  appliedRules: string[];
  /** Categories searched but empty, so the caller can be honest about gaps. */
  emptyCategories: string[];
}

/** Turn a catalogue row into something the rule engine can read. */
export function toSubject(
  product: ProductSummary,
  extra?: Partial<RuleSubject> & { compatibility_facts?: CompatibilitySubject['compatibility_facts'] },
): CompatibilitySubject {
  // Catalogue knowledge lives in products.catalog_metadata. Reading it here is
  // what lets a rule match on a segment or a compatibility claim at all: with
  // an empty object the engine cannot tell "this product declares nothing"
  // from "nothing was stored", and silently recommends things that do not fit.
  const meta = (product.catalogMetadata ?? {}) as {
    segments?: string[];
    use_cases?: string[];
    performance?: Record<string, number>;
    compatibility?: CompatibilitySubject['compatibility_facts'];
    product_family?: string | null;
  };

  return {
    id: product.id,
    category: product.category.slug,
    brand: product.brand,
    price: product.price,
    tags: product.tags ?? [],
    specifications: (product.specs as Record<string, unknown>) ?? {},
    // Falls back to tags, which the importer also seeds with segments, so a
    // product written before catalog_metadata existed still matches.
    segments: meta.segments?.length ? meta.segments : (product.tags ?? []),
    use_cases: meta.use_cases ?? [],
    performance: meta.performance ?? {},
    product_family: meta.product_family ?? null,
    compatibility_facts: meta.compatibility ?? null,
    ...extra,
  };
}

/**
 * Find things to go with a product.
 *
 * Category rules first, then real products in those categories, then
 * compatibility, then scoring. Out-of-stock is excluded by the query rather
 * than scored low: something that cannot be bought is not a recommendation.
 */
export async function findRecommendations(
  input: RecommendationInput,
): Promise<RecommendationResult> {
  const anchorSubject = toSubject(input.anchor, {
    compatibility_facts: input.anchorFacts ?? null,
  });

  const targets = targetsFor(anchorSubject).filter((target) => {
    if (input.types && !input.types.includes(target.type)) return false;
    if (input.category && target.category !== input.category) return false;
    return true;
  });

  if (targets.length === 0) {
    return { recommendations: [], appliedRules: [], emptyCategories: [] };
  }

  const limit = input.limit ?? settingValue('max_recommendations', 3);

  /**
   * The "cheaper than its anchor" ceiling applies to ACCESSORIES only.
   *
   * A sleeve dearer than the laptop is absurd; a television dearer than the
   * console it is bought for is completely normal. Applying one ceiling to
   * both meant the PS5 was offered no television at all — the rule fired, the
   * requirement matched, and then the price filter removed every candidate.
   */
  const ceilingFor = (type: string) =>
    type === 'accessory'
      ? Math.round(input.anchor.price * settingValue('max_accessory_price_ratio', 1))
      : null;

  const appliedRules = new Set<string>();
  const emptyCategories: string[] = [];
  const scored: Array<RankedItem<Recommendation>> = [];
  const seen = new Set<string>([input.anchor.id]);

  // Four categories is enough for a three-item answer and bounds the work.
  for (const target of targets.slice(0, 4)) {
    const slugs = categoryWithDescendants(target.category);

    const batches = await Promise.all(
      slugs.slice(0, 3).map(async (slug) => {
        try {
          const result = await searchProductSummaries({
            query: null,
            category: slug,
            brand: null,
            min_price: null,
            // Pushed into Postgres rather than filtered in memory — §57.
            max_price: ceilingFor(target.type),
            min_rating: null,
            filters: null,
            in_stock_only: true,
            sort: 'rating',
            limit: 10,
          });
          return result.products;
        } catch {
          return [];
        }
      }),
    );

    const candidates = batches.flat().filter((product) => {
      if (seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    });

    if (candidates.length === 0) {
      emptyCategories.push(target.category);
      continue;
    }

    for (const candidate of candidates) {
      const subject = toSubject(candidate);

      // -- hard filters, never scored (§45 guardrails) --------------------
      const excluded = input.exclusions ? isExcluded(subject, input.exclusions) : null;
      if (excluded) continue;

      if (!satisfiesTargetRequirements(subject, target)) continue;

      const compatibility = assessCompatibility(anchorSubject, subject);
      if (compatibility.verdict === 'incompatible') continue;

      // -- signals ---------------------------------------------------------
      const proportion = priceProportionFit(candidate.price, input.anchor.price);
      const reasons: string[] = [target.reason];

      if (compatibility.reasons.length > 0) {
        reasons.push(compatibility.reasons[0]);
      }
      if (candidate.rating >= 4.3 && candidate.reviewCount >= 10) {
        reasons.push(`rated ${candidate.rating.toFixed(1)} by ${candidate.reviewCount} buyers`);
      }
      if (proportion !== null && proportion >= 0.9) {
        reasons.push('a small addition next to the main purchase');
      }

      const boost = ecosystemBoost(input.anchor.brand, subject);
      if (boost > 0) {
        reasons.push(`from ${input.anchor.brand}, like your ${input.anchor.name}`);
      }

      appliedRules.add(target.ruleId);

      scored.push(
        scoreWith<Recommendation>(
          {
            item: {
              product: candidate,
              score: 0,
              reasons: [],
              relationshipType: target.type,
              ruleId: target.ruleId,
              breakdown: {},
            },
            signals: {
              relationship: relationshipFit(target.priority),
              compatibility: compatibility.verdict === 'compatible' ? 1 : 0.5,
              priceProportion: proportion ?? 0.5,
              rating: ratingFit(candidate.rating, candidate.reviewCount),
              availability: availabilityFit(candidate.availability.available),
            },
            reasons,
            boost,
          },
          'accessory',
        ),
      );
    }
  }

  scored.sort((a, b) => b.score - a.score || a.item.product.price - b.item.product.price);

  const spread = diversify(scored, (item) => item.product.brand, {
    maxPerBrand: defaultDiversity(),
    limit,
  });

  return {
    recommendations: spread.map((entry) => ({
      ...entry.item,
      score: entry.score,
      reasons: entry.reasons,
      breakdown: entry.breakdown,
    })),
    appliedRules: [...appliedRules],
    emptyCategories,
  };
}

/**
 * Products in a category that actually work with this one.
 *
 * The PS5-and-television case: the rule carries the requirement (4K, 120 Hz,
 * HDMI 2.1) and this returns only screens that meet it. When none does, the
 * honest answer is an empty list — §29.
 */
export async function findCompatibleProducts(
  anchor: ProductSummary,
  category: string,
  options?: { limit?: number; anchorFacts?: CompatibilitySubject['compatibility_facts'] },
): Promise<RecommendationResult> {
  return findRecommendations({
    anchor,
    anchorFacts: options?.anchorFacts,
    category,
    limit: options?.limit ?? 3,
  });
}

/** Accessories specifically, rather than every kind of pairing. */
export async function findAccessories(
  anchor: ProductSummary,
  options?: { limit?: number; exclusions?: Exclusions },
): Promise<RecommendationResult> {
  return findRecommendations({
    anchor,
    types: ['accessory', 'cross_sell', 'ecosystem', 'frequently_bought_together'],
    limit: options?.limit,
    exclusions: options?.exclusions,
  });
}

/**
 * A better version of what they are looking at, when one exists and the step
 * up is small enough to be worth mentioning.
 *
 * Deliberately conservative: an upsell that ignores the stated budget is not a
 * suggestion, it is a sales pitch. Returns nothing rather than reaching.
 */
export async function findUpsell(
  anchor: ProductSummary,
  budget: number | null,
): Promise<Recommendation | null> {
  const ceiling = Math.round(
    (budget ?? anchor.price) * (1 + settingValue('upsell_max_uplift_ratio', 0.25)),
  );
  if (ceiling <= anchor.price) return null;

  let candidates: ProductSummary[] = [];
  try {
    const result = await searchProductSummaries({
      query: null,
      category: anchor.category.slug,
      brand: null,
      min_price: anchor.price + 1,
      max_price: ceiling,
      min_rating: null,
      filters: null,
      in_stock_only: true,
      sort: 'price_asc',
      limit: 5,
    });
    candidates = result.products;
  } catch {
    return null;
  }

  const better = candidates.find((product) => product.id !== anchor.id);
  if (!better) return null;

  const extra = Math.round(better.price - anchor.price);

  return {
    product: better,
    score: 0.5,
    relationshipType: 'upsell',
    ruleId: 'upsell',
    breakdown: {},
    reasons: [`about ₹${extra.toLocaleString('en-IN')} more than the ${anchor.name}`],
  };
}
