import { z } from 'zod';
import { jsonOk, jsonError, withErrorHandling, badRequest, forbidden } from '@/lib/api/response';
import { requireUser } from '@/lib/auth';
import { paymentProvider } from '@/lib/payments';
import { mockSignature } from '@/lib/payments/mock';
import { verifyAndFinalize, markPaymentFailed } from '@/lib/payments/service';
import { formatMinorUnits } from '@/lib/payments/money';

/**
 * POST /api/payments/mock-complete
 *
 * Stands in for the Razorpay Checkout modal when no Razorpay keys are
 * configured, so the whole flow — approve, pay, verify, order — can be walked
 * in a browser and in the automated tests without an account.
 *
 * Two properties keep this from being a hole:
 *
 *   1. It refuses outright unless the selected provider IS the mock. The
 *      moment real Razorpay keys are present, this endpoint is dead.
 *   2. It does not accept a signature. It asks the mock provider to produce
 *      one and then runs the SAME verification path a real callback runs, so
 *      it cannot be used to skip verification — only to originate a callback
 *      that verification will then judge on its merits.
 *
 * The browser still never signs anything, and never learns a secret.
 */
const bodySchema = z
  .object({
    razorpay_order_id: z.string().min(4).max(120),
    outcome: z.enum(['success', 'failure', 'cancel']).default('success'),
    conversationId: z.string().uuid().nullish(),
  })
  .strict();

export const POST = withErrorHandling(async (request: Request) => {
  await requireUser();

  if (paymentProvider().name !== 'mock') {
    // Real gateway configured: this endpoint must not exist for callers.
    throw forbidden('This endpoint is only available when no payment gateway is configured.');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw badRequest('Invalid request.', parsed.error.flatten());

  const { razorpay_order_id: orderId, outcome } = parsed.data;

  if (outcome === 'cancel') {
    await markPaymentFailed(orderId, 'cancelled_by_customer', true);
    return jsonOk({
      payment: {
        status: 'cancelled',
        order: null,
        message: 'No problem — nothing has been charged and your cart is untouched.',
      },
    });
  }

  // The synthetic id tells the mock provider what to report back, exactly as a
  // real gateway would report its own outcome.
  const paymentId = `pay_${outcome === 'success' ? 'ok' : 'fail'}_${orderId}`;

  const result = await verifyAndFinalize({
    providerOrderId: orderId,
    providerPaymentId: paymentId,
    signature: mockSignature(orderId, paymentId),
    conversationId: parsed.data.conversationId ?? null,
  });

  if (!result.success) {
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
