import type { NextRequest } from 'next/server';

import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { listProducts } from '@/lib/products/queries';
import { parseSearchParams, searchQuerySchema } from '@/lib/validation/schemas';

/**
 * GET /api/products/search?q=gaming+laptop
 *
 * Postgres full-text search over name, brand, tags, category, descriptions and
 * specification keys and values, with a trigram fallback on name and brand so
 * near-misses still land. Accepts the same filters as /api/products.
 *
 * This is a static segment, so it takes precedence over /api/products/[id].
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const query = parseSearchParams(searchQuerySchema, request.nextUrl.searchParams);
  const result = await listProducts(query);

  return jsonOk(
    { ...result, query: query.q },
    { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } },
  );
});
