import 'server-only';

import { formatOrderNumber, parseOrderNumber } from '@/lib/orders/number';

import { getSessionUser } from '@/lib/auth';
import { resolveCart, loadCart } from '@/lib/cart/queries';
import { prepareCheckout } from '@/lib/checkout/prepare';
import {
  CONFIRMATION_TTL_MS,
  closeConfirmation,
  createConfirmation,
  grantConfirmation,
  isConfirmationExpired,
  loadConfirmation,
  loadLiveConfirmation,
  type PurchaseConfirmation,
} from '@/lib/checkout/confirmation';
import { createPayment } from '@/lib/payments/service';
import { getOrderStatus, getPaymentStatus } from '@/lib/payments/status';
import { getOrderByNumber } from './tools/account';
import { listAddresses, type Address } from '@/lib/account/addresses';
import { formatMinorUnits, toMinorUnits } from '@/lib/payments/money';
import { recordMoneyEvent } from '@/lib/payments/audit';
import { paymentStatus } from '@/lib/payments';
import type {
  AgentAction,
  AgentPaymentPayload,
  AgentPurchasePayload,
} from './types';
import type { CartTurnContext, CartTurnResult } from './cart-actions';

/**
 * The purchase turn handlers — the conversational half of Phase 4.
 *
 * The shape of the exchange is fixed and short:
 *
 *   "I'm ready to buy"  → an exact total, itemised, awaiting a yes
 *   "yes"               → a provider order, which the CUSTOMER completes
 *   (they pay)          → server verification, then an order
 *
 * The assistant never asks for a card number, a UPI id, an OTP or a PIN, and
 * it has no tool that could accept one. The provider's own checkout collects
 * payment credentials; ShopiQ only ever sees identifiers and a signature.
 */

const EMPTY: Omit<CartTurnResult, 'message' | 'outcome'> = {
  products: [],
  actions: [],
  cart: null,
  checkout: null,
  pendingAction: null,
  purchase: null,
  payment: null,
  order: null,
};

function toPurchasePayload(confirmation: PurchaseConfirmation): AgentPurchasePayload {
  return {
    confirmationId: confirmation.id,
    status: confirmation.status,
    amountMinor: confirmation.amountMinor,
    amountDisplay: formatMinorUnits(confirmation.amountMinor),
    currency: confirmation.currency,
    expiresAt: confirmation.expiresAt,
    items: confirmation.snapshot.items.map((line) => ({
      productId: line.product_id,
      name: line.name,
      quantity: line.quantity,
      unitPriceMinor: line.unit_price_minor,
      lineTotalMinor: line.line_total_minor,
    })),
    subtotalMinor: confirmation.snapshot.subtotal_minor,
    shippingMinor: confirmation.snapshot.shipping_minor,
  };
}

/**
 * Detect "I'm ready to buy" as distinct from "take me to checkout".
 *
 * Kept narrow on purpose. Widening this is how an assistant ends up quoting a
 * total at someone who was only asking a question.
 */
const BUY_INTENT =
  /\b(buy (it|them|this|now)|purchase (it|this|now)|pay (now|for it)|proceed to pay(ment)?|check ?out now|place (the |my )?order|order (it|this) now|kharid|khareed|paisa de|payment kar)\b/i;

export function looksLikePurchaseRequest(message: string): boolean {
  return BUY_INTENT.test(message);
}

/**
 * Step 1 — quote the exact total and ask for approval.
 *
 * Everything shown here is server-computed from the live cart. The assistant
 * is handed the figures; it never assembles them.
 */
/**
 * Which saved address did the customer name?
 *
 * Matched on label, city, or the house/street line — the three things people
 * actually say ("send it to Office", "the Bengaluru one", "42 MG Road").
 * Returns null when nothing matches, so the caller falls back to the default
 * rather than guessing at a destination.
 */
