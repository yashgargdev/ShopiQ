import 'server-only';
import { adminClient } from '@/lib/supabase/admin';

/**
 * The money-action audit trail.
 *
 * Every step of the checkout chain records one row. The point is that after
 * the fact you can answer "what did the system believe, and when" without
 * reconstructing it from application logs — which is the question that
 * actually gets asked when a charge is disputed.
 *
 * Writes go through the service role and the table has RLS with no policy, so
 * a customer can neither read nor alter their own audit trail.
 */

export type MoneyEvent =
  | 'checkout_prepared'
  | 'price_validated'
  | 'inventory_validated'
  | 'confirmation_requested'
  | 'confirmation_granted'
  | 'confirmation_expired'
  | 'confirmation_invalidated'
  | 'confirmation_cancelled'
  | 'confirmation_consumed'
  | 'provider_order_created'
  | 'payment_initiated'
  | 'payment_callback_received'
  | 'payment_verified'
  | 'payment_verification_failed'
  | 'payment_failed'
  | 'payment_cancelled'
  | 'webhook_received'
  | 'webhook_duplicate'
  | 'webhook_rejected'
  | 'order_created'
  | 'inventory_finalized'
  | 'cart_cleared'
  | 'invoice_sent'
  | 'invoice_queued'
  | 'account_created'
  | 'order_cancelled'
  | 'return_requested'
  | 'replacement_requested'
  | 'profile_updated'
  | 'finalization_failed';

export interface MoneyEventInput {
  event: MoneyEvent;
  customerId?: string | null;
  conversationId?: string | null;
  confirmationId?: string | null;
  paymentId?: string | null;
  orderId?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Keys that must never reach the audit table. Signatures are included
 * deliberately: a stored signature plus a stored body is a verification oracle.
 */
const FORBIDDEN = /pass|secret|token|signature|key_secret|card|cvv|upi|otp|pin|auth/i;

function scrub(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (FORBIDDEN.test(key)) {
      clean[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string' && value.length > 300) {
      clean[key] = `${value.slice(0, 300)}…`;
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * Record a money action. Never throws: an audit write failing must not take
 * down a payment that has otherwise succeeded, but it must be visible.
 */
export async function recordMoneyEvent(input: MoneyEventInput): Promise<void> {
  try {
    const { error } = await adminClient()
      .from('payment_events')
      .insert({
        event: input.event,
        customer_id: input.customerId ?? null,
        conversation_id: input.conversationId ?? null,
        confirmation_id: input.confirmationId ?? null,
        payment_id: input.paymentId ?? null,
        order_id: input.orderId ?? null,
        amount_minor: input.amountMinor ?? null,
        currency: input.currency ?? null,
        detail: scrub(input.detail),
      });
    if (error) console.error(`[audit] ${input.event} failed to record: ${error.message}`);
  } catch (error) {
    console.error(`[audit] ${input.event} failed to record`, error);
  }
}

/** The audit trail for one customer, newest first. Server-side only. */
export async function listMoneyEvents(customerId: string, limit = 50) {
  const { data, error } = await adminClient()
    .from('payment_events')
    .select('event, amount_minor, currency, detail, created_at, payment_id, order_id')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
