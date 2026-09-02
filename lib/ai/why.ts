import 'server-only';

import { formatPrice } from '@/lib/format';

import { resolveReference, type ReferenceScope } from './references';
import type { CartTurnResult } from './cart-actions';
import type { RecommendedProductPayload } from './types';

/**
 * "Why that one?"
 *
 * Answered from the reasons the recommendation engine recorded when it chose
 * the product, which are stored with the turn that showed it. The model is not
 * asked to remember why it made a suggestion, and it is not asked to invent a
 * justification after the fact — either would let the explanation drift away
 * from the thing that actually decided the ranking.
 *
 * That matters more than it sounds. A shopper asking "why this one?" is
 * deciding whether to trust the recommendation, so an explanation that sounds
 * plausible but is not the real reason is worse than no explanation at all.
 */

/**
 * Deliberately narrow. "Why" turns up inside plenty of sentences that are not
 * questions about a recommendation ("I don't know why I need this"), and
 * hijacking those would be worse than missing a few real ones.
 */
const WHY = new RegExp(
  [
    '^\\s*why\\b',
    '\\bwhy (did|do|are|is|would|should) you\\b',
    '\\bwhy (that|this|these|those|it|them)\\b',
    '\\bwhy (recommend|suggest|pick|choose)',
    '\\breason for (that|this|it)\\b',
    '\\b(kyun|kyu|kyon)\\b',
  ].join('|'),
  'i',
);

export function looksLikeWhyQuestion(message: string): boolean {
  return WHY.test(message);
}

/**
 * Explain a recommendation, or return null to let the turn be handled normally.
 *
 * Null is returned whenever there is nothing honest to say — nothing was shown,
 * or the product that was shown carries no recorded reasoning — rather than
 * falling back to a generic "it's a great fit".
 */
export function answerWhyRecommended(
  message: string,
  scope: ReferenceScope,
  shown: RecommendedProductPayload[],
): CartTurnResult | null {
  if (!looksLikeWhyQuestion(message)) return null;
  if (shown.length === 0) return null;

  // "why that one" usually means the one just led with; a named or ordinal
  // reference overrides that.
  const reference = resolveReference(message, scope, { preferCart: false });
  const picked =
    shown.find((product) => product.productId === reference.productIds[0]) ?? shown[0];

  const reasons = picked.matchReasons.length > 0 ? picked.matchReasons : [picked.reason];
  const stated = reasons.filter((reason) => reason && reason.trim().length > 0);

  if (stated.length === 0) return null;

  const facts: string[] = [];
  if (picked.rating > 0 && picked.reviewCount > 0) {
    facts.push(`it is rated ${picked.rating.toFixed(1)} by ${picked.reviewCount} buyers`);
  }
  if (picked.lowStock && picked.availableQuantity > 0) {
    facts.push(`there are only ${picked.availableQuantity} left`);
  }

  // Reasons are written as fragments ("protects the laptop when you carry it",
  // "a small addition next to the main purchase") because they normally follow
  // "Since you're getting the X, ...". They do not survive a "because", which
  // produced "because protects the laptop when you carry it" — so they are
  // presented as the list they are rather than forced into a clause.
  const shortlist = stated.slice(0, 3);
  const because = shortlist.join('; ');
  const lead = shortlist.length === 1 ? 'because of this' : `for ${shortlist.length} reasons`;
  const extra = facts.length > 0 ? ` For what it's worth, ${facts.join(' and ')}.` : '';

  return {
    message: `I suggested the ${picked.name} at ${formatPrice(picked.price)} ${lead} — ${because}.${extra} If that isn't what you're after, tell me what matters most and I'll look again.`,
    outcome: 'answer',
    cart: null,
    checkout: null,
    products: [],
    // One tap to accept the thing just explained.
    actions: [{ type: 'add_to_cart', productId: picked.productId, label: `Add ${picked.name}` }],
    pendingAction: null,
  };
}