function pickAddress(message: string, addresses: Address[]): Address | null {
  const lower = message.toLowerCase();

  // Longest candidate first, so "Office Bengaluru" does not match a "Bengaluru"
  // label when a more specific one is present.
  const scored = addresses
    .map((address) => ({
      address,
      terms: [address.label, address.city, address.line1]
        .filter((term): term is string => Boolean(term && term.length >= 3))
        .map((term) => term.toLowerCase()),
    }))
    .flatMap(({ address, terms }) => terms.map((term) => ({ address, term })))
    .sort((a, b) => b.term.length - a.term.length);

  for (const { address, term } of scored) {
    if (lower.includes(term)) return address;
  }
  return null;
}

export async function handlePurchaseQuote(
  context: CartTurnContext,
  message = '',
): Promise<CartTurnResult & { purchase?: AgentPurchasePayload | null }> {
  const user = await getSessionUser();
  if (!user) {
    return {
      ...EMPTY,
      message:
        'You need to be signed in before I can take a payment. Sign in and I will pick this straight back up.',
      outcome: 'payment_blocked',
      actions: [{ type: 'checkout' }],
    };
  }

  const cartContext = await resolveCart(false);
  if (!cartContext || cartContext.customerId !== user.id) {
    return { ...EMPTY, message: "There's nothing in your cart yet.", outcome: 'payment_blocked' };
  }

  const preview = await prepareCheckout();

  await recordMoneyEvent({
    event: 'checkout_prepared',
    customerId: user.id,
    conversationId: context.conversationId,
    amountMinor: toMinorUnits(preview.total),
    currency: 'INR',
    detail: { valid: preview.valid, blockers: preview.blockers, via: 'assistant' },
  });

  if (preview.item_count === 0) {
    return { ...EMPTY, message: "There's nothing in your cart to pay for yet.", outcome: 'payment_blocked' };
  }

  if (!preview.valid) {
    // Out of stock or unavailable — say what and why, and do not open a payment.
    const blocked = preview.items.find((item) => !item.available);
    return {
      ...EMPTY,
      message: blocked
        ? `${blocked.name} is out of stock, so I can't take payment for this cart yet.`
        : preview.summary,
      outcome: 'payment_blocked',
      actions: [{ type: 'view_cart' }],
    };
  }

  // ------------------------------------------------------ delivery address
  // Nothing is quoted until we know where it ships. Previously the address was
  // read at finalization from whichever one happened to be the default, and
  // with none saved the order was created against the literal string "Not
  // provided" — paid for, and going nowhere.
  const addresses = await listAddresses();

  if (addresses.length === 0) {
    return {
      ...EMPTY,
      message:
        "Before I can take payment I need somewhere to send this. Add a delivery address and I'll pick straight back up — open the address form and use **Use my location** to fill it in from your GPS, or type it in.",
      outcome: 'payment_blocked',
      actions: [{ type: 'add_address' }],
    };
  }

  // A stated choice wins; otherwise the default, which is what the customer
  // already nominated for exactly this purpose.
  const chosen = pickAddress(message, addresses) ?? addresses.find((a) => a.isDefault) ?? addresses[0];

  const cart = await loadCart(cartContext);
  const confirmation = await createConfirmation({
    customerId: user.id,
    conversationId: context.conversationId,
    cartId: cartContext.cartId,
    cart,
    shippingAddressId: chosen.id,
    shippingAddress: {
      fullName: chosen.fullName,
      phone: chosen.phone,
      line1: chosen.line1,
      line2: chosen.line2,
      city: chosen.city,
      state: chosen.state,
      postalCode: chosen.postalCode,
      country: chosen.country,
    },
  });

  const purchase = toPurchasePayload(confirmation);
  const changeNote = preview.changes.length > 0 ? `${preview.changes[0].message} ` : '';
  const minutes = Math.round(CONFIRMATION_TTL_MS / 60000);

  const destination = `${chosen.label ? `${chosen.label} — ` : ''}${[chosen.line1, chosen.city, chosen.postalCode].filter(Boolean).join(', ')}`;

  // Offer the alternatives by name, so changing the destination is one short
  // sentence rather than a trip to another page.
  const others = addresses.filter((address) => address.id !== chosen.id);
  const alternatives =
    others.length > 0
      ? ` I can send it to ${others.map((a) => a.label ?? a.city).join(' or ')} instead — just say which.`
      : ' Say "deliver to a new address" if you need a different one.';

  return {
    ...EMPTY,
    purchase,
    message: `${changeNote}Your total is ${purchase.amountDisplay} for ${purchase.items.length} ${
      purchase.items.length === 1 ? 'item' : 'items'
    }, delivering to ${destination}.${alternatives} Shall I take you to payment? This quote holds for ${minutes} minutes.`,
    outcome: 'awaiting_purchase_confirmation',
    actions: [
      {
        type: 'approve_purchase',
        confirmationId: confirmation.id,
        label: 'Proceed to Payment',
        amountDisplay: purchase.amountDisplay,
      },
      { type: 'decline_purchase', confirmationId: confirmation.id },
    ] satisfies AgentAction[],
  };
}

