import { z } from 'zod';
import { jsonOk, withErrorHandling, badRequest, unauthorized } from '@/lib/api/response';
import { requireUser } from '@/lib/auth';
import { resolveCart, loadCart } from '@/lib/cart/queries';
import { prepareCheckout } from '@/lib/checkout/prepare';
import {
  createConfirmation,
  grantConfirmation,
  loadConfirmation,
  closeConfirmation,
  isConfirmationExpired,
  CONFIRMATION_TTL_MS,
} from '@/lib/checkout/confirmation';
import { recordMoneyEvent } from '@/lib/payments/audit';
import { toMinorUnits, formatMinorUnits } from '@/lib/payments/money';

/**
 * The purchase-confirmation endpoint.
 *
 *   POST { action: "request" } → open a confirmation for the current cart
 *   POST { action: "grant", confirmationId } → the customer's explicit yes
 *   POST { action: "cancel", confirmationId } → the customer backing out
 *
 * Note what the body cannot contain: an amount. The total is computed from the
 * live cart on every call, so a client that wants to be charged less (or a
 * model that hallucinates a number) has nowhere to put it.
 */
const bodySchema = z
  .object({
    action: z.enum(['request', 'grant', 'cancel']),
    confirmationId: z.string().uuid().nullish(),
    conversationId: z.string().uuid().nullish(),
  })
  .strict();

export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireUser();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('Invalid confirmation request.', parsed.error.flatten());
  }
  const { action, confirmationId, conversationId } = parsed.data;

  // ------------------------------------------------------------- request
  if (action === 'request') {
    const context = await resolveCart(false);
    if (!context || context.customerId !== user.id) {
      throw badRequest('There is no cart to confirm.');
    }

    const preview = await prepareCheckout();
    await recordMoneyEvent({
      event: 'checkout_prepared',
      customerId: user.id,
      conversationId: conversationId ?? null,
      amountMinor: toMinorUnits(preview.total),
      currency: 'INR',
      detail: { valid: preview.valid, blockers: preview.blockers },
    });

    if (!preview.valid) {
      return jsonOk(
        {
          confirmation: null,
          checkout: { ...preview, creates_order: false, creates_payment: false },
          message: preview.summary,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const cart = await loadCart(context);
    const confirmation = await createConfirmation({
      customerId: user.id,
      conversationId: conversationId ?? null,
      cartId: context.cartId,
      cart,
    });

    return jsonOk(
      {
        confirmation: {
          id: confirmation.id,
          status: confirmation.status,
          amount_minor: confirmation.amountMinor,
          amount_display: formatMinorUnits(confirmation.amountMinor),
          currency: confirmation.currency,
          cart_hash: confirmation.cartHash,
          expires_at: confirmation.expiresAt,
          expires_in_ms: CONFIRMATION_TTL_MS,
          items: confirmation.snapshot.items,
          subtotal_minor: confirmation.snapshot.subtotal_minor,
          shipping_minor: confirmation.snapshot.shipping_minor,
        },
        checkout: { ...preview, creates_order: false, creates_payment: false },
        message: `Your total is ${formatMinorUnits(confirmation.amountMinor)}. Would you like to proceed to payment?`,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // --------------------------------------------------------------- grant
  if (action === 'grant') {
    if (!confirmationId) throw badRequest('A confirmation id is required.');

    const existing = await loadConfirmation(confirmationId);
    // A confirmation belonging to someone else is reported as simply not
    // found — its existence is not this caller's business.
    if (!existing || existing.customerId !== user.id) {
      throw badRequest('That confirmation is no longer available. Please confirm again.');
    }
    if (isConfirmationExpired(existing)) {
      await closeConfirmation(existing.id, 'expired', { customerId: user.id });
      throw badRequest(
        'Your previous checkout confirmation has expired. Please confirm the current total again.',
      );
    }

    const granted = await grantConfirmation(confirmationId, { customerId: user.id });
    if (!granted) {
      throw badRequest('That confirmation is no longer available. Please confirm again.');
    }

    return jsonOk(
      {
        confirmation: {
          id: granted.id,
          status: granted.status,
          amount_minor: granted.amountMinor,
          amount_display: formatMinorUnits(granted.amountMinor),
          currency: granted.currency,
          expires_at: granted.expiresAt,
        },
        message: 'Confirmed. I can prepare your payment now.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // -------------------------------------------------------------- cancel
  if (!confirmationId) throw badRequest('A confirmation id is required.');
  const existing = await loadConfirmation(confirmationId);
  if (existing && existing.customerId === user.id) {
    await closeConfirmation(existing.id, 'cancelled', { customerId: user.id });
  }
  return jsonOk(
    { confirmation: null, message: 'No problem — I have not taken any payment.' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

export const GET = withErrorHandling(async () => {
  const user = await requireUser();
  if (!user) throw unauthorized();
  const { loadLiveConfirmation } = await import('@/lib/checkout/confirmation');
  const confirmation = await loadLiveConfirmation(user.id);
  return jsonOk(
    {
      confirmation: confirmation
        ? {
            id: confirmation.id,
            status: confirmation.status,
            amount_minor: confirmation.amountMinor,
            amount_display: formatMinorUnits(confirmation.amountMinor),
            expires_at: confirmation.expiresAt,
            expired: isConfirmationExpired(confirmation),
          }
        : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
