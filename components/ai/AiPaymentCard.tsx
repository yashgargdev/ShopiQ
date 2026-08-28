'use client';

import Link from 'next/link';
import { AlertIcon, CheckIcon, SparkIcon } from '@/components/ui/icons';
import type { AgentPurchasePayload } from '@/lib/ai/types';

/**
 * The Phase 4 payment cards.
 *
 * The design rule that matters here: the amount the customer is approving is
 * the largest, plainest thing on the card. It is never folded into a sentence,
 * never abbreviated, and never rendered from anything the client computed —
 * every figure below arrives from the server in minor units and is formatted,
 * not calculated.
 */

const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ');

/** Paise → "₹80,898". Formatting only; the arithmetic already happened. */
function rupees(minor: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

export type PaymentPhase =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'processing'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'verification_pending';

/* ------------------------------------------------------- purchase approval */

/**
 * The confirmation card. This is the last thing a customer sees before a
 * charge, so it states the total, the line items and the expiry without
 * embellishment.
 */
export function AiPurchaseCard({
  purchase,
  phase,
  onApprove,
  onDecline,
}: {
  purchase: AgentPurchasePayload;
  phase: PaymentPhase;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const busy = phase === 'preparing' || phase === 'processing' || phase === 'verifying';
  const settled = phase === 'succeeded' || phase === 'cancelled';

  return (
    <div className="ml-9 mt-3 overflow-hidden rounded-[13px] border border-[rgba(247,147,30,.32)] bg-[#0A0A0C]">
      <div className="flex items-center gap-2 border-b border-white/6 px-3.5 py-2.5">
        <SparkIcon size={12} className="text-[#F7931E]" />
        <span className="text-[12px] font-medium text-[#EDEDF0]">ShopiQ Checkout</span>
        <span className="ml-auto font-mono text-[11px] text-[#6E6E76]">
          {purchase.items.length} {purchase.items.length === 1 ? 'item' : 'items'}
        </span>
      </div>

      <div className="divide-y divide-white/5 px-3.5">
        {purchase.items.map((item) => (
          <div key={item.productId} className="flex items-baseline gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-[12.5px] text-[#EDEDF0]">{item.name}</p>
              <p className="m-0 mt-0.5 font-mono text-[11px] text-[#6E6E76]">
                {rupees(item.unitPriceMinor)} × {item.quantity}
              </p>
            </div>
            <span className="shrink-0 font-mono text-[12.5px] text-[#C6C6CC]">
              {rupees(item.lineTotalMinor)}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-white/6 px-3.5 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] text-[#8A8A93]">Subtotal</span>
          <span className="font-mono text-[11.5px] text-[#C6C6CC]">
            {rupees(purchase.subtotalMinor)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] text-[#8A8A93]">Delivery</span>
          <span
            className={cx(
              'font-mono text-[11.5px]',
              purchase.shippingMinor === 0 ? 'text-[#4ADE80]' : 'text-[#C6C6CC]',
            )}
          >
            {purchase.shippingMinor === 0 ? 'Free' : rupees(purchase.shippingMinor)}
          </span>
        </div>
      </div>

      {/* The number the customer is agreeing to. Deliberately the loudest
          element on the card. */}
      <div className="flex items-center justify-between border-t border-white/8 bg-[rgba(247,147,30,.04)] px-3.5 py-3">
        <span className="text-[13px] font-semibold text-[#EDEDF0]">Total</span>
        <span className="font-mono text-[19px] font-semibold tracking-tight text-white">
          {rupees(purchase.amountMinor)}
        </span>
      </div>

      {!settled ? (
        <div className="border-t border-white/6 px-3.5 py-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-[8px] brand-gradient px-3.5 text-[12px] font-semibold text-[#1A0D02] transition-[filter] hover:brightness-107 disabled:opacity-55"
            >
              {phase === 'preparing' ? 'Preparing…' : `Proceed to Payment`}
            </button>
            <button
              type="button"
              onClick={onDecline}
              disabled={busy}
              className="inline-flex h-8 items-center rounded-[8px] border border-white/12 px-3 text-[12px] font-medium text-[#C6C6CC] transition-colors hover:border-white/28 hover:text-white disabled:opacity-55"
            >
              Not now
            </button>
          </div>
          <p className="m-0 mt-2.5 text-[10.5px] leading-relaxed text-[#4E4E56]">
            Payment is handled by Razorpay. ShopiQ never sees your card, UPI PIN or OTP, and
            nothing is charged until you complete it there.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- payment status */

const PHASE_COPY: Record<
  PaymentPhase,
  { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' } | null
> = {
  idle: null,
  preparing: { label: 'Preparing payment', tone: 'neutral' },
  ready: { label: 'Payment ready', tone: 'neutral' },
  processing: { label: 'Payment processing', tone: 'neutral' },
  verifying: { label: 'Verifying payment', tone: 'neutral' },
  succeeded: { label: 'Payment successful', tone: 'ok' },
  failed: { label: 'Payment unsuccessful', tone: 'bad' },
  cancelled: { label: 'Payment cancelled', tone: 'neutral' },
  verification_pending: { label: 'Payment verification pending', tone: 'warn' },
};

const TONE: Record<'neutral' | 'ok' | 'warn' | 'bad', string> = {
  neutral: 'border-white/10 text-[#C6C6CC]',
  ok: 'border-[rgba(74,222,128,.3)] text-[#4ADE80]',
  warn: 'border-[rgba(247,147,30,.35)] text-[#FFB65C]',
  bad: 'border-[rgba(255,107,107,.3)] text-[#FF8B8B]',
};

export function AiPaymentStatus({ phase }: { phase: PaymentPhase }) {
  const copy = PHASE_COPY[phase];
  if (!copy) return null;

  return (
    <div
      className={cx(
        'ml-9 mt-2 inline-flex items-center gap-2 rounded-[9px] border px-2.5 py-1.5 text-[11.5px]',
        TONE[copy.tone],
      )}
    >
      {copy.tone === 'ok' ? (
        <CheckIcon size={11} />
      ) : copy.tone === 'bad' || copy.tone === 'warn' ? (
        <AlertIcon size={11} />
      ) : (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {copy.label}
    </div>
  );
}

/* ---------------------------------------------------------------- success */

export function AiOrderConfirmedCard({
  orderId,
  orderNumber,
  totalDisplay,
  items,
}: {
  orderId: string;
  orderNumber: string;
  totalDisplay: string;
  items?: Array<{ name: string; quantity: number }>;
}) {
  return (
    <div className="ml-9 mt-3 overflow-hidden rounded-[13px] border border-[rgba(74,222,128,.28)] bg-[#0A0A0C]">
      <div className="flex items-center gap-2 border-b border-white/6 px-3.5 py-2.5">
        <CheckIcon size={12} className="text-[#4ADE80]" />
        <span className="text-[12px] font-medium text-[#EDEDF0]">Order confirmed</span>
      </div>

      <div className="px-3.5 py-3">
        <p className="m-0 font-mono text-[13px] text-white">{orderNumber}</p>
        <div className="mt-2.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] text-[#8A8A93]">Payment</span>
            <span className="text-[11.5px] font-medium text-[#4ADE80]">Paid</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] text-[#8A8A93]">Total</span>
            <span className="font-mono text-[13px] font-semibold text-white">{totalDisplay}</span>
          </div>
        </div>

        {items && items.length > 0 ? (
          <ul className="m-0 mt-2.5 list-none space-y-1 p-0">
            {items.map((item) => (
              <li key={item.name} className="truncate text-[11.5px] text-[#8A8A93]">
                {item.name} × {item.quantity}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="border-t border-white/6 px-3.5 py-2.5">
        <Link
          href={`/orders/${orderId}`}
          className="inline-flex h-8 items-center rounded-[8px] border border-white/12 px-3.5 text-[12px] font-medium text-[#EDEDF0] transition-colors hover:border-white/28"
        >
          View Order
        </Link>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- failure */

export function AiPaymentFailedCard({
  message,
  onRetry,
  verificationPending = false,
}: {
  message: string;
  onRetry: () => void;
  verificationPending?: boolean;
}) {
  return (
    <div
      className={cx(
        'ml-9 mt-3 overflow-hidden rounded-[13px] border bg-[#0A0A0C]',
        verificationPending ? 'border-[rgba(247,147,30,.35)]' : 'border-[rgba(255,107,107,.3)]',
      )}
    >
      <div className="flex items-center gap-2 border-b border-white/6 px-3.5 py-2.5">
        <AlertIcon size={12} className={verificationPending ? 'text-[#FFB65C]' : 'text-[#FF8B8B]'} />
        <span className="text-[12px] font-medium text-[#EDEDF0]">
          {verificationPending ? 'Payment verification pending' : 'Payment unsuccessful'}
        </span>
      </div>

      <div className="px-3.5 py-3">
        <p className="m-0 text-[12px] leading-relaxed text-[#C6C6CC]">{message}</p>
        {/* Said plainly, because it is the thing the customer most wants to know. */}
        <p className="m-0 mt-2 text-[11.5px] text-[#8A8A93]">Your cart has not been cleared.</p>
      </div>

      {!verificationPending ? (
        <div className="border-t border-white/6 px-3.5 py-2.5">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-8 items-center rounded-[8px] border border-white/12 px-3.5 text-[12px] font-medium text-[#EDEDF0] transition-colors hover:border-white/28"
          >
            Try Again
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ price change */

export function AiTotalChangedCard({
  oldTotalDisplay,
  newTotalDisplay,
  reason,
  onReview,
}: {
  oldTotalDisplay: string;
  newTotalDisplay: string;
  reason: string;
  onReview: () => void;
}) {
  return (
    <div className="ml-9 mt-3 overflow-hidden rounded-[13px] border border-[rgba(247,147,30,.35)] bg-[#0A0A0C]">
      <div className="flex items-center gap-2 border-b border-white/6 px-3.5 py-2.5">
        <AlertIcon size={12} className="text-[#FFB65C]" />
        <span className="text-[12px] font-medium text-[#EDEDF0]">Your cart has changed</span>
      </div>

      <div className="px-3.5 py-3">
        <div className="flex items-center gap-3">
          <div>
            <p className="m-0 text-[10.5px] uppercase tracking-wide text-[#6E6E76]">Old total</p>
            <p className="m-0 font-mono text-[13px] text-[#8A8A93] line-through">
              {oldTotalDisplay}
            </p>
          </div>
          <div>
            <p className="m-0 text-[10.5px] uppercase tracking-wide text-[#6E6E76]">New total</p>
            <p className="m-0 font-mono text-[15px] font-semibold text-white">{newTotalDisplay}</p>
          </div>
        </div>
        <p className="m-0 mt-2.5 text-[11.5px] leading-snug text-[#C6C6CC]">{reason}</p>
      </div>

      <div className="border-t border-white/6 px-3.5 py-2.5">
        <button
          type="button"
          onClick={onReview}
          className="inline-flex h-8 items-center rounded-[8px] brand-gradient px-3.5 text-[12px] font-semibold text-[#1A0D02] transition-[filter] hover:brightness-107"
        >
          Review &amp; Confirm
        </button>
        {/* A new amount always needs a new yes. */}
        <p className="m-0 mt-2 text-[10.5px] text-[#4E4E56]">
          The previous confirmation is no longer valid.
        </p>
      </div>
    </div>
  );
}
