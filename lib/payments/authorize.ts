import 'server-only';
import { resolveCart, loadCart } from '@/lib/cart/queries';
import { prepareCheckout } from '@/lib/checkout/prepare';
import {
  cartFingerprint,
  isConfirmationExpired,
  closeConfirmation,
  loadConfirmation,
  loadLiveConfirmation,
  type PurchaseConfirmation,
} from '@/lib/checkout/confirmation';
import { getSessionUser } from '@/lib/auth';
import {
  missingDetails,
  resolveGuestSession,
  type GuestCheckoutSession,
} from '@/lib/checkout/guest';
import { recordMoneyEvent } from './audit';
import { toMinorUnits } from './money';
import type { Cart } from '@/types';

/**
 * The Level 4 gate.
 *
 * Everything above this line in the stack — the AI, the chat route, the
 * browser — can only ASK for a payment. This module is the only thing that can
 * say yes, and it says yes only when all seventeen conditions in the Phase 4
 * spec hold at once, re-checked against the live database at the moment of
 * asking rather than trusted from whenever checkout was prepared.
 *
 * Nothing here reads an amount from its caller. The amount is derived.
 */

export type AuthorizationFailure =
  | 'AUTH_REQUIRED'
  | 'CART_EMPTY'
  | 'CART_NOT_FOUND'
  | 'NO_CONFIRMATION'
  | 'CONFIRMATION_NOT_CONFIRMED'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_CONSUMED'
  | 'CONFIRMATION_FOREIGN'
  | 'CART_CHANGED'
  | 'PRICE_CHANGED'
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_STOCK'
  | 'PRODUCT_UNAVAILABLE'
  | 'SHIPPING_REQUIRED'
  | 'GUEST_DETAILS_INCOMPLETE'
  | 'AMOUNT_MISMATCH';

export interface AuthorizationRejection {
  authorized: false;
  reason: AuthorizationFailure;
  message: string;
  /** Present when the total moved, so the UI can show old vs new. */
  oldTotalMinor?: number;
  newTotalMinor?: number;
  detail?: Record<string, unknown>;
}

export interface AuthorizationGrant {
  authorized: true;
  /**
   * Null for a guest. The account is created at finalization, because
   * `customers.id` is a foreign key to `auth.users(id)` and an order cannot
   * exist without one — see lib/checkout/guest.ts.
   */
  customerId: string | null;
  /** Set instead of customerId when this is a guest agent checkout. */
  guestSession: GuestCheckoutSession | null;
  cartId: string;
  cart: Cart;
  confirmation: PurchaseConfirmation;
  /** The only amount that may ever reach a payment provider. */
  amountMinor: number;
  currency: 'INR';
  cartHash: string;
}

export type AuthorizationResult = AuthorizationGrant | AuthorizationRejection;

const reject = (
  reason: AuthorizationFailure,
  message: string,
  extra: Partial<AuthorizationRejection> = {},
): AuthorizationRejection => ({ authorized: false, reason, message, ...extra });

/**
 * Authorize a payment for the signed-in customer's current cart.
 *
 * `confirmationId` is optional: when the caller names one it must belong to
 * this customer, and when it does not, the customer's most recent live
 * confirmation is used. Either way the confirmation is re-validated here.
 */
