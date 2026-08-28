import { z } from 'zod';
import { jsonOk, withErrorHandling, badRequest } from '@/lib/api/response';
import { getSessionUser } from '@/lib/auth';
import { resolveCart, loadCart } from '@/lib/cart/queries';
import { prepareCheckout } from '@/lib/checkout/prepare';
import {
  createConfirmation,
  grantConfirmation,
  closeConfirmation,
  loadConfirmation,
  isConfirmationExpired,
  loadLiveConfirmation,
  CONFIRMATION_TTL_MS,
} from '@/lib/checkout/confirmation';
import {
  resolveGuestSession,
  updateGuestSession,
  missingDetails,
  type GuestAddress,
} from '@/lib/checkout/guest';
import { reverseGeocode } from '@/lib/geo/reverse';
import { recordMoneyEvent } from '@/lib/payments/audit';
import { formatMinorUnits, toMinorUnits } from '@/lib/payments/money';
import { deliveryEstimateText } from '@/lib/payments/service';

/**
 * The agent checkout endpoint.
 *
 * Everything the voice agent needs to walk a GUEST from "proceed to checkout"
 * to an authorised payment: collecting details conversationally, resolving a
 * location, and opening the confirmation.
 *
 * What it deliberately does not do: take an amount, take an identity, or create
 * a payment. The amount is always recomputed from the live cart, the identity
 * always comes from the session or the httpOnly cart cookie, and payment
 * creation stays behind `/api/payments/create` and its seventeen checks.
 */

const addressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).nullish(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().max(100).optional().default(''),
    postalCode: z.string().trim().max(20).optional().default(''),
    country: z.string().trim().max(60).optional().default('India'),
  })
  .strict();

const bodySchema = z
  .object({
    action: z.enum(['status', 'collect', 'locate', 'quote', 'confirm', 'cancel']),
    conversationId: z.string().uuid().nullish(),
    // Collected details. Each is validated again server-side.
    fullName: z.string().trim().max(120).nullish(),
    email: z.string().trim().max(200).nullish(),
    phone: z.string().trim().max(30).nullish(),
    address: addressSchema.nullish(),
    // Coordinates for `locate`, supplied only after the browser granted permission.
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    confirmationId: z.string().uuid().nullish(),
  })
  .strict();

