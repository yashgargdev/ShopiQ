import { z } from 'zod';
import { jsonOk, jsonError, withErrorHandling, badRequest } from '@/lib/api/response';
import { getSessionUser } from '@/lib/auth';
import { createPayment } from '@/lib/payments/service';
import { recordMoneyEvent } from '@/lib/payments/audit';
import { formatMinorUnits } from '@/lib/payments/money';

/**
 * POST /api/payments/create
 *
 * Creates a Razorpay order for a fully authorized checkout and returns only
 * what the browser needs to open Razorpay Checkout.
 *
 * The request body is `.strict()` and has no amount field. That is the whole
 * design: there is nowhere for a client — or a model — to propose what it
 * should be charged. The server derives the amount from the live cart, having
 * re-validated prices, stock and the customer's confirmation first.
 */
const bodySchema = z
  .object({
    confirmationId: z.string().uuid().nullish(),
    conversationId: z.string().uuid().nullish(),
  })
  .strict();

export const POST = withErrorHandling(async (request: Request) => {
  /**
   * Deliberately NOT requireUser(). A guest shopping through the agent has no
   * account yet — one is created for them at finalization. Authorization is
   * not weakened by this: `authorizePayment()` below still derives identity
   * from either the session or the httpOnly guest-cart cookie, and still runs
   * all seventeen checks. What changes is only WHERE identity comes from, not
   * whether it is verified.
   */
  const user = await getSessionUser();

  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    // An unknown key here is very often an attempt to set the amount.
    throw badRequest(
      'Invalid payment request. Payment amounts are always calculated by the server.',
      parsed.error.flatten(),
    );
  }

  const result = await createPayment({
    confirmationId: parsed.data.confirmationId ?? null,
    conversationId: parsed.data.conversationId ?? null,
  });

  if (!result.success) {
    return jsonError('CONFLICT', result.message, {
      reason: result.reason,
      old_total_minor: result.oldTotalMinor ?? null,
      new_total_minor: result.newTotalMinor ?? null,
      old_total_display: result.oldTotalMinor ? formatMinorUnits(result.oldTotalMinor) : null,
      new_total_display: result.newTotalMinor ? formatMinorUnits(result.newTotalMinor) : null,
      ...(result.detail ?? {}),
    });
  }

  await recordMoneyEvent({
    event: 'payment_initiated',
    customerId: user?.id ?? null,
    conversationId: parsed.data.conversationId ?? null,
    paymentId: result.paymentId,
    amountMinor: result.amountMinor,
    currency: result.currency,
    detail: { reused: result.reused },
  });

  return jsonOk(
    {
      payment: {
        payment_id: result.paymentId,
        provider: result.provider,
        // The PUBLIC key only. The secret never leaves the server.
        key: result.publicKey,
        provider_order_id: result.providerOrderId,
        amount: result.amountMinor,
        amount_display: formatMinorUnits(result.amountMinor),
        currency: result.currency,
        reused: result.reused,
        customer: { name: user?.fullName ?? null, email: user?.email ?? null },
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
