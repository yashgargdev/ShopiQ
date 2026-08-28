'use client';

import Image from 'next/image';
import Link from 'next/link';

import { AlertIcon, CartIcon, CheckIcon, SparkIcon } from '@/components/ui/icons';
import { cx, formatPrice } from '@/lib/format';
import type { AgentCartPayload, AgentCheckoutPayload } from '@/lib/ai/types';

/**
 * The cart and checkout cards inside the AI panel.
 *
 * Every figure rendered here comes straight from the API payload, which the
 * server computed from the live catalogue. Nothing on this page adds up a
 * total, applies a discount, or decides what delivery costs.
 *
 * Styling follows the Phase 1 design: pitch black ground, hairline borders,
 * the one orange gradient, Geist Mono for money.
 */

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'ok' | 'warn';
}) {
  return (
    <div className="flex justify-between gap-3 text-[12.5px]">
      <span className="text-[#7E7E88]">{label}</span>
      <span
        className={cx(
          'font-mono',
          accent === 'ok' ? 'text-[#4ED17E]' : accent === 'warn' ? 'text-[#FFB65C]' : 'text-[#EDEDF0]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function LineItem({
  name,
  quantity,
  unitPrice,
  lineTotal,
  image,
  available,
  priceChanged,
}: {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  image: string | null;
  available: boolean;
  priceChanged?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 py-2">
      <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-[8px] bg-[#141418]">
        {image ? (
          <Image src={image} alt="" fill sizes="36px" className="object-cover" />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] leading-tight text-[#EDEDF0]">{name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-[#7E7E88]">
          {formatPrice(unitPrice)} × {quantity}
          {!available ? <span className="text-[#FF8B8B]">· out of stock</span> : null}
          {priceChanged ? <span className="text-[#FFB65C]">· price changed</span> : null}
        </div>
      </div>

      <div className="shrink-0 font-mono text-[12.5px] text-[#EDEDF0]">
        {formatPrice(lineTotal)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- cart */

export function AiCartCard({ cart }: { cart: AgentCartPayload }) {
  if (cart.items.length === 0) {
    return (
      <div className="ml-9 mt-3 flex items-center gap-2.5 rounded-[13px] border border-white/8 bg-[#0C0C0E] px-3.5 py-3 text-[12.5px] text-[#7E7E88]">
        <CartIcon size={14} />
        Your cart is empty.
      </div>
    );
  }

  return (
    <div className="ml-9 mt-3 overflow-hidden rounded-[13px] border border-white/8 bg-[#0A0A0C]">
      <div className="flex items-center gap-2 border-b border-white/6 px-3.5 py-2.5">
        <SparkIcon size={12} className="text-[#F7931E]" />
        <span className="text-[12px] font-medium text-[#EDEDF0]">Your ShopiQ cart</span>
        <span className="ml-auto font-mono text-[11px] text-[#6E6E76]">
          {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}
        </span>
      </div>

      <div className="divide-y divide-white/5 px-3.5">
        {cart.items.map((item) => (
          <LineItem
            key={item.cartItemId}
            name={item.name}
            quantity={item.quantity}
            unitPrice={item.unitPrice}
            lineTotal={item.lineTotal}
            image={item.image}
            available={item.available}
            priceChanged={item.priceChanged}
          />
        ))}
      </div>

      {cart.issues.length > 0 ? (
        <div className="border-t border-white/6 px-3.5 py-2">
          {cart.issues.slice(0, 2).map((issue) => (
            <div
              key={issue}
              className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[#FFB65C]"
            >
              <AlertIcon size={12} className="mt-0.5 shrink-0" />
              {issue}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 border-t border-white/6 px-3.5 py-2.5">
        <Row label="Subtotal" value={formatPrice(cart.subtotal)} />
        {cart.savings > 0 ? (
          <Row label="Savings" value={`−${formatPrice(cart.savings)}`} accent="warn" />
        ) : null}
        <Row
          label="Delivery"
          value={cart.shipping === 0 ? 'Free' : formatPrice(cart.shipping)}
          accent={cart.shipping === 0 ? 'ok' : undefined}
        />
      </div>

      <div className="flex items-center justify-between border-t border-white/8 px-3.5 py-2.5">
        <span className="text-[12.5px] font-medium text-[#EDEDF0]">Total</span>
        <span className="font-mono text-[15px] font-semibold text-white">
          {formatPrice(cart.total)}
        </span>
      </div>

      <div className="border-t border-white/6 px-3.5 py-2.5">
        <Link
          href="/cart"
          className="inline-flex h-7 items-center rounded-[8px] border border-white/12 px-3 text-[11.5px] font-medium text-[#E6E6EA] transition-colors hover:border-white/28 hover:text-white"
        >
          View cart
        </Link>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- checkout */

export function AiCheckoutCard({ checkout }: { checkout: AgentCheckoutPayload }) {
  return (
    <div
      className={cx(
        'ml-9 mt-3 overflow-hidden rounded-[13px] border bg-[#0A0A0C]',
        checkout.valid ? 'border-[rgba(247,147,30,.32)]' : 'border-[rgba(255,107,107,.3)]',
      )}
    >
      <div className="flex items-center gap-2 border-b border-white/6 px-3.5 py-2.5">
        <SparkIcon size={12} className="text-[#F7931E]" />
        <span className="text-[12px] font-medium text-[#EDEDF0]">Checkout summary</span>
        <span className="ml-auto font-mono text-[11px] text-[#6E6E76]">
          {checkout.itemCount} {checkout.itemCount === 1 ? 'item' : 'items'}
        </span>
      </div>

      {checkout.changes.length > 0 ? (
        <div className="border-b border-white/6 bg-[rgba(247,147,30,.05)] px-3.5 py-2">
          {checkout.changes.map((change) => (
            <div
              key={change.message}
              className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[#FFB65C]"
            >
              <AlertIcon size={12} className="mt-0.5 shrink-0" />
              {change.message}
            </div>
          ))}
        </div>
      ) : null}

      <div className="divide-y divide-white/5 px-3.5">
        {checkout.items.map((item) => (
          <LineItem
            key={item.cartItemId}
            name={item.name}
            quantity={item.quantity}
            unitPrice={item.unitPrice}
            lineTotal={item.lineTotal}
            image={item.image}
            available={item.available}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-white/6 px-3.5 py-2.5">
        <Row label="Subtotal" value={formatPrice(checkout.subtotal)} />
        <Row
          label="Delivery"
          value={checkout.shipping === 0 ? 'Free' : formatPrice(checkout.shipping)}
          accent={checkout.shipping === 0 ? 'ok' : undefined}
        />
      </div>

      <div className="flex items-center justify-between border-t border-white/8 px-3.5 py-2.5">
        <span className="text-[12.5px] font-medium text-[#EDEDF0]">Total</span>
        <span className="font-mono text-[15px] font-semibold text-white">
          {formatPrice(checkout.total)}
        </span>
      </div>

      <div className="border-t border-white/6 px-3.5 py-2.5">
        {checkout.valid ? (
          <>
            <Link
              href={checkout.checkoutUrl}
              className="inline-flex h-8 items-center rounded-[8px] brand-gradient px-3.5 text-[12px] font-semibold text-[#1A0D02] transition-[filter] hover:brightness-107"
            >
              Continue to checkout
            </Link>
            {/* Phase 3 stops here on purpose — payment is a later phase. */}
            <p className="m-0 mt-2 text-[10.5px] leading-relaxed text-[#4E4E56]">
              ShopiQ has not placed an order or taken any payment — you review and confirm on the
              checkout page.
            </p>
          </>
        ) : (
          <div className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[#FF8B8B]">
            <AlertIcon size={12} className="mt-0.5 shrink-0" />
            Sort the issue above and I can take you to checkout.
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- confirmation */

export function AiConfirmCard({
  summary,
  onConfirm,
  onCancel,
  disabled,
}: {
  summary: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="ml-9 mt-3 rounded-[13px] border border-[rgba(255,107,107,.3)] bg-[rgba(255,107,107,.05)] p-3.5">
      <div className="flex items-start gap-2 text-[12.5px] leading-snug text-[#FF8B8B]">
        <AlertIcon size={13} className="mt-0.5 shrink-0" />
        <span>{summary}</span>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={disabled}
          className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-[rgba(255,107,107,.4)] bg-[rgba(255,107,107,.1)] px-3 text-[11.5px] font-medium text-[#FF8B8B] transition-colors hover:bg-[rgba(255,107,107,.18)] disabled:opacity-50"
        >
          <CheckIcon size={11} />
          Yes, do it
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="inline-flex h-7 items-center rounded-[8px] border border-white/12 px-3 text-[11.5px] font-medium text-[#C6C6CC] transition-colors hover:border-white/28 hover:text-white disabled:opacity-50"
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
