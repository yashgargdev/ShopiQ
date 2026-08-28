import 'server-only';

import { formatPrice } from '@/lib/format';
import type { ProductSummary } from '@/types';
import type { UseCase } from '@/lib/ai/types';

/**
 * Cross-selling.
 *
 * Two rules make this useful rather than spammy:
 *
 *   1. It only runs when the shopper has actually asked, or is at a moment
 *      where an accessory is obviously the subject. `shouldCrossSell()` is the
 *      gate, and it is deliberately narrow — greeting someone with a mouse
 *      recommendation is exactly the behaviour it exists to prevent.
 *   2. Candidates are scored deterministically on real relationships and real
 *      catalogue values, and each carries the reason it scored. The model
 *      explains that reason; it does not invent one.
 */

export interface CrossSellCandidate {
  product: ProductSummary;
  score: number;
  reason: string;
}

/**
 * Which accessory categories genuinely pair with what, and why. The reason
 * text is the honest justification — it is what the shopper will be told.
 */
const PAIRINGS: Record<string, Array<{ slug: string; reason: string; weight: number }>> = {
  laptops: [
    { slug: 'headphones', reason: 'a proper pair of earphones for calls and music while you work', weight: 0.95 },
    { slug: 'bags', reason: 'protects the laptop when you carry it', weight: 1 },
    { slug: 'mice', reason: 'more comfortable than a trackpad for long sessions', weight: 0.9 },
    { slug: 'keyboards', reason: 'better typing when you work at a desk', weight: 0.7 },
    { slug: 'monitors', reason: 'a second screen for working on a desk', weight: 0.6 },
    { slug: 'home-accessories', reason: 'keeps the laptop charged away from a socket', weight: 0.5 },
  ],
  'gaming-laptops': [
    { slug: 'controllers', reason: 'plays over USB or Bluetooth for the games a keyboard suits badly', weight: 1 },
    { slug: 'mice', reason: 'a gaming mouse is a real upgrade over a trackpad', weight: 1 },
    { slug: 'gaming-headsets', reason: 'positional audio and a mic for playing with friends', weight: 0.95 },
    { slug: 'keyboards', reason: 'mechanical switches for faster input', weight: 0.8 },
    { slug: 'bags', reason: 'gaming laptops are heavy — a padded bag helps', weight: 0.75 },
    { slug: 'gaming-accessories', reason: 'desk mat, charger and hub for the setup', weight: 0.7 },
  ],
  smartphones: [
    { slug: 'headphones', reason: 'most phones no longer include earphones', weight: 1 },
    { slug: 'home-accessories', reason: 'a power bank for long days out', weight: 0.8 },
  ],
  monitors: [
    { slug: 'keyboards', reason: 'completes a desk setup', weight: 0.9 },
    { slug: 'mice', reason: 'completes a desk setup', weight: 0.9 },
  ],
  keyboards: [{ slug: 'mice', reason: 'a matching pointer for the same desk', weight: 0.9 }],
  mice: [{ slug: 'gaming-accessories', reason: 'a mousepad gives the sensor a consistent surface', weight: 0.9 }],
  headphones: [{ slug: 'bags', reason: 'somewhere to keep them safe in transit', weight: 0.5 }],
  'gaming-headsets': [
    { slug: 'controllers', reason: 'for playing on a couch as well as at a desk', weight: 0.7 },
  ],
  controllers: [
    { slug: 'gaming-headsets', reason: 'voice chat while you play', weight: 0.8 },
  ],
  shoes: [
    { slug: 't-shirts', reason: 'completes the kit', weight: 0.6 },
    { slug: 'bags', reason: 'somewhere for a change of clothes', weight: 0.5 },
  ],
  jackets: [{ slug: 't-shirts', reason: 'layers underneath', weight: 0.5 }],
  bags: [{ slug: 'home-accessories', reason: 'a bottle for the side pocket', weight: 0.4 }],
};

/** Use cases that make a particular accessory category more relevant. */
const USE_CASE_BOOSTS: Partial<Record<UseCase, Record<string, number>>> = {
  college: { bags: 0.3, 'home-accessories': 0.2 },
  travel: { bags: 0.3, headphones: 0.2, 'home-accessories': 0.2 },
  gaming: { mice: 0.25, 'gaming-headsets': 0.25, 'gaming-accessories': 0.2 },
  programming: { monitors: 0.25, keyboards: 0.25, mice: 0.15 },
  office: { monitors: 0.2, keyboards: 0.2 },
  gym: { headphones: 0.3 },
  commute: { headphones: 0.3, bags: 0.15 },
  music: { headphones: 0.35 },
};

