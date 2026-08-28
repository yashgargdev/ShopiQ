import { jsonOk, notFound, withErrorHandling } from '@/lib/api/response';
import { getStockFor } from '@/lib/products/queries';
import { supabaseServer } from '@/lib/supabase/server';
import { productRefSchema } from '@/lib/validation/schemas';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/products/:id/inventory
 *
 *   { "productId": "...", "available": true, "quantity": 12, "lowStock": false }
 *
 * Deliberately narrow: reserved_quantity and the reorder threshold stay
 * server-side. Merchants see the full picture at /api/merchant/inventory.
 */
export const GET = withErrorHandling(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const ref = productRefSchema.parse(id);

    let productId = ref;
    if (!UUID_RE.test(ref)) {
      const supabase = await supabaseServer();
      const { data } = await supabase
        .from('products')
        .select('id')
        .eq('slug', ref)
        .eq('is_active', true)
        .maybeSingle();
      if (!data) throw notFound('Product not found.');
      productId = data.id as string;
    }

    const stock = await getStockFor([productId]);
    const availability = stock.get(productId);
    if (!availability) throw notFound('Product not found.');

    return jsonOk(
      {
        productId,
        available: availability.inStock,
        quantity: availability.available,
        lowStock: availability.lowStock,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  },
);
