import type { NextRequest } from 'next/server';

import { badRequest, jsonOk, withErrorHandling } from '@/lib/api/response';
import { requireMerchant } from '@/lib/auth';
import { listInventory, setInventory } from '@/lib/merchant/queries';
import { inventoryUpdateSchema } from '@/lib/validation/schemas';

/** GET /api/merchant/inventory — stock, reserved and available per product. */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireMerchant();

  const params = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 50), 1), 200);
  const page = Math.max(Number(params.get('page') ?? 1), 1);
  const statusParam = params.get('status');
  const status =
    statusParam === 'low_stock' || statusParam === 'out_of_stock' ? statusParam : 'all';

  const { rows, total } = await listInventory({
    search: params.get('q') ?? undefined,
    status,
    limit,
    offset: (page - 1) * limit,
  });

  return jsonOk(
    { inventory: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

/**
 * PATCH /api/merchant/inventory   { productId, quantity, lowStockThreshold? }
 *
 * Rejects a quantity below what is already reserved against open orders, so
 * available can never be driven negative.
 */
export const PATCH = withErrorHandling(async (request: NextRequest) => {
  await requireMerchant();

  const body = await request.json().catch(() => {
    throw badRequest('Expected a JSON body.');
  });
  const input = inventoryUpdateSchema.parse(body);

  await setInventory(input.productId, input.quantity, input.lowStockThreshold);

  return jsonOk({ updated: true }, { headers: { 'Cache-Control': 'no-store' } });
});