/**
 * Step 2 — the customer said yes. Grant the confirmation, then ask the payment
 * service to authorize and create a provider order.
 *
 * Note the order of operations: granting the confirmation is not what
 * authorizes the charge. `createPayment` re-runs every check afterwards, so a
 * cart that changed between the quote and the yes is still caught here.
 */
export async function handlePurchaseApproval(
  context: CartTurnContext,
  confirmationId?: string | null,
): Promise<CartTurnResult & { purchase?: AgentPurchasePayload | null; payment?: AgentPaymentPayload | null }> {
  const user = await getSessionUser();
  if (!user) {
    return { ...EMPTY, message: 'You need to be signed in to pay.', outcome: 'payment_blocked' };
  }

  // When the UI names a confirmation, honour it — but only if it belongs to
  // this customer. Otherwise fall back to their most recent live one.
  const named = confirmationId ? await loadConfirmation(confirmationId) : null;
  const live = named && named.customerId === user.id ? named : await loadLiveConfirmation(user.id);

  if (!live) {
    return {
      ...EMPTY,
      message:
        "I don't have a confirmed total on the table. Tell me when you're ready to buy and I'll quote it again.",
      outcome: 'payment_blocked',
    };
  }

  if (isConfirmationExpired(live)) {
    await closeConfirmation(live.id, 'expired', { customerId: user.id });
    return {
      ...EMPTY,
      message:
        'Your previous checkout confirmation has expired. Please confirm the current total again.',
      outcome: 'payment_blocked',
      actions: [{ type: 'checkout' }],
    };
  }

  if (live.status === 'pending') {
    await grantConfirmation(live.id, { customerId: user.id });
  }

  const result = await createPayment({
    confirmationId: live.id,
    conversationId: context.conversationId,
  });

  if (!result.success) {
    // A price or cart change is the interesting case: quote both figures so
    // the customer can see exactly what moved.
    const bothTotals =
      result.oldTotalMinor && result.newTotalMinor
        ? ` It was ${formatMinorUnits(result.oldTotalMinor)} and it is now ${formatMinorUnits(result.newTotalMinor)}.`
        : '';

    return {
      ...EMPTY,
      message: `${result.message}${bothTotals}`,
      outcome: 'payment_blocked',
      actions:
        result.reason === 'PRICE_CHANGED' || result.reason === 'CART_CHANGED'
          ? [{ type: 'checkout' }]
          : [{ type: 'view_cart' }],
    };
  }

  const status = paymentStatus();

  return {
    ...EMPTY,
    payment: {
      paymentId: result.paymentId,
      provider: result.provider,
      publicKey: status.publicKey,
      providerOrderId: result.providerOrderId,
      amountMinor: result.amountMinor,
      amountDisplay: formatMinorUnits(result.amountMinor),
      currency: result.currency,
      customerName: user.fullName ?? null,
      customerEmail: user.email ?? null,
    },
    message: `I've prepared your secure payment for ${formatMinorUnits(result.amountMinor)}. Razorpay checkout is ready — complete the payment there and I'll confirm your order.`,
    outcome: 'payment_ready',
    actions: [{ type: 'open_payment' }],
  };
}

