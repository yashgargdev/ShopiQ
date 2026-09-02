import 'server-only';

import { formatPrice } from '@/lib/format';
import { aspectLabel, summariseProductReviews } from '@/lib/reviews/queries';
import { searchProductSummaries } from '@/lib/ai/tools/implementations';

import { namesProduct, resolveReference, type ReferenceScope } from './references';
import type { CartTurnResult } from './cart-actions';
import type { RecommendedProductPayload } from './types';

/**
 * "What do the reviews say?"
 *
 * Handled deterministically, before intent routing, for the same reason the
 * "why did you recommend that" answer is: the extractor reads it as a fresh
 * product search and goes looking for a product called "what reviews say",
 * which answers a question nobody asked.
 *
 * Every number in the reply is counted from the review rows. The assistant is
 * never asked to read twenty reviews and form an impression — an impression
 * that sounds like a statistic is the one thing a shopper cannot check, and
 * "most buyers complain about the battery" is a claim worth being right about.
 */

const REVIEW_QUESTION = new RegExp(
  [
    '\\breviews?\\b',
    '\\bratings?\\b',
    '\\bwhat (do|are) (people|buyers|customers|others|users)\\b',
    '\\bis it (any )?good\\b',
    '\\bworth (it|buying|the money)\\b',
    '\\bhow (good|reliable) is\\b',
    '\\b(kaisa|kaisi) hai\\b',
  ].join('|'),
  'i',
);

/** Rules out "I want to review my cart", which is not a question about reviews. */
const NOT_A_REVIEW_QUESTION = /\breview (my|the) (cart|order|basket|details)\b/i;

export function looksLikeReviewQuestion(message: string): boolean {
  return REVIEW_QUESTION.test(message) && !NOT_A_REVIEW_QUESTION.test(message);
}

/**
 * Answer a review question, or return null to let the turn route normally.
 *
 * Null when no product can be identified, or when the product has no reviews —
 * both are cases where the honest move is to say so, not to improvise.
 */
export async function answerReviewQuestion(
  message: string,
  scope: ReferenceScope,
  shown: RecommendedProductPayload[],
): Promise<CartTurnResult | null> {
  if (!looksLikeReviewQuestion(message)) return null;

  const picked = await resolveSubject(message, scope, shown);
  if (!picked) return null;

  const summary = await summariseProductReviews(picked.productId);

  if (!summary || summary.count === 0) {
    return reply(
      `I don't have any reviews recorded for the ${picked.name}, so I can't tell you what other buyers thought.`,
      picked,
    );
  }

  const parts: string[] = [];

  parts.push(
    `The ${picked.name} averages ${summary.average.toFixed(1)} out of 5 from ${summary.count} ${
      summary.count === 1 ? 'review' : 'reviews'
    }.`,
  );

  // The split matters more than the mean: 4.0 from unanimous fours is a very
  // different product from 4.0 from fives and ones.
  const happy = summary.distribution[5] + summary.distribution[4];
  const unhappy = summary.distribution[2] + summary.distribution[1];
  if (unhappy >= Math.max(2, summary.count * 0.15)) {
    parts.push(
      `${happy} rated it four or five, but ${unhappy} gave it two or below — opinions are genuinely split.`,
    );
  }

  if (summary.praised.length > 0) {
    const praised = summary.praised
      .slice(0, 2)
      .map((entry) => `${aspectLabel(entry.aspect)} (${entry.positive} mentions)`)
      .join(' and ');
    parts.push(`What comes up most positively: ${praised}.`);
  }

  if (summary.criticised.length > 0) {
    const criticised = summary.criticised
      .slice(0, 2)
      .map((entry) => `${aspectLabel(entry.aspect)} (${entry.negative})`)
      .join(' and ');
    parts.push(`The recurring complaint is ${criticised}.`);
  } else if (summary.praised.length > 0) {
    parts.push('Nothing is criticised often enough to call it a pattern.');
  }

  const critical = summary.quotes.find((quote) => quote.rating <= 3);
  if (critical) {
    parts.push(`One buyer put it this way: “${critical.body}”`);
  }

  parts.push('These are demonstration reviews, not real customer feedback.');

  return reply(parts.join(' '), picked);
}

/* ------------------------------------------------------------------ helpers */

function reply(message: string, picked: { productId: string; name: string }): CartTurnResult {
  return {
    message,
    outcome: 'answer',
    cart: null,
    checkout: null,
    products: [],
    actions: [
      { type: 'view_product', productId: picked.productId },
      { type: 'add_to_cart', productId: picked.productId, label: `Add ${picked.name}` },
    ],
    pendingAction: null,
  };
}

/**
 * Which product the question is about.
 *
 * What was just shown, first — "what do the reviews say?" almost always means
 * the thing on screen. Failing that, a product named outright, because asking
 * about reviews is a perfectly reasonable way to open a conversation.
 */
async function resolveSubject(
  message: string,
  scope: ReferenceScope,
  shown: RecommendedProductPayload[],
): Promise<{ productId: string; name: string } | null> {
  // What remains once the question itself is stripped away. Empty means they
  // named nothing — "what do the reviews say about it?" is about whatever is on
  // screen, and an earlier version treated the "it" as a name, found no product
  // called "it", and gave up.
  const query = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(
      /\b(what|do|does|did|the|a|an|reviews?|ratings?|rated|say|says|said|about|for|of|is|are|it|this|that|them|those|any|good|bad|worth|buying|buy|money|how|people|buyers|customers|others|users|think|thought|tell|me|and|so|but|hai|kaisa|kaisi)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();

  if (shown.length > 0) {
    const reference = resolveReference(message, scope, { preferCart: false });
    const referenced = shown.find((product) => product.productId === reference.productIds[0]);
    if (referenced) return { productId: referenced.productId, name: referenced.name };

    const named = shown.find((product) =>
      namesProduct(message, { name: product.name, brand: product.brand }),
    );
    if (named) return { productId: named.productId, name: named.name };

    // Nothing else was named, so it is the product they are looking at.
    if (query.length < 3) return { productId: shown[0].productId, name: shown[0].name };
  }

  // They named something. Only a confident match will do — answering about the
  // wrong product's reviews is worse than admitting we do not know which.
  if (query.length < 3) return null;

  try {
    const { products } = await searchProductSummaries({
      query,
      category: null,
      brand: null,
      min_price: null,
      max_price: null,
      min_rating: null,
      filters: null,
      in_stock_only: false,
      sort: 'relevance',
      limit: 3,
    });

    const match = products.find((product) =>
      namesProduct(message, { name: product.name, brand: product.brand }),
    );
    return match ? { productId: match.id, name: match.name } : null;
  } catch {
    return null;
  }
}
