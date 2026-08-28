import type { NextRequest } from 'next/server';

import { badRequest, jsonOk, withErrorHandling } from '@/lib/api/response';
import { requireMerchant } from '@/lib/auth';
import { createProduct, listMerchantProducts } from '@/lib/merchant/queries';
import { merchantProductSchema } from '@/lib/validation/schemas';

/** GET /api/merchant/products — includes inactive products and stock counts. */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireMerchant();

  const params = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 25), 1), 100);
  const page = Math.max(Number(params.get('page') ?? 1), 1);

  const { products, total } = await listMerchantProducts({
    search: params.get('q') ?? undefined,
    categoryId: params.get('category') ?? undefined,
    includeInactive: params.get('includeInactive') !== 'false',
    limit,
    offset: (page - 1) * limit,
  });

  return jsonOk(
    { products, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

/** POST /api/merchant/products — create a product with specs and opening stock. */
export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireMerchant();

  const body = await request.json().catch(() => {
    throw badRequest('Expected a JSON body.');
  });
  const input = merchantProductSchema.parse(body);
  const product = await createProduct(input);

  return jsonOk({ product }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
});
