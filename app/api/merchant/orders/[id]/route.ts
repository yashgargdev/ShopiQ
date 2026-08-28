import type { NextRequest } from 'next/server';

import { badRequest, jsonOk, withErrorHandling } from '@/lib/api/response';
import { requireMerchant } from '@/lib/auth';
import { getOrderAsMerchant, updateOrderStatus } from '@/lib/orders/queries';
import { updateOrderStatusSchema, uuidSchema } from '@/lib/validation/schemas';

/** GET /api/merchant/orders/:id */
export const GET = withErrorHandling(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    await requireMerchant();
    const { id } = await context.params;
    const order = await getOrderAsMerchant(uuidSchema.parse(id));
    return jsonOk({ order }, { headers: { 'Cache-Control': 'no-store' } });
  },
);

/**
 * PATCH /api/merchant/orders/:id   { status }
 *
 * The status change and its inventory movement happen in one transaction:
 * shipping consumes reserved stock, cancelling releases it back.
 */
export const PATCH = withErrorHandling(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    await requireMerchant();
    const { id } = await context.params;
    const orderId = uuidSchema.parse(id);

    const body = await request.json().catch(() => {
      throw badRequest('Expected a JSON body.');
    });
    const { status } = updateOrderStatusSchema.parse(body);

    await updateOrderStatus(orderId, status);
    const order = await getOrderAsMerchant(orderId);

    return jsonOk({ order }, { headers: { 'Cache-Control': 'no-store' } });
  },
);
