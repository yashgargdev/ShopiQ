import { z } from 'zod';
import { jsonOk, jsonError, withErrorHandling, badRequest } from '@/lib/api/response';
import { requireUser } from '@/lib/auth';
import { verifyAndFinalize, markPaymentFailed } from '@/lib/payments/service';
import { formatMinorUnits } from '@/lib/payments/money';

/**
 * POST /api/payments/verify
 *
 * The browser reports what Razorpay Checkout told it. That report is a CLAIM,
 * not proof — this endpoint re-derives the truth from the signature and from
 * Razorpay's own record of the payment before any order comes into existence.
 *
 * Note there is no `status` field in the schema. A client cannot tell us a
 * payment succeeded; it can only hand over identifiers to be checked.
 */
const bodySchema = z
  .object({
    razorpay_order_id: z.string().min(4).max(120),
    razorpay_payment_id: z.string().min(4).max(120),
    razorpay_signature: z.string().min(16).max(256),
    conversationId: z.string().uuid().nullish(),
  })
  .strict();

const failureSchema = z
  .object({
    razorpay_order_id: z.string().min(4).max(120),
    reason: z.string().max(300).nullish(),
    cancelled: z.boolean().nullish(),
  })
  .strict();

export const POST = withErrorHandling(async (request: Request) => {
  await requireUser();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  // A cancelled or failed attempt reports only the order id.
  const failure = failureSchema.safeParse(raw);
  if (failure.success) {
    await markPaymentFailed(
      failure.data.razorpay_order_id,
      failure.data.reason ?? 'reported_by_client',
      Boolean(failure.data.cancelled),
    );
    return jsonOk(
      {
        payment: {
          status: failure.data.cancelled ? 'cancelled' : 'failed',
          order: null,
          message: failure.data.cancelled
            ? 'No problem — nothing has been charged and your cart is untouched.'
            : "The payment wasn't completed. Your cart is still safe, and you can try again.",
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('Invalid verification payload.', parsed.error.flatten());
  }

  const result = await verifyAndFinalize({
    providerOrderId: parsed.data.razorpay_order_id,
    providerPaymentId: parsed.data.razorpay_payment_id,
    signature: parsed.data.razorpay_signature,
    conversationId: parsed.data.conversationId ?? null,
  });

  if (!result.success) {
    // 409 rather than 400: the request was well-formed, the outcome is not a
    // success. The status field tells the client which safe state it is in.
    return jsonError('CONFLICT', result.message, {
      reason: result.reason ?? null,
      status: result.status,
    });
  }

  return jsonOk(
    {
      payment: {
        status: result.status,
        message: result.message,
        order: {
          id: result.orderId,
          order_number: result.orderNumber,
          total_minor: result.totalMinor,
          total_display: result.totalMinor ? formatMinorUnits(result.totalMinor) : null,
        },
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