/**
 * Serverless execution limits.
 *
 * Checkout quotes a total, reverse-geocodes an address and can send an
 * invoice, so it is the slowest path in the app. A platform's default timeout is
 * shorter than that, and a cut-off mid-call surfaces to the shopper as a dead
 * microphone rather than as an error anyone can act on.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withErrorHandling(async (request: Request) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    // An unknown key here is very often an attempt to set an amount.
    throw badRequest(
      'Invalid checkout request. Totals are always calculated by the server.',
      parsed.error.flatten(),
    );
  }
  const body = parsed.data;

  const user = await getSessionUser();
  const context = await resolveCart(false);
  if (!context) {
    return jsonOk(
      { ok: false, reason: 'CART_EMPTY', message: 'Your cart is empty, so there is nothing to check out.' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // A guest gets a checkout session; a signed-in customer already has an
  // account and does not need one.
  const guest = user
    ? null
    : await resolveGuestSession(context.cartId, {
        create: body.action !== 'status',
        conversationId: body.conversationId ?? null,
      });

  const owner = user
    ? { customerId: user.id as string | null, guestSessionId: null as string | null }
    : { customerId: null, guestSessionId: guest?.id ?? null };

  const describe = () => ({
    isGuest: !user,
    missing: user ? [] : missingDetails(guest),
    details: user
      ? { fullName: user.fullName ?? null, email: user.email ?? null, phone: null, address: null }
      : {
          fullName: guest?.fullName ?? null,
          email: guest?.email ?? null,
          phone: guest?.phone ?? null,
          address: guest?.address ?? null,
        },
  });

  // ------------------------------------------------------------- status
  if (body.action === 'status') {
    const live = await loadLiveConfirmation(owner.customerId, owner.guestSessionId);
    return jsonOk(
      {
        ok: true,
        ...describe(),
        confirmation: live
          ? {
              id: live.id,
              status: live.status,
              amount_minor: live.amountMinor,
              amount_display: formatMinorUnits(live.amountMinor),
              expired: isConfirmationExpired(live),
            }
          : null,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ------------------------------------------------------------ collect
  if (body.action === 'collect') {
    if (user) {
      return jsonOk({ ok: true, ...describe() }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (!guest) throw badRequest('No checkout session.');

    const { session, rejected } = await updateGuestSession(guest.id, {
      fullName: body.fullName ?? undefined,
      email: body.email ?? undefined,
      phone: body.phone ?? undefined,
      address: (body.address as GuestAddress | null) ?? undefined,
      addressSource: body.address ? 'manual' : undefined,
      conversationId: body.conversationId ?? null,
    });

    if (body.address) {
      await recordMoneyEvent({
        event: 'checkout_prepared',
        conversationId: body.conversationId ?? null,
        detail: { step: 'address_collected', source: 'manual' },
      });
    }

    return jsonOk(
      {
        ok: true,
        isGuest: true,
        missing: missingDetails(session),
        // Anything the server refused, so the agent can ask again rather than
        // silently proceeding with a misheard email address.
        rejected,
        details: {
          fullName: session.fullName,
          email: session.email,
          phone: session.phone,
          address: session.address,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ------------------------------------------------------------- locate
  if (body.action === 'locate') {
    if (body.latitude == null || body.longitude == null) {
      return jsonOk(
        {
          ok: false,
          reason: 'NO_COORDINATES',
          message: "Sorry, I couldn't determine your location. You can tell me your address instead.",
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const result = await reverseGeocode(body.latitude, body.longitude);
    if (!result.ok || !result.address) {
      // Geolocation is a convenience. Failing it must never block checkout.
      return jsonOk(
        {
          ok: false,
          reason: result.reason ?? 'not_found',
          message: "Sorry, I couldn't turn that into an address. You can tell me your address instead.",
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    if (user) {
      return jsonOk(
        { ok: true, address: result.address, ...describe() },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (!guest) throw badRequest('No checkout session.');

    const { session } = await updateGuestSession(guest.id, {
      address: result.address,
      addressSource: 'geolocation',
      conversationId: body.conversationId ?? null,
    });

    await recordMoneyEvent({
      event: 'checkout_prepared',
      conversationId: body.conversationId ?? null,
      // Coordinates are not written to the audit trail; only that a location
      // was used at all.
      detail: { step: 'address_collected', source: 'geolocation' },
    });

    return jsonOk(
      {
        ok: true,
        address: session.address,
        isGuest: true,
        missing: missingDetails(session),
        details: {
          fullName: session.fullName,
          email: session.email,
          phone: session.phone,
          address: session.address,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // -------------------------------------------------------------- quote
  if (body.action === 'quote') {
    const missing = user ? [] : missingDetails(guest);
    if (missing.length > 0) {
      return jsonOk(
        {
          ok: false,
          reason: 'DETAILS_INCOMPLETE',
          missing,
          message: `I still need your ${missing.join(', ')} before I can total this up.`,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const preview = await prepareCheckout();
    await recordMoneyEvent({
      event: 'checkout_prepared',
      customerId: owner.customerId,
      conversationId: body.conversationId ?? null,
      amountMinor: toMinorUnits(preview.total),
      currency: 'INR',
      detail: { valid: preview.valid, blockers: preview.blockers },
    });

    if (!preview.valid) {
      return jsonOk(
        { ok: false, reason: 'CHECKOUT_BLOCKED', checkout: preview, message: preview.summary },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const cart = await loadCart(context);
    const confirmation = await createConfirmation({
      customerId: owner.customerId,
      guestSessionId: owner.guestSessionId,
      conversationId: body.conversationId ?? null,
      cartId: context.cartId,
      cart,
    });

    return jsonOk(
      {
        ok: true,
        confirmation: {
          id: confirmation.id,
          status: confirmation.status,
          amount_minor: confirmation.amountMinor,
          amount_display: formatMinorUnits(confirmation.amountMinor),
          expires_at: confirmation.expiresAt,
          expires_in_ms: CONFIRMATION_TTL_MS,
          items: confirmation.snapshot.items,
          subtotal_minor: confirmation.snapshot.subtotal_minor,
          shipping_minor: confirmation.snapshot.shipping_minor,
        },
        checkout: { ...preview, creates_order: false, creates_payment: false },
        deliveryEstimate: deliveryEstimateText(),
        ...describe(),
        message: `Your total is ${formatMinorUnits(confirmation.amountMinor)}. Would you like to proceed to payment?`,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ------------------------------------------------------------ confirm
  if (body.action === 'confirm') {
    if (!body.confirmationId) throw badRequest('A confirmation id is required.');

    const existing = await loadConfirmation(body.confirmationId);
    const belongs = user
      ? existing?.customerId === user.id
      : existing?.guestSessionId === owner.guestSessionId;

    if (!existing || !belongs) {
      return jsonOk(
        {
          ok: false,
          reason: 'NO_CONFIRMATION',
          message: 'That total is no longer available. Let me work it out again.',
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (isConfirmationExpired(existing)) {
      await closeConfirmation(existing.id, 'expired', { customerId: owner.customerId });
      return jsonOk(
        {
          ok: false,
          reason: 'CONFIRMATION_EXPIRED',
          message: 'That total has expired. Let me work out the current one again.',
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const granted = await grantConfirmation(existing.id, owner);
    if (!granted) {
      return jsonOk(
        {
          ok: false,
          reason: 'NO_CONFIRMATION',
          message: 'That total is no longer available. Let me work it out again.',
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return jsonOk(
      {
        ok: true,
        confirmation: {
          id: granted.id,
          status: granted.status,
          amount_minor: granted.amountMinor,
          amount_display: formatMinorUnits(granted.amountMinor),
        },
        message: 'Confirmed. Opening secure payment.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ------------------------------------------------------------- cancel
  if (body.confirmationId) {
    const existing = await loadConfirmation(body.confirmationId);
    const belongs = user
      ? existing?.customerId === user.id
      : existing?.guestSessionId === owner.guestSessionId;
    if (existing && belongs) {
      await closeConfirmation(existing.id, 'cancelled', { customerId: owner.customerId });
    }
  }
  return jsonOk(
    { ok: true, message: 'No problem — I have not taken any payment.' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
