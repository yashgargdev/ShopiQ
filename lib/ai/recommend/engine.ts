import 'server-only';

import { formatPrice } from '@/lib/format';
import type { ProductSummary } from '@/types';
import type {
  Recommendation,
  RecommendationOutcome,
  ScoreBreakdown,
  ShoppingRequirements,
  SpecConstraint,
  UseCase,
} from '@/lib/ai/types';

/**
 * The recommendation engine.
 *
 * Everything here is deterministic and runs in code. The model never picks a
 * product, never scores one, and never decides what counts as a match — it
 * only writes prose about a result this file already computed (Phase 2 §16).
 *
 * Pipeline: candidates -> hard-constraint filter -> score -> rank -> explain.
 * If the hard filter empties the set, we retry with the softest constraint
 * relaxed and label the result `relaxed`, so the reply can say honestly that
 * nothing met every requirement.
 */

// ---------------------------------------------------------------- scoring plan

/**
 * Weights sum to 100. Budget dominates because it is the requirement shoppers
 * are least willing to have violated.
 */
export const WEIGHTS = {
  budget: 30,
  useCase: 25,
  specification: 20,
  preference: 15,
  rating: 10,
} as const;

/**
 * Which specs matter for which use case, and in which direction. These map
 * onto the real spec keys the catalogue stores, so every judgement below is
 * checkable against a database value.
 */
interface SpecExpectation {
  key: string;
  /** Value at which a numeric expectation is fully satisfied. */
  target?: number;
  direction?: 'higher' | 'lower';
  /**
   * For text specs: the value scores 1 when it contains any of these, and
   * `partial` otherwise. Used for things like "does it have a discrete GPU",
   * where the spec is prose rather than a number.
   */
  anyOf?: string[];
  /** Credit given when a text spec matches none of `anyOf`. */
  partial?: number;
  label: string;
  unit?: string;
}

const USE_CASE_EXPECTATIONS: Partial<Record<UseCase, SpecExpectation[]>> = {
  programming: [
    { key: 'ram_gb', target: 16, direction: 'higher', label: 'RAM', unit: 'GB' },
    { key: 'storage_gb', target: 512, direction: 'higher', label: 'storage', unit: 'GB' },
  ],
  gaming: [
    { key: 'ram_gb', target: 16, direction: 'higher', label: 'RAM', unit: 'GB' },
    { key: 'refresh_rate_hz', target: 120, direction: 'higher', label: 'refresh rate', unit: 'Hz' },
    // Without this, an ultrabook with integrated graphics scored as well as a
    // machine with an RTX card. Integrated still gets partial credit — light
    // games do run — but it can no longer look like a gaming machine.
    {
      key: 'gpu',
      anyOf: ['rtx', 'gtx', 'radeon rx'],
      partial: 0.3,
      label: 'discrete graphics',
    },
  ],
  video_editing: [
    { key: 'ram_gb', target: 16, direction: 'higher', label: 'RAM', unit: 'GB' },
    { key: 'storage_gb', target: 512, direction: 'higher', label: 'storage', unit: 'GB' },
  ],
  college: [
    { key: 'weight_kg', target: 1.8, direction: 'lower', label: 'weight', unit: 'kg' },
    { key: 'battery_wh', target: 55, direction: 'higher', label: 'battery', unit: 'Wh' },
  ],
  travel: [{ key: 'weight_kg', target: 1.5, direction: 'lower', label: 'weight', unit: 'kg' }],
  office: [{ key: 'ram_gb', target: 8, direction: 'higher', label: 'RAM', unit: 'GB' }],
  gym: [{ key: 'battery_hours', target: 20, direction: 'higher', label: 'battery', unit: 'hours' }],
  music: [{ key: 'battery_hours', target: 25, direction: 'higher', label: 'battery', unit: 'hours' }],
  photography: [
    { key: 'rear_camera_mp', target: 48, direction: 'higher', label: 'camera', unit: 'MP' },
  ],
  commute: [
    { key: 'battery_hours', target: 20, direction: 'higher', label: 'battery', unit: 'hours' },
  ],
};

