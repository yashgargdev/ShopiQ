import 'server-only';

import { adminClient } from '@/lib/supabase/admin';

/**
 * Reviews, and what they add up to.
 *
 * The summary is computed here from the rows rather than left to the model to
 * read off a wall of prose. "Nine of nineteen buyers mention battery, seven of
 * them critically" is a fact the assistant can state; a model asked to
 * summarise twenty reviews will produce something that sounds like that and is
 * not checkable. The prose is the model's job; the counting is not.
 *
 * Every review in ShopiQ is demo data. `demo` is carried on the summary so no
 * caller can present them as genuine customer feedback by accident.
 */

export interface ProductReview {
  id: string;
  authorName: string;
  rating: number;
  title: string | null;
  body: string;
  aspects: Record<string, 'positive' | 'negative'>;
  isVerifiedPurchase: boolean;
  createdAt: string;
}

export interface AspectTally {
  aspect: string;
  positive: number;
  negative: number;
  /** Share of the mentions that were positive, 0-1. */
  sentiment: number;
}

export interface ReviewSummary {
  productId: string;
  count: number;
  average: number;
  /** How many reviews gave each star rating, 1-5. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  /** Aspects most often praised, best first. */
  praised: AspectTally[];
  /** Aspects most often criticised, worst first. */
  criticised: AspectTally[];
  /** A few real lines, so the assistant can quote rather than paraphrase. */
  quotes: Array<{ rating: number; title: string | null; body: string }>;
  verifiedShare: number;
  demo: true;
}

const EMPTY_DISTRIBUTION = (): Record<1 | 2 | 3 | 4 | 5, number> => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });

function mapRow(row: Record<string, unknown>): ProductReview {
  return {
    id: String(row.id),
    authorName: String(row.author_name),
    rating: Number(row.rating),
    title: (row.title as string | null) ?? null,
    body: String(row.body),
    aspects: (row.aspects as ProductReview['aspects']) ?? {},
    isVerifiedPurchase: Boolean(row.is_verified_purchase),
    createdAt: String(row.created_at),
  };
}

/** The most recent reviews for a product, newest first. */
export async function listProductReviews(
  productId: string,
  limit = 20,
): Promise<ProductReview[]> {
  const { data, error } = await adminClient()
    .from('product_reviews')
    .select('id, author_name, rating, title, body, aspects, is_verified_purchase, created_at')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));

  if (error) return [];
  return (data ?? []).map(mapRow);
}

/**
 * What the reviews for a product actually say.
 *
 * Returns null when there are none — which the caller must pass on as "no
 * reviews recorded" rather than filling the silence.
 */
export async function summariseProductReviews(
  productId: string,
): Promise<ReviewSummary | null> {
  const { data, error } = await adminClient()
    .from('product_reviews')
    .select('rating, title, body, aspects, is_verified_purchase')
    .eq('product_id', productId)
    .limit(200);

  if (error || !data || data.length === 0) return null;

  const distribution = EMPTY_DISTRIBUTION();
  const tallies = new Map<string, { positive: number; negative: number }>();
  let total = 0;
  let verified = 0;

  for (const row of data) {
    const rating = Number(row.rating) as 1 | 2 | 3 | 4 | 5;
    if (rating >= 1 && rating <= 5) distribution[rating] += 1;
    total += rating;
    if (row.is_verified_purchase) verified += 1;

    const aspects = (row.aspects ?? {}) as Record<string, string>;
    for (const [aspect, sentiment] of Object.entries(aspects)) {
      const tally = tallies.get(aspect) ?? { positive: 0, negative: 0 };
      if (sentiment === 'positive') tally.positive += 1;
      else if (sentiment === 'negative') tally.negative += 1;
      tallies.set(aspect, tally);
    }
  }

  const all: AspectTally[] = [...tallies.entries()].map(([aspect, tally]) => {
    const mentions = tally.positive + tally.negative;
    return {
      aspect,
      positive: tally.positive,
      negative: tally.negative,
      sentiment: mentions === 0 ? 0 : tally.positive / mentions,
    };
  });

  // An aspect only counts as praised or criticised when enough people said so.
  // One person disliking the keyboard is not "buyers complain about the
  // keyboard", and reporting it that way would misrepresent the reviews.
  const MIN_MENTIONS = 2;

  const praised = all
    .filter((entry) => entry.positive >= MIN_MENTIONS && entry.sentiment >= 0.6)
    .sort((a, b) => b.positive - a.positive || b.sentiment - a.sentiment)
    .slice(0, 4);

  const criticised = all
    .filter((entry) => entry.negative >= MIN_MENTIONS && entry.sentiment <= 0.5)
    .sort((a, b) => b.negative - a.negative || a.sentiment - b.sentiment)
    .slice(0, 4);

  // One clearly positive and one clearly critical, so a quote cannot be used to
  // paint a one-sided picture of a divided product.
  const sorted = [...data].sort((a, b) => Number(b.rating) - Number(a.rating));
  const quotes = [sorted[0], sorted[sorted.length - 1]]
    .filter(Boolean)
    .map((row) => ({
      rating: Number(row.rating),
      title: (row.title as string | null) ?? null,
      body: String(row.body),
    }));

  return {
    productId,
    count: data.length,
    average: Math.round((total / data.length) * 10) / 10,
    distribution,
    praised,
    criticised,
    quotes,
    verifiedShare: Math.round((verified / data.length) * 100) / 100,
    demo: true,
  };
}

/** A human label for an aspect key. */
export function aspectLabel(aspect: string): string {
  return aspect.replace(/_/g, ' ');
}