export async function authorizePayment(options: {
  confirmationId?: string | null;
  conversationId?: string | null;
} = {}): Promise<AuthorizationResult> {
  // 1. Identity. Either an authenticated customer OR a guest checkout session
  //    bound to the httpOnly guest-cart cookie. In both cases identity is
  //    DERIVED, never supplied — a caller still cannot name whose cart to
  //    charge, which is the property this check exists to hold.
  const user = await getSessionUser();

  // 2–3. A cart that exists and is not empty.
  const context = await resolveCart(false);
  if (!context) {
    return reject('CART_NOT_FOUND', 'I could not find a cart for this session.');
  }

  let guestSession: GuestCheckoutSession | null = null;
  const ownerId = user?.id ?? null;

  if (user) {
    if (context.customerId !== user.id) {
      return reject('CART_NOT_FOUND', 'I could not find a cart for your account.');
    }
  } else {
    // Guest path. The session is looked up by cart id and only exists if it
    // was created against this browser's cart cookie.
    guestSession = await resolveGuestSession(context.cartId);
    if (!guestSession) {
      return reject(
        'AUTH_REQUIRED',
        'I still need your delivery details before I can take payment.',
      );
    }
    if (guestSession.status === 'consumed') {
      return reject('CONFIRMATION_CONSUMED', 'That checkout has already been completed.');
    }
    if (Date.parse(guestSession.expiresAt) <= Date.now()) {
      return reject(
        'AUTH_REQUIRED',
        'Your checkout details have expired. Let me take them again.',
      );
    }

    // Every detail required to actually deliver the order must be present.
    const missing = missingDetails(guestSession);
    if (missing.length > 0) {
      return reject(
        'GUEST_DETAILS_INCOMPLETE',
        `I still need your ${missing.join(', ')} before I can take payment.`,
        { detail: { missing } },
      );
    }
  }

  const cart = await loadCart(context);
  if (cart.items.length === 0) {
    return reject('CART_EMPTY', 'Your cart is empty, so there is nothing to pay for.');
  }

  // 4–10. Products exist, are active and purchasable; stock is sufficient;
  //       totals are recomputed server-side. prepareCheckout() is the same
  //       validation the Phase 3 preview uses — reused, not reimplemented.
  const preview = await prepareCheckout();

  await recordMoneyEvent({
    event: 'price_validated',
    customerId: ownerId,
    conversationId: options.conversationId ?? null,
    amountMinor: toMinorUnits(preview.total),
    currency: 'INR',
    detail: { changes: preview.changes.length, blockers: preview.blockers },
  });

  if (preview.blockers.includes('out_of_stock')) {
    const line = preview.items.find((item) => !item.available);
    return reject('OUT_OF_STOCK', `${line?.name ?? 'An item'} is out of stock.`, {
      detail: { product: line?.name ?? null, product_id: line?.product_id ?? null },
    });
  }
  if (preview.blockers.includes('insufficient_stock')) {
    const line = preview.items.find(
      (item) => item.available_quantity != null && item.available_quantity < item.quantity,
    );
    return reject(
      'INSUFFICIENT_STOCK',
      line
        ? `Only ${line.available_quantity} of ${line.name} ${line.available_quantity === 1 ? 'is' : 'are'} available.`
        : 'One of your items no longer has enough stock.',
      {
        detail: {
          product: line?.name ?? null,
          requested: line?.quantity ?? null,
          available: line?.available_quantity ?? null,
        },
      },
    );
  }
  if (!preview.valid) {
    return reject('PRODUCT_UNAVAILABLE', preview.summary, {
      detail: { blockers: preview.blockers },
    });
  }

  await recordMoneyEvent({
    event: 'inventory_validated',
    customerId: ownerId,
    conversationId: options.conversationId ?? null,
    detail: { lines: preview.items.length },
  });

  // 11–12. The authoritative amount. Derived here, from the live catalogue.
  const amountMinor = toMinorUnits(preview.total);
  const { hash: currentHash } = cartFingerprint(cart);

  // 13–14. A confirmation that exists and belongs to this caller.
  const confirmation = options.confirmationId
    ? await loadConfirmation(options.confirmationId)
    : await loadLiveConfirmation(ownerId, guestSession?.id ?? null);

  if (!confirmation) {
    return reject('NO_CONFIRMATION', 'I need you to confirm the total before I can take payment.', {
      newTotalMinor: amountMinor,
    });
  }
  const belongsToCaller = user
    ? confirmation.customerId === user.id
    : confirmation.guestSessionId === guestSession?.id;
  if (!belongsToCaller) {
    // Deliberately the same message as "no confirmation": whether someone
    // else's confirmation id exists is not this caller's business.
    return reject('CONFIRMATION_FOREIGN', 'I need you to confirm the total before I can take payment.');
  }
  if (confirmation.status === 'consumed') {
    return reject('CONFIRMATION_CONSUMED', 'That confirmation has already been used.');
  }
  if (confirmation.status !== 'confirmed') {
    return reject(
      'CONFIRMATION_NOT_CONFIRMED',
      'I need you to confirm the total before I can take payment.',
      { newTotalMinor: amountMinor },
    );
  }

  // 15. Not expired.
  if (isConfirmationExpired(confirmation)) {
    await closeConfirmation(confirmation.id, 'expired', { customerId: ownerId });
    return reject(
      'CONFIRMATION_EXPIRED',
      'Your previous checkout confirmation has expired. Please confirm the current total again.',
      { oldTotalMinor: confirmation.amountMinor, newTotalMinor: amountMinor },
    );
  }

  // 16. The cart has not moved since the customer said yes.
  if (confirmation.cartHash !== currentHash) {
    await closeConfirmation(confirmation.id, 'invalidated', {
      customerId: ownerId,
      reason: 'cart_hash_mismatch',
    });

    // Distinguish a price change from a contents change, because the customer
    // deserves to be told which one happened.
    const before = confirmation.snapshot;
    const sameLines =
      before.items.length === cart.items.length &&
      before.items.every((line) =>
        cart.items.some(
          (item) => item.productId === line.product_id && item.quantity === line.quantity,
        ),
      );

    return reject(
      sameLines ? 'PRICE_CHANGED' : 'CART_CHANGED',
      sameLines
        ? 'The price changed since you confirmed, so I need you to approve the new total.'
        : 'Your cart changed since you confirmed, so I need you to approve the new total.',
      { oldTotalMinor: confirmation.amountMinor, newTotalMinor: amountMinor },
    );
  }

  // 17. And the amount the confirmation carries still matches the live total.
  //     Belt and braces: the hash covers this, but an amount mismatch at the
  //     point of charging is worth a separate, explicit refusal.
  if (confirmation.amountMinor !== amountMinor) {
    await closeConfirmation(confirmation.id, 'invalidated', {
      customerId: ownerId,
      reason: 'amount_mismatch',
    });
    return reject('AMOUNT_MISMATCH', 'The total changed, so I need you to confirm again.', {
      oldTotalMinor: confirmation.amountMinor,
      newTotalMinor: amountMinor,
    });
  }

  return {
    authorized: true,
    customerId: ownerId,
    guestSession,
    cartId: context.cartId,
    cart,
    confirmation,
    amountMinor,
    currency: 'INR',
    cartHash: currentHash,
  };
}
