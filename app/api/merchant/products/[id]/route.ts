import type { NextRequest } from 'next/server';

import { badRequest, jsonOk, withErrorHandling } from '@/lib/api/response';
import { requireMerchant } from '@/lib/auth';
import { getProductForEditing, setProductActive, updateProduct } from '@/lib/merchant/queries';
import { merchantProductUpdateSchema, uuidSchema } from '@/lib/validation/schemas';

/** GET /api/merchant/products/:id — the full editable record. */
export const GET = withErrorHandling(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    await requireMerchant();
    const { id } = await context.params;
    const product = await getProductForEditing(uuidSchema.parse(id));
    return jsonOk({ product }, { headers: { 'Cache-Control': 'no-store' } });
  },
);

/** PATCH /api/merchant/products/:id — partial update, including specs and stock. */
export const PATCH = withErrorHandling(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    await requireMerchant();
    const { id } = await context.params;
    const productId = uuidSchema.parse(id);

    const body = await request.json().catch(() => {
      throw badRequest('Expected a JSON body.');
    });
    const input = merchantProductUpdateSchema.parse(body);

    await updateProduct(productId, input);
    const product = await getProductForEditing(productId);

    return jsonOk({ product }, { headers: { 'Cache-Control': 'no-store' } });
  },
);

/**
 * DELETE /api/merchant/products/:id
 *
 * Deactivates rather than deletes. Order items reference the product row, and
 * a hard delete would break historical orders.
 */
export const DELETE = withErrorHandling(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    await requireMerchant();
    const { id } = await context.params;
    await setProductActive(uuidSchema.parse(id), false);

    return jsonOk(
      { deactivated: true, message: 'Product deactivated and hidden from the storefront.' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  },
);
