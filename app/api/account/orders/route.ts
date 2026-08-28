import { z } from 'zod';
import { jsonOk, withErrorHandling, badRequest, unauthorized } from '@/lib/api/response';
import {
  cancelOrder,
  listMyOrders,
  requestSupport,
  NotSignedInError,
} from '@/lib/ai/tools/account';

/**
 * The customer's own orders, and the actions they may take on them.
 *
 * The same service the assistant's tools call, so a cancellation from this
 * page and one from the conversation go down an identical path — including
 * `set_order_status()`, which moves inventory exactly once under row locks.
 * Two code paths to cancel an order would be two chances to get it wrong.
 */
const actionSchema = z
  .object({
    action: z.enum(['cancel', 'return', 'replacement']),
    orderNumber: z.string().trim().min(4).max(40),
    reason: z.string().trim().max(500).nullish(),
  })
  .strict();

export const GET = withErrorHandling(async () => {
  try {
    return jsonOk({ orders: await listMyOrders(20) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof NotSignedInError) throw unauthorized(error.message);
    throw error;
  }
});

export const POST = withErrorHandling(async (request: Request) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) throw badRequest('Invalid order action.', parsed.error.flatten());

  try {
    if (parsed.data.action === 'cancel') {
      const result = await cancelOrder(parsed.data.orderNumber);
      return jsonOk(
        { ...result, orders: await listMyOrders(20) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const reason = parsed.data.reason?.trim();
    if (!reason || reason.length < 3) {
      throw badRequest('Please tell us briefly what went wrong.');
    }

    const result = await requestSupport(parsed.data.orderNumber, parsed.data.action, reason);
    return jsonOk(
      { ...result, orders: await listMyOrders(20) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof NotSignedInError) throw unauthorized(error.message);
    throw error;
  }
});
