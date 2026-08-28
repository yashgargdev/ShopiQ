import type { NextRequest } from 'next/server';

import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { listProducts } from '@/lib/products/queries';
import { parseSearchParams, productQuerySchema } from '@/lib/validation/schemas';

/**
 * GET /api/products
 *
 * Query: page, limit, category, brand (csv), minPrice, maxPrice, rating,
 *        inStock, featured, sort, q
 *
 * Example: /api/products?category=laptops&maxPrice=80000&sort=price_asc
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const query = parseSearchParams(productQuerySchema, request.nextUrl.searchParams);
  const result = await listProducts(query);

  return jsonOk(result, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
  });
});
