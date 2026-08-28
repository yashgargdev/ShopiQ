'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import { useCart } from '@/components/cart/CartProvider';
import { CloseIcon, MinusIcon, PlusIcon, SparkIcon } from '@/components/ui/icons';
import {
  EmptyState,
  InlineAlert,
  LinkButton,
  StockPill,
} from '@/components/ui/primitives';
import { CartIcon } from '@/components/ui/icons';
import { cx, formatPrice } from '@/lib/format';
import type { Cart, CartLine } from '@/types';

/**
 * The cart screen from the design: line items on the left, a sticky order
 * summary on the right. Prices come from the server on every mutation, so what
 * is shown is always what will be charged.
 */
export function CartView({ initialCart }: { initialCart: Cart }) {
  const { cart: liveCart } = useCart();
  const cart = liveCart ?? initialCart;

  if (cart.items.length === 0) {
    return (
      <EmptyState
        icon={<CartIcon size={18} />}
        title="Your cart is empty"
        description="Browse the catalogue and add something you like — your cart is saved even before you sign in."
        action={
          <LinkButton href="/products" variant="primary">
            Explore Products
          </LinkButton>
        }
      />
    );
  }

  const blocked = cart.items.some((item) => item.exceedsStock);

  return (
    <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_360px]">
      <div>
        {cart.issues.length > 0 ? (
          <div className="mb-4 flex flex-col gap-2">
            {cart.issues.map((issue) => (
              <InlineAlert key={issue} tone="warn">
                {issue}
              </InlineAlert>
            ))}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-[18px] border border-white/8">
          {cart.items.map((item) => (
            <CartRow key={item.id} item={item} />
          ))}

          <div className="flex flex-wrap items-center gap-2.5 px-5 py-4 text-[13.5px] text-[#9A9AA2]">
            <SparkIcon size={14} className="shrink-0 text-[#F7931E]" />
            ShopiQ&apos;s assistant will suggest matching accessories here in the next phase.
          </div>
        </div>
      </div>

      <aside className="sticky top-[100px] rounded-[18px] border border-white/8 bg-[#08080A] p-6">
        <div className="mb-5 text-[16px] font-semibold">Order summary</div>

        <div className="flex flex-col gap-3.5 text-[14.5px] text-[#9A9AA2]">
          <Row label={`Subtotal (${cart.totals.itemCount} items)`}>
            <span className="text-white">{formatPrice(cart.totals.subtotal)}</span>
          </Row>
          <Row label="Delivery">
            {cart.totals.shipping === 0 ? (
              <span className="text-[#4ED17E]">Free</span>
            ) : (
              <span className="text-white">{formatPrice(cart.totals.shipping)}</span>
            )}
          </Row>
          {cart.totals.savings > 0 ? (
            <Row label="Savings">
              <span className="text-[#FFB65C]">−{formatPrice(cart.totals.savings)}</span>
            </Row>
          ) : null}
        </div>

        <div className="my-5 h-px bg-white/8" />

        <div className="flex items-baseline justify-between">
          <span className="text-[15px] font-medium">Total</span>
          <span className="text-[24px] font-semibold">{formatPrice(cart.totals.total)}</span>
        </div>

        {blocked ? (
          <div className="mt-5">
            <InlineAlert tone="error">
              Adjust the quantities flagged above before checking out.
            </InlineAlert>
          </div>
        ) : null}

        <LinkButton
          href="/checkout"
          variant="primary"
          size="lg"
          fullWidth
          className={cx('mt-5.5', blocked && 'pointer-events-none opacity-50')}
          aria-disabled={blocked}
        >
          Proceed to Checkout
        </LinkButton>

        <p className="mb-0 mt-4 text-center text-[12.5px] leading-relaxed text-[#6E6E76]">
          Phase 1 places a test order. Payment lands in a later phase.
        </p>
      </aside>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      {children}
    </div>
  );
}

function CartRow({ item }: { item: CartLine }) {
  const { updateItem, removeItem, pending } = useCart();
  const [busy, setBusy] = useState(false);

  const max = Math.min(item.availability.available, 20);

  const change = async (next: number) => {
    if (next === item.quantity) return;
    setBusy(true);
    await updateItem(item.id, next);
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    await removeItem(item.id);
    setBusy(false);
  };

  return (
    <div
      className={cx(
        'flex flex-wrap items-center gap-4 border-b border-white/6 p-5 last:border-b-0 sm:flex-nowrap sm:gap-4.5',
        busy && 'opacity-60',
      )}
    >
      <Link
        href={`/products/${item.slug}`}
        className="relative h-[70px] w-[70px] shrink-0 overflow-hidden rounded-[12px] bg-[#121216] sm:h-[88px] sm:w-[88px]"
      >
        {item.image ? (
          <Image src={item.image} alt={item.name} fill sizes="88px" className="object-cover" />
        ) : null}
      </Link>

      <div className="min-w-0 flex-1">
        <div className="font-mono text-[11px] uppercase leading-none tracking-[0.1em] text-[#7E7E88]">
          {item.brand}
        </div>
        <Link
          href={`/products/${item.slug}`}
          className="mt-2 block text-[15.5px] font-medium leading-[1.3] text-white hover:text-[#FFC07A]"
        >
          {item.name}
        </Link>
        <StockPill
          available={item.availability.available}
          inStock={item.availability.inStock}
          lowStock={item.availability.lowStock}
          className="mt-2 text-[13px]"
        />
      </div>

      <div className="flex items-center overflow-hidden rounded-[9px] border border-white/12">
        <button
          type="button"
          onClick={() => change(item.quantity - 1)}
          disabled={pending || busy}
          aria-label={`Decrease quantity of ${item.name}`}
          className="grid h-[34px] w-8 place-items-center text-[#C6C6CC] transition-colors hover:text-white disabled:text-[#3A3A42]"
        >
          <MinusIcon size={13} />
        </button>
        <span className="w-8 text-center text-[14px] font-medium tabular-nums">
          {item.quantity}
        </span>
        <button
          type="button"
          onClick={() => change(item.quantity + 1)}
          disabled={pending || busy || item.quantity >= max}
          aria-label={`Increase quantity of ${item.name}`}
          className="grid h-[34px] w-8 place-items-center text-[#C6C6CC] transition-colors hover:text-white disabled:text-[#3A3A42]"
        >
          <PlusIcon size={13} />
        </button>
      </div>

      <div className="w-[100px] shrink-0 text-right">
        <div className="text-[16px] font-semibold">{formatPrice(item.lineTotal)}</div>
        {item.quantity > 1 ? (
          <div className="mt-1 text-[12px] text-[#6E6E76]">
            {formatPrice(item.unitPrice)} each
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={remove}
        disabled={pending || busy}
        aria-label={`Remove ${item.name} from cart`}
        className="grid h-[34px] w-[34px] shrink-0 place-items-center text-[#6E6E76] transition-colors hover:text-[#FF6B6B]"
      >
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
