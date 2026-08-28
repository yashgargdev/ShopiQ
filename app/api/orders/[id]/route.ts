import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { requireUser } from '@/lib/auth';
import { getOrder } from '@/lib/orders/queries';
import { uuidSchema } from '@/lib/validation/schemas';

/**
 * GET /api/orders/:id
 *
 * Reads through the caller's own session, so the RLS policy on public.orders
 * (customer_id = auth.uid() OR is_merchant()) is what enforces isolation —
 * guessing another customer's order id returns 404, not their data.
 */
export const GET = withErrorHandling(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const { id } = await context.params;
    const order = await getOrder(uuidSchema.parse(id));

    return jsonOk({ order }, { headers: { 'Cache-Control': 'no-store' } });
  },
);
