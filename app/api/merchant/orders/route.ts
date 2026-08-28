import type { NextRequest } from 'next/server';

import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { requireMerchant } from '@/lib/auth';
import { listAllOrders } from '@/lib/orders/queries';
import { ORDER_STATUS_VALUES } from '@/lib/validation/schemas';
import type { OrderStatus } from '@/types';

/** GET /api/merchant/orders?status=&page=&limit= */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireMerchant();

  const params = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 25), 1), 100);
  const page = Math.max(Number(params.get('page') ?? 1), 1);

  const statusParam = params.get('status');
  const status = ORDER_STATUS_VALUES.includes(statusParam as OrderStatus)
    ? (statusParam as OrderStatus)
    : undefined;

  const { orders, total } = await listAllOrders({
    status,
    limit,
    offset: (page - 1) * limit,
  });

  return jsonOk(
    { orders, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