/** A use case is also satisfied by a product simply being tagged for it. */
const USE_CASE_TAGS: Partial<Record<UseCase, string[]>> = {
  programming: ['developer', 'programming', 'student', 'ultrabook', 'workstation'],
  gaming: ['gaming', 'esports', 'rtx 4060', 'rtx 4070', 'high refresh'],
  college: ['student', 'college', 'budget', 'thin and light'],
  office: ['office', 'productivity', 'business'],
  travel: ['travel', 'lightweight', 'packable', 'portable', 'compact'],
  gym: ['gym', 'sweatproof', 'training', 'sports'],
  photography: ['camera'],
  video_editing: ['video editing', 'creator', 'pro'],
  music: ['audiophile', 'music', 'anc'],
  commute: ['commute', 'anc', 'travel'],
};

const PREFERENCE_EXPECTATIONS: Record<string, SpecExpectation[]> = {
  portability: [
    { key: 'weight_kg', target: 1.5, direction: 'lower', label: 'weight', unit: 'kg' },
    { key: 'weight_g', target: 250, direction: 'lower', label: 'weight', unit: 'g' },
  ],
  battery_life: [
    { key: 'battery_hours', target: 30, direction: 'higher', label: 'battery', unit: 'hours' },
    { key: 'battery_wh', target: 70, direction: 'higher', label: 'battery', unit: 'Wh' },
    { key: 'battery_mah', target: 5000, direction: 'higher', label: 'battery', unit: 'mAh' },
  ],
  performance: [
    { key: 'ram_gb', target: 16, direction: 'higher', label: 'RAM', unit: 'GB' },
    { key: 'refresh_rate_hz', target: 120, direction: 'higher', label: 'refresh rate', unit: 'Hz' },
  ],
  camera: [{ key: 'rear_camera_mp', target: 48, direction: 'higher', label: 'camera', unit: 'MP' }],
  display: [
    { key: 'brightness_nits', target: 800, direction: 'higher', label: 'brightness', unit: 'nits' },
    { key: 'refresh_rate_hz', target: 120, direction: 'higher', label: 'refresh rate', unit: 'Hz' },
  ],
};

// ------------------------------------------------------------------ utilities

