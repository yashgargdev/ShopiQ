import 'server-only';

import { getProductDetail } from '@/lib/products/queries';
import { categoryExists } from '@/lib/catalog/config';
import { recommendationToCompact, type CompactProduct } from '@/lib/catalog/context';
import { findCompatibleProducts, findRecommendations } from '@/lib/catalog/recommend';

import type { FindCompatibleProductsInput, FindRecommendationsInput } from './schemas';

/**
 * Recommendation tools for the assistant.
 *
 * Thin on purpose. All the work — rules, compatibility, ranking — lives in
 * lib/catalog and is shared with the non-conversational paths, so there is one
 * definition of what goes with what rather than a chat version and a site
 * version that drift.
 *
 * Both return a bounded, compact list with a reason on every entry. Nothing
 * here accepts a price, a score or a product to suggest, so the model can ask
 * the question but never supply the answer.
 */

export interface RecommendationToolResult {
  products: CompactProduct[];
  total: number;
  query: Record<string, unknown>;
  /** Which rules produced this, so a surprising answer can be traced. */
  applied_rules: string[];
  /** Said out loud rather than hidden — an honest gap beats a stretched match. */
  note?: string;
}

export async function findRecommendationsTool(
  input: FindRecommendationsInput,
): Promise<RecommendationToolResult> {
  // Resolving here means an unknown product fails as "not found" rather than
  // silently producing an empty recommendation list.
  const anchor = await getProductDetail(input.product_id);

  const result = await findRecommendations({
    anchor,
    types: input.type ? [input.type] : undefined,
    category: input.category ?? undefined,
    limit: input.limit ?? undefined,
    exclusions: input.exclude_brands?.length ? { brands: input.exclude_brands } : undefined,
  });

  const products = result.recommendations.map(recommendationToCompact);

  return {
    products,
    total: products.length,
    query: {
      product_id: anchor.id,
      anchor: anchor.name,
      ...(input.type ? { type: input.type } : {}),
      ...(input.category ? { category: input.category } : {}),
    },
    applied_rules: result.appliedRules,
    ...(products.length === 0
      ? {
          note:
            result.emptyCategories.length > 0
              ? `Nothing in stock right now for: ${result.emptyCategories.join(', ')}.`
              : 'The catalogue has nothing that pairs with this product.',
        }
      : {}),
  };
}

export async function findCompatibleProductsTool(
  input: FindCompatibleProductsInput,
): Promise<RecommendationToolResult> {
  if (!categoryExists(input.category)) {
    // A typo in a slug would otherwise look identical to "we stock none of
    // those", and the two need different answers.
    return {
      products: [],
      total: 0,
      query: { product_id: input.product_id, category: input.category },
      applied_rules: [],
      note: `"${input.category}" is not a category in this catalogue.`,
    };
  }

  const anchor = await getProductDetail(input.product_id);
  const result = await findCompatibleProducts(anchor, input.category, {
    limit: input.limit ?? 3,
  });

  const products = result.recommendations.map(recommendationToCompact);

  return {
    products,
    total: products.length,
    query: { product_id: anchor.id, anchor: anchor.name, category: input.category },
    applied_rules: result.appliedRules,
    ...(products.length === 0
      ? {
          // The PS5-and-television case: a rule can require 4K at 120 Hz over
          // HDMI 2.1, and if no screen in stock meets that, the honest answer
          // is none — not the nearest television.
          note: `Nothing in ${input.category} currently meets what the ${anchor.name} needs.`,
        }
      : {}),
  };
}
