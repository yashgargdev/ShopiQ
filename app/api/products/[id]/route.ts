import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { getProductDetail } from '@/lib/products/queries';
import { productRefSchema } from '@/lib/validation/schemas';

/**
 * GET /api/products/:id
 *
 * `:id` accepts either the UUID or the slug. Returns the product with its
 * category, images, typed specifications, availability and related products.
 */
export const GET = withErrorHandling(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const ref = productRefSchema.parse(id);
    const product = await getProductDetail(ref);

    return jsonOk(
      { product },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
    );
  },
);