/**
 * Should we offer accessories at all?
 *
 * Only on an explicit ask, or immediately after the shopper commits to an
 * anchor product. Everything else gets nothing.
 */
export function shouldCrossSell(
  message: string,
  context: { justAddedToCart: boolean },
): boolean {
  const asked =
    /\b(what else|anything else|accessor\w+|add.?ons?|go(es)? with|along with|need with|bhi chahiye|aur kya|kya aur|complete (the )?setup|bundle|recommend.*(with|for) (it|this)|useful)\b/i.test(
      message,
    );

  // "what else would I need for college" is an ask even without "accessory".
  const needsFor = /\b(what|kya)\b.*\b(need|chahiye|lagega|required)\b/i.test(message);

  return asked || needsFor || context.justAddedToCart;
}

/**
 * Rank accessory candidates for an anchor product.
 *
 * Scores on: category pairing strength, use-case fit, price proportionality
 * (an accessory should not cost more than the thing it accessorises),
 * availability, and product quality.
 */
export function rankCrossSell(
  anchor: ProductSummary,
  candidates: ProductSummary[],
  useCases: UseCase[] = [],
  limit = 3,
): CrossSellCandidate[] {
  const pairings = PAIRINGS[anchor.category.slug] ?? [];
  const pairingBySlug = new Map(pairings.map((entry) => [entry.slug, entry]));

  const scored: CrossSellCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.id === anchor.id) continue;
    // Never cross-sell something from the anchor's own category — that is a
    // competing product, not an accessory.
    if (candidate.category.slug === anchor.category.slug) continue;

    const pairing = pairingBySlug.get(candidate.category.slug);
    if (!pairing) continue;

    // 1. relationship strength (0–40)
    let score = pairing.weight * 40;

    // 2. use-case fit (0–20)
    let useCaseBoost = 0;
    for (const useCase of useCases) {
      useCaseBoost = Math.max(
        useCaseBoost,
        USE_CASE_BOOSTS[useCase]?.[candidate.category.slug] ?? 0,
      );
    }
    score += useCaseBoost * 66;

    // 3. price proportionality (0–20). An accessory around 2–15% of the anchor
    // reads as a natural add-on; one that costs more than the anchor does not.
    const ratio = anchor.price > 0 ? candidate.price / anchor.price : 1;
    // Hard floor, not just a penalty: when few accessories are in stock a
    // deprioritised candidate is still the top candidate, and offering ₹1.6L
    // earphones "to go with" a ₹75k phone is not a recommendation.
    if (ratio > 1) continue;
    if (ratio <= 0.2) score += 20;
    else if (ratio <= 0.4) score += 12;
    else if (ratio <= 0.7) score += 5;
    else if (ratio >= 1) score -= 15;

    // 4. availability (0–10). Out of stock is not a recommendation.
    if (!candidate.availability.inStock) continue;
    score += candidate.availability.lowStock ? 4 : 10;

    // 5. quality (0–10)
    score += Math.min(candidate.rating / 5, 1) * 10;

    scored.push({
      product: candidate,
      score: Math.round(Math.max(0, Math.min(100, score))),
      reason: buildReason(anchor, candidate, pairing.reason, useCases, useCaseBoost > 0),
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.product.price - b.product.price)
    .slice(0, limit);
}

function buildReason(
  anchor: ProductSummary,
  candidate: ProductSummary,
  pairingReason: string,
  useCases: UseCase[],
  useCaseRelevant: boolean,
): string {
  const useCase = useCases[0]?.replace(/_/g, ' ');

  // Only claim a use-case connection when the scoring actually found one.
  if (useCaseRelevant && useCase) {
    return `${pairingReason} — useful given you're using the ${anchor.name} for ${useCase} (${formatPrice(candidate.price)})`;
  }
  return `${pairingReason} (${formatPrice(candidate.price)})`;
}

/** The accessory categories worth searching for a given anchor. */
export function accessoryCategoriesFor(categorySlug: string): string[] {
  return (PAIRINGS[categorySlug] ?? []).map((entry) => entry.slug);
}
