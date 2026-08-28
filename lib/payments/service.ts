import 'server-only';
import { createHash } from 'node:crypto';
import { adminClient } from '@/lib/supabase/admin';
import { getDefaultAddress } from '@/lib/orders/queries';
import { closeConfirmation } from '@/lib/checkout/confirmation';
import { authorizePayment, type AuthorizationRejection } from './authorize';
import { paymentProvider, paymentStatus } from './index';
import { recordMoneyEvent } from './audit';
import { attributeOrder, recordCommerceEvent } from '@/lib/analytics/track';
import { consumeGuestSession, loadGuestSessionById } from '@/lib/checkout/guest';
import { ensureAccountForEmail, sendEmail } from '@/lib/email/service';
import { renderInvoiceEmail } from '@/lib/email/template';
import type { ProviderPayment } from './provider';

/**
 * Payment orchestration.
 *
 * The order of operations is the whole point:
 *
 *   authorize → provider order → (browser pays) → verify server-side →
 *   finalize in one transaction → audit
 *
 * A browser saying "it worked" is treated as a claim to be checked, never as
 * proof. Only `finalize_paid_payment()` creates an order, and only after this
 * module has verified the signature AND re-read the payment from the provider.
 */

export type PaymentStatus =
  | 'created'
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'verification_pending';

/** Which transitions are legal. Nothing outside this table may happen. */
const ALLOWED_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  created: ['pending', 'authorized', 'captured', 'failed', 'cancelled', 'verification_pending'],
  pending: ['authorized', 'captured', 'failed', 'cancelled', 'verification_pending'],
  authorized: ['captured', 'failed', 'refunded', 'verification_pending'],
  verification_pending: ['captured', 'authorized', 'failed', 'cancelled'],
  captured: ['refunded'],
  failed: [],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Move a payment to a new status, refusing an illegal transition.
 *
 * `captured` is terminal apart from a refund: once an order exists, nothing
 * arriving later — a late webhook, a retried callback — may quietly undo it.
 */
export async function transitionPayment(
  paymentId: string,
  to: PaymentStatus,
  extra: { failureReason?: string | null; providerPaymentId?: string | null } = {},
): Promise<{ ok: boolean; from: PaymentStatus | null; to: PaymentStatus }> {
  const db = adminClient();
  const { data: current } = await db
    .from('payments')
    .select('status')
    .eq('id', paymentId)
    .maybeSingle();

  if (!current) return { ok: false, from: null, to };
  const from = current.status as PaymentStatus;

  if (!canTransition(from, to)) {
    await recordMoneyEvent({
      event: 'payment_verification_failed',
      paymentId,
      detail: { rejected_transition: `${from} -> ${to}` },
    });
    return { ok: false, from, to };
  }

  const patch: Record<string, unknown> = { status: to, updated_at: new Date().toISOString() };
  if (extra.failureReason !== undefined) patch.failure_reason = extra.failureReason;
  if (extra.providerPaymentId) patch.provider_payment_id = extra.providerPaymentId;

  await db.from('payments').update(patch).eq('id', paymentId);
  return { ok: true, from, to };
}

// ---------------------------------------------------------------- creation

export interface CreatePaymentSuccess {
  success: true;
  paymentId: string;
  providerOrderId: string;
  provider: string;
  publicKey: string | null;
  amountMinor: number;
  currency: string;
  /** True when an existing in-flight payment was returned instead of a new one. */
  reused: boolean;
}

export interface CreatePaymentFailure {
  success: false;
  reason: string;
  message: string;
  oldTotalMinor?: number;
  newTotalMinor?: number;
  detail?: Record<string, unknown>;
}

export type CreatePaymentResult = CreatePaymentSuccess | CreatePaymentFailure;

/**
 * Create a provider order for a fully authorized checkout.
 *
 * Idempotent per confirmation: a double-clicked Pay button, or a model calling
 * the tool twice, returns the SAME provider order rather than opening a second
 * one. Two provider orders for one confirmation is how a customer ends up
 * paying twice.
 */