function numericSpec(product: ProductSummary, key: string): number | null {
  const value = (product.specs as Record<string, unknown>)?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function textSpec(product: ProductSummary, key: string): string | null {
  const value = (product.specs as Record<string, unknown>)?.[key];
  return value === undefined || value === null ? null : String(value);
}

/** 0–1, how well a value meets a numeric expectation, with partial credit. */
function expectationScore(value: number, expectation: SpecExpectation): number {
  const target = expectation.target;
  if (target === undefined || target <= 0) return 1;

  if (expectation.direction === 'higher') {
    if (value >= target) return 1;
    return Math.max(0, value / target);
  }
  if (value <= target) return 1;
  // Lower-is-better degrades to zero once it is 60% over target.
  const overshoot = (value - target) / (target * 0.6);
  return Math.max(0, 1 - overshoot);
}

/**
 * Score one expectation against a product, numeric or textual.
 * Returns null when the product does not record the spec at all, so callers
 * can distinguish "missing" from "bad".
 */
function evaluateExpectation(
  product: ProductSummary,
  expectation: SpecExpectation,
): { fraction: number; display: string; shortfall: string } | null {
  if (expectation.anyOf) {
    const text = textSpec(product, expectation.key);
    if (text === null) return null;
    const lower = text.toLowerCase();
    const hit = expectation.anyOf.some((needle) => lower.includes(needle.toLowerCase()));
    return {
      fraction: hit ? 1 : (expectation.partial ?? 0),
      display: `${text} ${expectation.label}`.trim(),
      shortfall: `${text} is not ${expectation.label}`,
    };
  }

  const value = numericSpec(product, expectation.key);
  if (value === null) return null;

  const display = formatSpecValue(value, expectation);
  return {
    fraction: expectationScore(value, expectation),
    display,
    // Phrasing has to follow the direction of the spec: 2.3 kg is not "on the
    // low side", it is heavier than wanted.
    shortfall:
      expectation.direction === 'lower'
        ? `${display} is more than ideal`
        : `${display} is on the low side`,
  };
}

// ------------------------------------------------------- hard-constraint gate

export interface ConstraintCheck {
  passes: boolean;
  /** Human-readable reasons this product was excluded. */
  failures: string[];
}

/**
 * Hard constraints are enforced here, in code — never left to the model
 * (Phase 2 §17). A product that fails any of these is not a match, full stop.
 */
export function checkHardConstraints(
  product: ProductSummary,
  requirements: ShoppingRequirements,
): ConstraintCheck {
  const failures: string[] = [];

  if (requirements.budget.max !== null && product.price > requirements.budget.max) {
    failures.push(`over budget (${formatPrice(product.price)})`);
  }
  if (requirements.budget.min !== null && product.price < requirements.budget.min) {
    failures.push(`below the stated price range`);
  }
  if (requirements.requireInStock && !product.availability.inStock) {
    failures.push('out of stock');
  }
  if (requirements.minRating !== null && product.rating < requirements.minRating) {
    failures.push(`rated ${product.rating.toFixed(1)}, below ${requirements.minRating}`);
  }
  if (
    requirements.brands.length > 0 &&
    !requirements.brands.some((brand) => brand.toLowerCase() === product.brand.toLowerCase())
  ) {
    failures.push(`not a ${requirements.brands.join(' or ')} product`);
  }

  for (const constraint of requirements.specConstraints) {
    if (!constraint.hard) continue;
    if (!satisfiesConstraint(product, constraint)) {
      failures.push(describeConstraintFailure(product, constraint));
    }
  }

  return { passes: failures.length === 0, failures };
}

export function satisfiesConstraint(
  product: ProductSummary,
  constraint: SpecConstraint,
): boolean {
  if (constraint.op === 'gte' || constraint.op === 'lte') {
    const value = numericSpec(product, constraint.key);
    const target = Number(constraint.value);
    if (value === null || !Number.isFinite(target)) return false;
    return constraint.op === 'gte' ? value >= target : value <= target;
  }

  const text = textSpec(product, constraint.key);
  if (text === null) return false;

  return constraint.op === 'eq'
    ? text.toLowerCase() === String(constraint.value).toLowerCase()
    : text.toLowerCase().includes(String(constraint.value).toLowerCase());
}

function describeConstraintFailure(
  product: ProductSummary,
  constraint: SpecConstraint,
): string {
  const actual =
    numericSpec(product, constraint.key) ?? textSpec(product, constraint.key) ?? 'not specified';
  const label = constraint.key.replace(/_/g, ' ');
  if (constraint.op === 'gte') return `${label} is ${actual}, below the ${constraint.value} you need`;
  if (constraint.op === 'lte') return `${label} is ${actual}, above the ${constraint.value} limit`;
  return `${label} is ${actual}, not ${constraint.value}`;
}

// ---------------------------------------------------------------------- score

export function scoreProduct(
  product: ProductSummary,
  requirements: ShoppingRequirements,
): { score: number; breakdown: ScoreBreakdown; matchReasons: string[]; limitations: string[] } {
  const matchReasons: string[] = [];
  const limitations: string[] = [];

  // -- budget (30) ----------------------------------------------------------
  let budgetFraction = 1;
  if (requirements.budget.max !== null) {
    const max = requirements.budget.max;
    if (product.price <= max) {
      budgetFraction = 1;
      const headroom = Math.round(((max - product.price) / max) * 100);
      matchReasons.push(
        headroom >= 10
          ? `${formatPrice(product.price)} — ${headroom}% under your ${formatPrice(max)} budget`
          : `${formatPrice(product.price)}, within your ${formatPrice(max)} budget`,
      );
    } else {
      // Over budget still scores, but poorly — used only for `relaxed` results.
      const over = (product.price - max) / max;
      budgetFraction = Math.max(0, 1 - over * 3);
      limitations.push(
        `${formatPrice(product.price)} is ${formatPrice(product.price - max)} over your budget`,
      );
    }
  }

  // -- use cases (25) -------------------------------------------------------
  let useCaseFraction = 1;
  if (requirements.useCases.length > 0) {
    const scores = requirements.useCases.map((useCase) => {
      const expectations = USE_CASE_EXPECTATIONS[useCase] ?? [];
      const tags = USE_CASE_TAGS[useCase] ?? [];

      const haystack = [...product.tags, product.name, product.shortDescription ?? '']
        .join(' ')
        .toLowerCase();
      const tagHit = tags.some((tag) => haystack.includes(tag));

      const specScores: number[] = [];
      for (const expectation of expectations) {
        const evaluated = evaluateExpectation(product, expectation);
        if (evaluated === null) continue;
        specScores.push(evaluated.fraction);

        if (evaluated.fraction >= 1) {
          matchReasons.push(`${evaluated.display} suits ${humaniseUseCase(useCase)}`);
        } else if (evaluated.fraction < 0.6) {
          limitations.push(`${evaluated.shortfall} for ${humaniseUseCase(useCase)}`);
        }
      }

      const specAverage =
        specScores.length > 0
          ? specScores.reduce((sum, value) => sum + value, 0) / specScores.length
          : null;

      if (specAverage === null) return tagHit ? 1 : 0.5;
      return tagHit ? Math.min(1, specAverage + 0.2) : specAverage;
    });

    useCaseFraction = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  }

  // -- explicit spec constraints (20) --------------------------------------
  let specFraction = 1;
  if (requirements.specConstraints.length > 0) {
    const results = requirements.specConstraints.map((constraint): number => {
      const satisfied = satisfiesConstraint(product, constraint);
      if (satisfied) {
        const actual =
          numericSpec(product, constraint.key) ?? textSpec(product, constraint.key);
        if (actual !== null) {
          matchReasons.push(
            `${constraint.key.replace(/_/g, ' ')} is ${actual}${describeTarget(constraint)}`,
          );
        }
      } else if (!constraint.hard) {
        limitations.push(describeConstraintFailure(product, constraint));
      }
      return satisfied ? 1 : 0;
    });
    specFraction = results.reduce((sum, value) => sum + value, 0) / results.length;
  }

  // -- soft preferences (15) ------------------------------------------------
  let preferenceFraction = 1;
  const preferenceKeys = Object.keys(requirements.preferences);
  if (preferenceKeys.length > 0) {
    const scores = preferenceKeys.map((key) => {
      const expectations = PREFERENCE_EXPECTATIONS[key] ?? [];
      const applicable = expectations
        .map((expectation) => evaluateExpectation(product, expectation))
        .filter(
          (entry): entry is NonNullable<ReturnType<typeof evaluateExpectation>> => entry !== null,
        );

      if (applicable.length === 0) return 0.6; // unknown, neither reward nor punish

      const best = applicable.sort((a, b) => b.fraction - a.fraction)[0]!;

      if (best.fraction >= 0.95) {
        matchReasons.push(`${best.display} — good for ${humanisePreference(key)}`);
      } else if (best.fraction < 0.5) {
        limitations.push(`${best.shortfall} if ${humanisePreference(key)} matters`);
      }
      return best.fraction;
    });
    preferenceFraction = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  }

  // -- rating (10) ----------------------------------------------------------
  const ratingFraction = product.rating > 0 ? Math.min(product.rating / 4.5, 1) : 0.5;
  if (product.rating >= 4.5) {
    matchReasons.push(`rated ${product.rating.toFixed(1)} from ${product.reviewCount} reviews`);
  }

  // -- availability caveats (not scored, but always surfaced) ---------------
  if (!product.availability.inStock) {
    limitations.push('currently out of stock');
  } else if (product.availability.lowStock) {
    limitations.push(`only ${product.availability.available} left in stock`);
  }

  const breakdown: ScoreBreakdown = {
    budget: round(budgetFraction * WEIGHTS.budget),
    useCase: round(useCaseFraction * WEIGHTS.useCase),
    specification: round(specFraction * WEIGHTS.specification),
    preference: round(preferenceFraction * WEIGHTS.preference),
    rating: round(ratingFraction * WEIGHTS.rating),
  };

  const score = Math.round(
    breakdown.budget +
      breakdown.useCase +
      breakdown.specification +
      breakdown.preference +
      breakdown.rating,
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown,
    matchReasons: dedupe(matchReasons).slice(0, 4),
    limitations: dedupe(limitations).slice(0, 3),
  };
}

function describeTarget(constraint: SpecConstraint): string {
  if (constraint.op === 'gte') return ` (you asked for at least ${constraint.value})`;
  if (constraint.op === 'lte') return ` (you asked for at most ${constraint.value})`;
  return '';
}

function formatSpecValue(value: number, expectation: SpecExpectation): string {
  return `${value}${expectation.unit ? ` ${expectation.unit}` : ''} ${expectation.label}`.trim();
}

function humaniseUseCase(useCase: UseCase): string {
  return useCase.replace(/_/g, ' ');
}

function humanisePreference(key: string): string {
  return key.replace(/_/g, ' ');
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ------------------------------------------------------------------- ranking

export interface RankOptions {
  limit?: number;
  /** Allow near misses when nothing satisfies every hard constraint. */
  allowRelaxation?: boolean;
}

export function rankCandidates(
  candidates: ProductSummary[],
  requirements: ShoppingRequirements,
  options: RankOptions = {},
): RecommendationOutcome {
  const limit = options.limit ?? 3;
  const allowRelaxation = options.allowRelaxation ?? true;

  if (candidates.length === 0) return { kind: 'empty', considered: 0 };

  const passing: ProductSummary[] = [];
  for (const candidate of candidates) {
    if (checkHardConstraints(candidate, requirements).passes) passing.push(candidate);
  }

  if (passing.length > 0) {
    return {
      kind: 'matches',
      recommendations: buildRecommendations(passing, requirements, limit),
      considered: candidates.length,
    };
  }

  if (!allowRelaxation) return { kind: 'empty', considered: 0 };

  // Nothing met everything. Relax the least essential constraints one at a
  // time and record what we gave up, so the reply can say so out loud.
  const relaxations: Array<{ label: string; requirements: ShoppingRequirements }> = [];

  if (requirements.brands.length > 0) {
    relaxations.push({
      label: `other brands than ${requirements.brands.join('/')}`,
      requirements: { ...requirements, brands: [] },
    });
  }
  if (requirements.minRating !== null) {
    relaxations.push({
      label: `ratings slightly below ${requirements.minRating}`,
      requirements: { ...requirements, minRating: null },
    });
  }
  const softenedSpecs = requirements.specConstraints.filter((constraint) => !constraint.hard);
  if (softenedSpecs.length !== requirements.specConstraints.length) {
    relaxations.push({
      label: 'some specification requirements',
      requirements: { ...requirements, specConstraints: softenedSpecs },
    });
  }
  if (requirements.budget.max !== null) {
    relaxations.push({
      label: `a budget slightly above ${formatPrice(requirements.budget.max)}`,
      requirements: {
        ...requirements,
        budget: { ...requirements.budget, max: Math.round(requirements.budget.max * 1.25) },
      },
    });
  }

  for (const relaxation of relaxations) {
    const relaxedPassing = candidates.filter(
      (candidate) => checkHardConstraints(candidate, relaxation.requirements).passes,
    );
    if (relaxedPassing.length > 0) {
      return {
        kind: 'relaxed',
        // Score against the ORIGINAL requirements so the caveats stay honest.
        recommendations: buildRecommendations(relaxedPassing, requirements, limit),
        considered: candidates.length,
        relaxed: [relaxation.label],
      };
    }
  }

  // Last resort: the closest few by score, all clearly caveated.
  return {
    kind: 'relaxed',
    recommendations: buildRecommendations(candidates, requirements, limit),
    considered: candidates.length,
    relaxed: ['several of your requirements'],
  };
}

function buildRecommendations(
  products: ProductSummary[],
  requirements: ShoppingRequirements,
  limit: number,
): Recommendation[] {
  return products
    .map((product) => {
      const scored = scoreProduct(product, requirements);
      return {
        product,
        score: scored.score,
        breakdown: scored.breakdown,
        matchReasons: scored.matchReasons,
        limitations: scored.limitations,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Deterministic tie-breaks: in-stock first, then rating, then price.
      const stock = Number(b.product.availability.inStock) - Number(a.product.availability.inStock);
      if (stock !== 0) return stock;
      if (b.product.rating !== a.product.rating) return b.product.rating - a.product.rating;
      return a.product.price - b.product.price;
    })
    .slice(0, limit);
}
