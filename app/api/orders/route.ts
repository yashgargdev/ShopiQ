import type { NextRequest } from 'next/server';

import { badRequest, jsonOk, withErrorHandling } from '@/lib/api/response';
import { requireUser } from '@/lib/auth';
import { createOrderFromCart, listMyOrders } from '@/lib/orders/queries';
import { createOrderSchema } from '@/lib/validation/schemas';

/** GET /api/orders — the signed-in customer's own orders. */
export const GET = withErrorHandling(async () => {
  await requireUser();
  const orders = await listMyOrders();
  return jsonOk({ orders }, { headers: { 'Cache-Control': 'no-store' } });
});

/**
 * POST /api/orders — place a test order from the current cart.
 *
 * Phase 1 stops at `confirmed` / `unpaid` with payment_method 'test_order'.
 * Razorpay slots in later without changing this contract: the order row and
 * its line-item price snapshots already exist by the time payment starts.
 *
 * Totals in the response come from the database, not from the request.
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await requireUser();

  const body = await request.json().catch(() => {
    throw badRequest('Expected a JSON body.');
  });
  const input = createOrderSchema.parse(body);

  const order = await createOrderFromCart(user, {
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone || undefined,
    shippingAddress: {
      ...input.shippingAddress,
      line2: input.shippingAddress.line2 || null,
    },
    notes: input.notes || undefined,
    saveAddress: input.saveAddress,
  });

  return jsonOk({ order }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
});
