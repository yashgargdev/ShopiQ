import 'server-only';

import { getSessionUser } from '@/lib/auth';
import { unauthorized } from '@/lib/api/response';
import { createPayment } from '@/lib/payments/service';
import { getOrderStatus, getPaymentStatus } from '@/lib/payments/status';
import { formatMinorUnits } from '@/lib/payments/money';
import {
  loadLiveConfirmation,
  isConfirmationExpired,
} from '@/lib/checkout/confirmation';

import type {
  CreatePaymentInput,
  GetOrderStatusInput,
  GetPaymentStatusInput,
} from './schemas';

/**
 * The Level 4 money tools.
 *
 * `create_payment` is the only tool in ShopiQ that can start a charge, and it
 * is deliberately the least powerful-looking function in the codebase: it
 * takes no amount, no customer, no cart and no price. Everything it needs it
 * derives, and every condition it must satisfy is checked in
 * `lib/payments/authorize.ts` — which the model cannot reach, influence or
 * argue with.
 *
 * What the model CAN do is ask at the wrong moment. That is why the failure
 * path returns a structured `reason`: the assistant should explain what is
 * missing (a confirmation, a fresh total) rather than retrying blindly.
 */

async function currentCustomerId(): Promise<string> {
  const user = await getSessionUser();
  if (!user) throw unauthorized('You need to be signed in for that.');
  return user.id;
}

// ------------------------------------------------------------ create_payment

export interface CreatePaymentToolOutput {
  success: boolean;
  reason?: string;
  message: string;
  payment_provider?: string;
  provider_order_id?: string;
  amount?: number;
  amount_display?: string;
  currency?: string;
  /** Set when the total moved, so the assistant can quote both figures. */
  old_total_display?: string;
  new_total_display?: string;
  /** The UI opens the provider checkout; the assistant never collects card data. */
  opens_provider_checkout?: boolean;
}

export async function createPaymentTool(
  _input: CreatePaymentInput,
  context?: { conversationId?: string | null },
): Promise<CreatePaymentToolOutput> {
  await currentCustomerId();

  const result = await createPayment({
    conversationId: context?.conversationId ?? null,
  });

  if (!result.success) {
    return {
      success: false,
      reason: result.reason,
      message: result.message,
      old_total_display: result.oldTotalMinor
        ? formatMinorUnits(result.oldTotalMinor)
        : undefined,
      new_total_display: result.newTotalMinor
        ? formatMinorUnits(result.newTotalMinor)
        : undefined,
    };
  }

  return {
    success: true,
    message:
      "I've prepared your secure payment. Razorpay checkout is ready — you complete the payment there.",
    payment_provider: result.provider,
    provider_order_id: result.providerOrderId,
    amount: result.amountMinor,
    amount_display: formatMinorUnits(result.amountMinor),
    currency: result.currency,
    opens_provider_checkout: true,
  };
}

// -------------------------------------------------------- get_payment_status

export async function getPaymentStatusTool(input: GetPaymentStatusInput) {
  const customerId = await currentCustomerId();
  const view = await getPaymentStatus(customerId, input.payment_id ?? null);

  if (!view) {
    return {
      found: false,
      message: 'I cannot find a payment on your account yet.',
    };
  }

  return {
    found: true,
    payment_id: view.payment_id,
    status: view.status,
    // `settled` exists so the assistant never has to interpret the raw status.
    // verification_pending is NOT success, and this flag says so plainly.
    settled: view.settled,
    statement: view.statement,
    amount_display: view.amount_display,
    currency: view.currency,
    order_number: view.order_number,
    failure_reason: view.failure_reason,
  };
}

// ---------------------------------------------------------- get_order_status

export async function getOrderStatusTool(input: GetOrderStatusInput) {
  const customerId = await currentCustomerId();
  const view = await getOrderStatus(customerId, input.order_id ?? null);

  if (!view) {
    return {
      found: false,
      message: 'I cannot find an order on your account yet.',
    };
  }

  return {
    found: true,
    order_id: view.order_id,
    order_number: view.order_number,
    status: view.status,
    payment_status: view.payment_status,
    confirmed: view.confirmed,
    total_display: view.total_display,
    currency: view.currency,
    placed_at: view.placed_at,
    items: view.items,
  };
}

// ------------------------------------------------- confirmation inspection

/**
 * Lets the assistant see whether a live confirmation exists before it offers
 * to pay — so it can say "your confirmation expired, shall I re-quote?"
 * instead of calling create_payment and getting refused.
 */
export async function getCheckoutConfirmationTool() {
  const customerId = await currentCustomerId();
  const confirmation = await loadLiveConfirmation(customerId);

  if (!confirmation) {
    return { exists: false, message: 'There is no checkout confirmation open right now.' };
  }

  const expired = isConfirmationExpired(confirmation);
  return {
    exists: true,
    status: expired ? 'expired' : confirmation.status,
    expired,
    confirmed: confirmation.status === 'confirmed' && !expired,
    amount_display: formatMinorUnits(confirmation.amountMinor),
    expires_at: confirmation.expiresAt,
    item_count: confirmation.snapshot.items.length,
  };
}