/** The customer backing out of a quoted total. */
export async function handlePurchaseDecline(
  context: CartTurnContext,
): Promise<CartTurnResult> {
  const user = await getSessionUser();
  if (user) {
    const live = await loadLiveConfirmation(user.id);
    if (live) await closeConfirmation(live.id, 'cancelled', { customerId: user.id });
  }
  return {
    ...EMPTY,
    message: 'No problem — nothing has been charged and your cart is exactly as it was.',
    outcome: 'cancelled',
    actions: [{ type: 'view_cart' }],
  };
}

/**
 * "Did my payment go through?" — answered from the database, with the
 * settled/unsettled distinction respected in the wording.
 */
export async function handlePaymentStatusQuestion(): Promise<CartTurnResult> {
  const user = await getSessionUser();
  if (!user) {
    return { ...EMPTY, message: 'Sign in and I can check your payments.', outcome: 'answer' };
  }

  const view = await getPaymentStatus(user.id);
  if (!view) {
    return { ...EMPTY, message: "You don't have any payments on your account yet.", outcome: 'answer' };
  }

  const orderNote = view.order_number ? ` Your order is ${formatOrderNumber(view.order_number)}.` : '';
  return {
    ...EMPTY,
    message: `${view.statement} The amount was ${view.amount_display}.${view.settled ? orderNote : ''}`,
    outcome: view.settled ? 'order_confirmed' : 'answer',
  };
}

/** "What did I buy?" / "What was my order number?" — straight from the order row. */
/** A ShopiQ order number, as printed on the invoice: SQ-2026-1055. */
const ORDER_NUMBER = /\b(SQ-\d{4}-\d+)\b/i;

export async function handleOrderStatusQuestion(message = ''): Promise<CartTurnResult> {
  const user = await getSessionUser();
  if (!user) {
    return { ...EMPTY, message: 'Sign in and I can look up your orders.', outcome: 'answer' };
  }

  // A stated order number is answered about THAT order. Falling back to the
  // most recent one would answer a precise question with the wrong order and
  // sound completely confident doing it.
  const stated = parseOrderNumber(message);
  if (stated) {
    const named = await getOrderByNumber(stated);
    if (!named) {
      return {
        ...EMPTY,
        message: `I couldn't find an order numbered ${stated} on your account.`,
        outcome: 'answer',
      };
    }
    const items = named.items.map((item) => `${item.name} × ${item.quantity}`).join(', ');
    return {
      ...EMPTY,
      message: `${formatOrderNumber(named.order_number)} is ${named.status} and the payment is ${named.payment_status}. It covers ${items}, ${named.total_display}.`,
      outcome: 'answer',
      actions: [{ type: 'view_orders' }],
    };
  }

  const order = await getOrderStatus(user.id);
  if (!order) {
    return { ...EMPTY, message: "You don't have any orders yet.", outcome: 'answer' };
  }

  const itemList = order.items
    .map((item) => `${item.name} × ${item.quantity}`)
    .slice(0, 4)
    .join(', ');

  return {
    ...EMPTY,
    order: {
      id: order.order_id,
      orderNumber: order.order_number,
      totalDisplay: order.total_display,
    },
    message: order.confirmed
      ? `Your order ${formatOrderNumber(order.order_number)} is confirmed — ${itemList}, ${order.total_display} paid.`
      : `Your order ${formatOrderNumber(order.order_number)} is ${order.status} and the payment is ${order.payment_status}. It covers ${itemList}, ${order.total_display}.`,
    outcome: order.confirmed ? 'order_confirmed' : 'answer',
    actions: [{ type: 'view_order', orderId: order.order_id }],
  } as CartTurnResult;
}
