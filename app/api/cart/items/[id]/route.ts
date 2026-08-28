import type { NextRequest } from 'next/server';

import { badRequest, jsonOk, withErrorHandling } from '@/lib/api/response';
import { removeItem, updateItem } from '@/lib/cart/queries';
import { updateCartItemSchema, uuidSchema } from '@/lib/validation/schemas';

/**
 * PATCH /api/cart/items/:id   { quantity }
 * Quantity 0 removes the line. Both operations verify the line belongs to the
 * caller's cart before touching it.
 */
export const PATCH = withErrorHandling(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const itemId = uuidSchema.parse(id);

    const body = await request.json().catch(() => {
      throw badRequest('Expected a JSON body.');
    });
    const { quantity } = updateCartItemSchema.parse(body);

    const { cart, outcome } = await updateItem(itemId, quantity);
    return jsonOk({ cart, outcome }, { headers: { 'Cache-Control': 'no-store' } });
  },
);

/** DELETE /api/cart/items/:id */
export const DELETE = withErrorHandling(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const { cart, outcome } = await removeItem(uuidSchema.parse(id));
    return jsonOk({ cart, outcome }, { headers: { 'Cache-Control': 'no-store' } });
  },
);
