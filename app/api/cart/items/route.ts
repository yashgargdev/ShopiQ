import type { NextRequest } from 'next/server';

import { badRequest, jsonOk, withErrorHandling } from '@/lib/api/response';
import { addItem } from '@/lib/cart/queries';
import { addToCartSchema } from '@/lib/validation/schemas';

/**
 * POST /api/cart/items   { productId, quantity }
 *
 * The body carries no price. The server prices the line from the catalogue,
 * and clamps the quantity to what is actually available.
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const body = await request.json().catch(() => {
    throw badRequest('Expected a JSON body.');
  });

  const { productId, quantity } = addToCartSchema.parse(body);
  const { cart, outcome } = await addItem(productId, quantity);

  return jsonOk({ cart, outcome }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
});