export async function createPayment(options: {
  confirmationId?: string | null;
  conversationId?: string | null;
} = {}): Promise<CreatePaymentResult> {
  const authorization = await authorizePayment(options);

  if (!authorization.authorized) {
    const rejection = authorization as AuthorizationRejection;
    await recordMoneyEvent({
      event: 'payment_verification_failed',
      conversationId: options.conversationId ?? null,
      detail: { stage: 'authorization', reason: rejection.reason },
    });
    return {
      success: false,
      reason: rejection.reason,
      message: rejection.message,
      oldTotalMinor: rejection.oldTotalMinor,
      newTotalMinor: rejection.newTotalMinor,
      detail: rejection.detail,
    };
  }

  const db = adminClient();
  const { confirmation, amountMinor, customerId, currency } = authorization;

  // Reuse an in-flight payment for this confirmation rather than creating a
  // second provider order.
  const { data: existing } = await db
    .from('payments')
    .select('id, provider, provider_order_id, amount_minor, currency, status')
    .eq('confirmation_id', confirmation.id)
    .in('status', ['created', 'pending', 'authorized', 'verification_pending'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const status = paymentStatus();

  if (existing?.provider_order_id && Number(existing.amount_minor) === amountMinor) {
    return {
      success: true,
      paymentId: existing.id,
      providerOrderId: existing.provider_order_id,
      provider: existing.provider,
      publicKey: status.publicKey,
      amountMinor,
      currency,
      reused: true,
    };
  }

  const provider = paymentProvider();
  // Receipt must be unique per attempt and must not leak anything.
  const receipt = `shopiq_${confirmation.id.replace(/-/g, '').slice(0, 24)}`;

  let providerOrder;
  try {
    providerOrder = await provider.createOrder({
      amountMinor,
      currency,
      receipt,
      // Notes are provider metadata and must be strings. A guest has no
      // customer id yet — the guest session is the stable reference until the
      // account is created at finalization.
      notes: {
        confirmation_id: confirmation.id,
        ...(customerId ? { customer_id: customerId } : {}),
        ...(authorization.guestSession ? { guest_session_id: authorization.guestSession.id } : {}),
      },
    });
  } catch (error: any) {
    await recordMoneyEvent({
      event: 'payment_failed',
      customerId,
      confirmationId: confirmation.id,
      amountMinor,
      currency,
      detail: { stage: 'provider_order', code: error?.code ?? 'PROVIDER_ERROR' },
    });
    return {
      success: false,
      reason: error?.code ?? 'PROVIDER_ERROR',
      message: 'I could not reach the payment provider. Nothing has been charged.',
    };
  }

  const { data: payment, error } = await db
    .from('payments')
    .insert({
      // One of these two is always set — the payments_owner_present CHECK
      // makes an ownerless payment impossible rather than merely unlikely.
      customer_id: customerId,
      guest_session_id: authorization.guestSession?.id ?? null,
      confirmation_id: confirmation.id,
      provider: provider.name,
      provider_order_id: providerOrder.id,
      amount_minor: amountMinor,
      currency,
      status: 'created',
      metadata: { receipt, cart_hash: authorization.cartHash },
    })
    .select('id')
    .single();

  if (error) throw error;

  await recordMoneyEvent({
    event: 'provider_order_created',
    customerId,
    conversationId: options.conversationId ?? null,
    confirmationId: confirmation.id,
    paymentId: payment.id,
    amountMinor,
    currency,
    detail: { provider: provider.name, provider_order_id: providerOrder.id },
  });

  return {
    success: true,
    paymentId: payment.id,
    providerOrderId: providerOrder.id,
    provider: provider.name,
    publicKey: status.publicKey,
    amountMinor,
    currency,
    reused: false,
  };
}

// ------------------------------------------------------------ verification

export interface VerifyResult {
  success: boolean;
  status: PaymentStatus;
  reason?: string;
  message: string;
  orderId?: string;
  orderNumber?: string;
  totalMinor?: number;
  /** Configured, never invented. See deliveryEstimateText(). */
  deliveryEstimate?: string;
  accountCreated?: boolean;
  invoiceEmail?: string | null;
}

/**
 * Verify a checkout callback and, if it holds up, finalize the order.
 *
 * Three independent checks before anything is created:
 *   1. the HMAC signature over order|payment,
 *   2. the provider's own record of the payment,
 *   3. the amount and currency matching what we authorized.
 *
 * Failing any of them leaves the payment in a safe non-success state with the
 * cart untouched.
 */
export async function verifyAndFinalize(input: {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
  conversationId?: string | null;
}): Promise<VerifyResult> {
  const db = adminClient();
  const provider = paymentProvider();

  const { data: payment } = await db
    .from('payments')
    .select('id, customer_id, confirmation_id, amount_minor, currency, status, order_id, provider')
    .eq('provider_order_id', input.providerOrderId)
    .maybeSingle();

  if (!payment) {
    return {
      success: false,
      status: 'failed',
      reason: 'PAYMENT_NOT_FOUND',
      message: 'I could not find that payment.',
    };
  }

  await recordMoneyEvent({
    event: 'payment_callback_received',
    customerId: payment.customer_id,
    conversationId: input.conversationId ?? null,
    paymentId: payment.id,
    detail: { provider_order_id: input.providerOrderId },
  });

  // A terminal payment stays terminal. Razorpay can legitimately report a
  // failure and then a success against the same order when a customer retries,
  // but this row represents ONE attempt — reviving it would turn a declined
  // payment into a fulfilled order. A retry gets a fresh confirmation and a
  // fresh provider order, which createPayment() already arranges because it
  // never reuses a payment in a terminal state.
  if (payment.status === 'failed' || payment.status === 'cancelled' || payment.status === 'refunded') {
    await recordMoneyEvent({
      event: 'payment_verification_failed',
      customerId: payment.customer_id,
      paymentId: payment.id,
      detail: { stage: 'terminal_status', status: payment.status },
    });
    return {
      success: false,
      status: payment.status as PaymentStatus,
      reason: 'PAYMENT_TERMINAL',
      message:
        "That payment attempt didn't complete. Your cart is still safe — start the payment again and I'll set up a fresh one.",
    };
  }

  // Already finalized — return the existing order. A retried callback is not
  // an error and must not produce a second order.
  if (payment.order_id) {
    const { data: order } = await db
      .from('orders')
      .select('id, order_number, total')
      .eq('id', payment.order_id)
      .maybeSingle();
    return {
      success: true,
      status: 'captured',
      message: 'This payment was already confirmed.',
      orderId: order?.id,
      orderNumber: order?.order_number,
      totalMinor: Number(payment.amount_minor),
    };
  }

  // 1. Signature.
  const signatureOk = provider.verifyPaymentSignature({
    orderId: input.providerOrderId,
    paymentId: input.providerPaymentId,
    signature: input.signature,
  });

  if (!signatureOk) {
    await transitionPayment(payment.id, 'verification_pending', {
      failureReason: 'signature_mismatch',
    });
    await recordMoneyEvent({
      event: 'payment_verification_failed',
      customerId: payment.customer_id,
      paymentId: payment.id,
      detail: { stage: 'signature' },
    });
    return {
      success: false,
      status: 'verification_pending',
      reason: 'SIGNATURE_INVALID',
      message: "I couldn't verify the payment yet, so I haven't marked the order as confirmed.",
    };
  }

  // 2. The provider's own record.
  let remote: ProviderPayment;
  try {
    remote = await provider.fetchPayment(input.providerPaymentId);
  } catch {
    await transitionPayment(payment.id, 'verification_pending', {
      failureReason: 'provider_unreachable',
      providerPaymentId: input.providerPaymentId,
    });
    return {
      success: false,
      status: 'verification_pending',
      reason: 'PROVIDER_UNREACHABLE',
      message: "I couldn't verify the payment yet, so I haven't marked the order as confirmed.",
    };
  }

  if (remote.status === 'failed') {
    await transitionPayment(payment.id, 'failed', {
      failureReason: remote.failureReason ?? 'provider_reported_failure',
      providerPaymentId: remote.id,
    });
    await recordMoneyEvent({
      event: 'payment_failed',
      customerId: payment.customer_id,
      paymentId: payment.id,
      detail: { provider_status: remote.status },
    });
    return {
      success: false,
      status: 'failed',
      reason: 'PAYMENT_FAILED',
      message: "The payment wasn't completed. Your cart is still safe, and you can try again.",
    };
  }

  // 3. Amount and currency, and that the payment belongs to this order.
  const amountMatches = remote.amountMinor === Number(payment.amount_minor);
  const currencyMatches = remote.currency === payment.currency;
  const orderMatches = !remote.orderId || remote.orderId === input.providerOrderId;

  if (!amountMatches || !currencyMatches || !orderMatches) {
    await transitionPayment(payment.id, 'verification_pending', {
      failureReason: 'amount_or_order_mismatch',
      providerPaymentId: remote.id,
    });
    await recordMoneyEvent({
      event: 'payment_verification_failed',
      customerId: payment.customer_id,
      paymentId: payment.id,
      amountMinor: Number(payment.amount_minor),
      detail: {
        stage: 'amount',
        expected_minor: Number(payment.amount_minor),
        observed_minor: remote.amountMinor,
      },
    });
    return {
      success: false,
      status: 'verification_pending',
      reason: 'AMOUNT_MISMATCH',
      message: "I couldn't verify the payment yet, so I haven't marked the order as confirmed.",
    };
  }

  if (remote.status !== 'captured' && remote.status !== 'authorized') {
    await transitionPayment(payment.id, 'verification_pending', {
      providerPaymentId: remote.id,
      failureReason: `provider_status_${remote.status}`,
    });
    return {
      success: false,
      status: 'verification_pending',
      reason: 'NOT_CAPTURED',
      message: 'Your payment is still being verified.',
    };
  }

  await recordMoneyEvent({
    event: 'payment_verified',
    customerId: payment.customer_id,
    conversationId: input.conversationId ?? null,
    paymentId: payment.id,
    amountMinor: Number(payment.amount_minor),
    currency: payment.currency,
  });

  return finalize(payment.id, remote.id, payment.customer_id, input.conversationId ?? null);
}

/**
 * Turn a verified payment into an order, inside one database transaction.
 *
 * If this throws, no order exists, no stock moved and the cart is intact — the
 * payment is left in `verification_pending` for reconciliation rather than
 * being reported as a success we cannot back up.
 */
export async function finalize(
  paymentId: string,
  providerPaymentId: string,
  customerId: string | null,
  conversationId: string | null,
  guestSessionId: string | null = null,
): Promise<VerifyResult> {
  const db = adminClient();

  let contactEmail: string | null = null;
  let contactPhone: string | null = null;
  let contactName: string | null = null;
  let address: Record<string, unknown> | null = null;
  let resolvedCustomerId = customerId;
  let accountCreated = false;

  if (guestSessionId) {
    // Guest checkout. `customers.id` is a foreign key to `auth.users(id)`, so
    // the account has to exist BEFORE the order row can. It is created here,
    // after the payment is verified and immediately before the order — the
    // customer never had to make one to shop, which is the actual requirement.
    const guest = await loadGuestSessionById(guestSessionId);
    if (!guest?.email) {
      await transitionPayment(paymentId, 'verification_pending', {
        failureReason: 'guest_details_missing',
      });
      return {
        success: false,
        status: 'verification_pending',
        reason: 'GUEST_DETAILS_MISSING',
        message:
          "Your payment went through but I couldn't finish the order — I'm missing your delivery details. Our team has been alerted.",
      };
    }

    contactEmail = guest.email;
    contactPhone = guest.phone;
    contactName = guest.fullName;
    address = (guest.address as unknown as Record<string, unknown>) ?? null;

    const account = await ensureAccountForEmail({
      email: guest.email,
      fullName: guest.fullName,
      phone: guest.phone,
    });
    resolvedCustomerId = account.customerId;
    accountCreated = account.created;

    if (!resolvedCustomerId) {
      await transitionPayment(paymentId, 'verification_pending', {
        failureReason: 'account_creation_failed',
      });
      return {
        success: false,
        status: 'verification_pending',
        reason: 'ACCOUNT_CREATION_FAILED',
        message:
          "Your payment went through but I couldn't finish setting up your order. Our team has been alerted — you have not been charged twice.",
      };
    }

    // The payment row now has a real owner, which the order FK requires.
    await db
      .from('payments')
      .update({ customer_id: resolvedCustomerId })
      .eq('id', paymentId);
  } else {
    const { data: customer } = await db
      .from('customers')
      .select('email, phone, full_name')
      .eq('id', customerId!)
      .maybeSingle();
    contactEmail = customer?.email ?? null;
    contactPhone = customer?.phone ?? null;
    contactName = customer?.full_name ?? null;
    address = (await getDefaultAddress(customerId!)) as Record<string, unknown> | null;
  }

  const { data, error } = await db.rpc('finalize_paid_payment', {
    p_payment_id: paymentId,
    p_provider_payment_id: providerPaymentId,
    p_contact_email: contactEmail ?? 'unknown@shopiq.local',
    p_contact_phone: contactPhone ?? null,
    p_shipping_address: address ?? {
      line1: 'Not provided',
      city: 'Not provided',
      state: 'Not provided',
      postalCode: '000000',
      country: 'India',
    },
    p_notes: null,
  });

  if (error) {
    await transitionPayment(paymentId, 'verification_pending', {
      failureReason: `finalize:${error.message.slice(0, 120)}`,
    });
    await recordMoneyEvent({
      event: 'finalization_failed',
      customerId: resolvedCustomerId,
      paymentId,
      detail: { error: error.message.slice(0, 200) },
    });
    return {
      success: false,
      status: 'verification_pending',
      reason: 'FINALIZATION_FAILED',
      message:
        "Your payment went through but I couldn't finish the order. Our team has been alerted — you have not been charged twice.",
    };
  }

  const result = data as {
    orderId: string;
    orderNumber: string;
    total: number | string;
    alreadyFinalized: boolean;
  };

  if (!result.alreadyFinalized) {
    await recordMoneyEvent({
      event: 'order_created',
      customerId: resolvedCustomerId,
      conversationId,
      paymentId,
      orderId: result.orderId,
      detail: { order_number: result.orderNumber, guest: Boolean(guestSessionId), account_created: accountCreated },
    });
    await recordMoneyEvent({
      event: 'inventory_finalized',
      customerId: resolvedCustomerId,
      paymentId,
      orderId: result.orderId,
    });
    await recordMoneyEvent({
      event: 'cart_cleared',
      customerId: resolvedCustomerId,
      paymentId,
      orderId: result.orderId,
    });

    // Link the guest session to what it produced, so it cannot be reused.
    if (guestSessionId && resolvedCustomerId) {
      await consumeGuestSession(guestSessionId, {
        orderId: result.orderId,
        customerId: resolvedCustomerId,
      });
    }

    // The invoice. Deliberately AFTER the order is safely created, and
    // deliberately unable to affect it: a failed email is logged and left
    // retryable in the outbox, never a reason to unwind a paid order.
    if (contactEmail) {
      const { data: lines } = await db
        .from('order_items')
        .select('product_name, quantity, unit_price, total_price')
        .eq('order_id', result.orderId);
      const { data: order } = await db
        .from('orders')
        .select('subtotal, shipping_amount, tax_amount, total, payment_status')
        .eq('id', result.orderId)
        .maybeSingle();

      const invoice = renderInvoiceEmail({
        orderNumber: result.orderNumber,
        lines: (lines ?? []).map((line) => ({
          name: line.product_name,
          quantity: line.quantity,
          unitPrice: Number(line.unit_price),
          total: Number(line.total_price),
        })),
        subtotal: Number(order?.subtotal ?? 0),
        shipping: Number(order?.shipping_amount ?? 0),
        tax: Number(order?.tax_amount ?? 0),
        total: Number(order?.total ?? 0),
        deliveryEstimate: deliveryEstimateText(),
        address,
        paymentStatus: order?.payment_status ?? 'paid',
      });

      const emailResult = await sendEmail({
        kind: 'order_invoice',
        to: contactEmail,
        subject: invoice.subject,
        body: invoice.text,
        html: invoice.html,
        orderId: result.orderId,
        customerId: resolvedCustomerId,
      });

      await recordMoneyEvent({
        event: emailResult.status === 'sent' ? 'invoice_sent' : 'invoice_queued',
        customerId: resolvedCustomerId,
        orderId: result.orderId,
        detail: { status: emailResult.status, provider: emailResult.provider },
      });
    }

    // Attribution runs once, here, on a PAID order — never on a quote, a
    // pending payment or a failed one. Revenue that was never collected must
    // never appear in an AI revenue figure.
    const attributedLines = await attributeOrder(result.orderId);
    await recordCommerceEvent('order_paid', { customerId, conversationId }, {
      channel: 'ai',
      orderId: result.orderId,
      valueMinor: Math.round(Number(result.total) * 100),
      detail: { attributed_lines: attributedLines },
    });
  }

  return {
    success: true,
    status: 'captured',
    message: `Payment successful. Your order ${result.orderNumber} has been confirmed.`,
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    totalMinor: Math.round(Number(result.total) * 100),
    deliveryEstimate: deliveryEstimateText(),
    accountCreated,
    invoiceEmail: contactEmail,
  };
}

/**
 * The delivery estimate.
 *
 * ShopiQ has no carrier integration, so this is configuration rather than a
 * calculation — and it is labelled as such everywhere it surfaces. The AI must
 * never invent a delivery date, so the value comes from here or not at all.
 */
export function deliveryEstimateText(): string {
  const days = Number(process.env.DELIVERY_ESTIMATE_DAYS ?? 2);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Record a payment the customer abandoned or the provider reported failed. */
export async function markPaymentFailed(
  providerOrderId: string,
  reason: string,
  cancelled = false,
): Promise<void> {
  const db = adminClient();
  const { data: payment } = await db
    .from('payments')
    .select('id, customer_id')
    .eq('provider_order_id', providerOrderId)
    .maybeSingle();
  if (!payment) return;

  await transitionPayment(payment.id, cancelled ? 'cancelled' : 'failed', {
    failureReason: reason.slice(0, 200),
  });
  await recordMoneyEvent({
    event: cancelled ? 'payment_cancelled' : 'payment_failed',
    customerId: payment.customer_id,
    paymentId: payment.id,
    detail: { reason: reason.slice(0, 200) },
  });
}

// ----------------------------------------------------------------- webhook

export interface WebhookResult {
  handled: boolean;
  duplicate: boolean;
  detail: string;
}

/**
 * Process a webhook whose signature has ALREADY been verified by the caller.
 *
 * De-duplication happens first, on a unique index — so two copies of the same
 * event racing each other cannot both proceed, which a "select then insert"
 * check would allow.
 */
export async function processWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookResult> {
  const provider = paymentProvider();
  const envelope = provider.parseWebhook(rawBody, headers);

  if (!envelope) {
    await recordMoneyEvent({ event: 'webhook_rejected', detail: { reason: 'unparseable' } });
    return { handled: false, duplicate: false, detail: 'unparseable' };
  }

  const eventId = headers['x-razorpay-event-id'] || envelope.eventId;
  const db = adminClient();

  const { error: dedupeError } = await db.from('webhook_events').insert({
    provider: provider.name,
    event_id: eventId,
    event_type: envelope.eventType,
    payload_hash: createHash('sha256').update(rawBody).digest('hex'),
  });

  if (dedupeError) {
    // 23505 = unique violation: we have already processed this event.
    if (dedupeError.code === '23505') {
      await recordMoneyEvent({
        event: 'webhook_duplicate',
        detail: { event_type: envelope.eventType },
      });
      return { handled: true, duplicate: true, detail: 'already processed' };
    }
    throw dedupeError;
  }

  await recordMoneyEvent({
    event: 'webhook_received',
    detail: { event_type: envelope.eventType, has_payment: Boolean(envelope.paymentId) },
  });

  if (!envelope.orderId) {
    return { handled: false, duplicate: false, detail: 'no order reference' };
  }

  const { data: payment } = await db
    .from('payments')
    .select('id, customer_id, amount_minor, currency, status, order_id')
    .eq('provider_order_id', envelope.orderId)
    .maybeSingle();

  if (!payment) return { handled: false, duplicate: false, detail: 'unknown payment' };

  if (envelope.eventType.startsWith('payment.failed')) {
    await transitionPayment(payment.id, 'failed', {
      failureReason: envelope.failureReason ?? 'webhook_reported_failure',
      providerPaymentId: envelope.paymentId,
    });
    await recordMoneyEvent({
      event: 'payment_failed',
      customerId: payment.customer_id,
      paymentId: payment.id,
      detail: { via: 'webhook' },
    });
    return { handled: true, duplicate: false, detail: 'payment failed' };
  }

  const success =
    envelope.eventType.startsWith('payment.captured') ||
    envelope.eventType.startsWith('payment.authorized') ||
    envelope.eventType.startsWith('order.paid');

  if (!success) return { handled: true, duplicate: false, detail: 'ignored event type' };

  // The webhook is a second, independent path to the same finalization. It
  // must agree on the amount before it can create anything.
  if (envelope.amountMinor != null && envelope.amountMinor !== Number(payment.amount_minor)) {
    await recordMoneyEvent({
      event: 'payment_verification_failed',
      customerId: payment.customer_id,
      paymentId: payment.id,
      detail: { stage: 'webhook_amount', observed_minor: envelope.amountMinor },
    });
    return { handled: false, duplicate: false, detail: 'amount mismatch' };
  }

  if (payment.order_id) return { handled: true, duplicate: true, detail: 'already finalized' };

  await recordMoneyEvent({
    event: 'payment_verified',
    customerId: payment.customer_id,
    paymentId: payment.id,
    amountMinor: Number(payment.amount_minor),
    detail: { via: 'webhook' },
  });

  const result = await finalize(
    payment.id,
    envelope.paymentId ?? '',
    payment.customer_id,
    null,
  );

  return {
    handled: result.success,
    duplicate: false,
    detail: result.success ? `order ${result.orderNumber}` : result.reason ?? 'finalize failed',
  };
}

/** Cancel any live confirmation for a customer — used when they back out. */
export async function cancelActiveConfirmation(
  customerId: string,
  confirmationId: string,
): Promise<void> {
  await closeConfirmation(confirmationId, 'cancelled', { customerId });
}
