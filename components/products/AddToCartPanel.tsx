'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useCart } from '@/components/cart/CartProvider';
import { CheckIcon, HeartIcon, MinusIcon, PlusIcon } from '@/components/ui/icons';
import { Button, InlineAlert } from '@/components/ui/primitives';
import { cx } from '@/lib/format';
import type { Availability } from '@/types';

/**
 * Quantity stepper plus Add to Cart / Buy Now. The stepper is capped at what
 * is actually available; the server re-checks anyway on both add and checkout.
 */
export function AddToCartPanel({
  productId,
  availability,
}: {
  productId: string;
  availability: Availability;
}) {
  const router = useRouter();
  const { addItem, pending, error, clearError } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const [wishlisted, setWishlisted] = useState(false);
  const [buying, setBuying] = useState(false);

  const max = Math.min(availability.available, 20);
  const disabled = !availability.inStock || pending;

  const step = (delta: number) => {
    clearError();
    setAdded(false);
    setQuantity((value) => Math.min(Math.max(value + delta, 1), Math.max(max, 1)));
  };

  const onAdd = async () => {
    const ok = await addItem(productId, quantity);
    if (ok) {
      setAdded(true);
      setTimeout(() => setAdded(false), 2200);
    }
  };

  const onBuyNow = async () => {
    setBuying(true);
    const ok = await addItem(productId, quantity);
    if (ok) router.push('/checkout');
    else setBuying(false);
  };

  if (!availability.inStock) {
    return (
      <div className="mt-7">
        <InlineAlert tone="error">
          This product is currently out of stock. Check back soon — stock levels update in real
          time.
        </InlineAlert>
      </div>
    );
  }

  return (
    <div className="mt-7">
      {error ? (
        <div className="mb-3.5">
          <InlineAlert tone="error">{error}</InlineAlert>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-[52px] items-center overflow-hidden rounded-[12px] border border-white/14">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={quantity <= 1}
            aria-label="Decrease quantity"
            className="grid h-full w-11 place-items-center text-[#C6C6CC] transition-colors hover:text-white disabled:text-[#3A3A42]"
          >
            <MinusIcon size={15} />
          </button>
          <span
            aria-live="polite"
            className="w-10 text-center text-[15px] font-medium tabular-nums"
          >
            {quantity}
          </span>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={quantity >= max}
            aria-label="Increase quantity"
            className="grid h-full w-11 place-items-center text-[#C6C6CC] transition-colors hover:text-white disabled:text-[#3A3A42]"
          >
            <PlusIcon size={15} />
          </button>
        </div>

        <Button
          variant="secondary"
          onClick={onAdd}
          disabled={disabled}
          loading={pending && !buying}
          className={cx(
            'h-[52px] min-w-[160px] flex-1 rounded-[12px] text-[15px]',
            added && 'border-transparent bg-[rgba(78,209,126,.14)] text-[#4ED17E]',
          )}
        >
          {added ? (
            <>
              <CheckIcon size={14} /> Added to cart
            </>
          ) : (
            'Add to Cart'
          )}
        </Button>

        <Button
          variant="primary"
          onClick={onBuyNow}
          disabled={disabled}
          loading={buying}
          className="h-[52px] min-w-[160px] flex-1 rounded-[12px] text-[15px]"
        >
          Buy Now
        </Button>

        <button
          type="button"
          onClick={() => setWishlisted((value) => !value)}
          aria-label={wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
          aria-pressed={wishlisted}
          className={cx(
            'grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[12px] border transition-colors',
            wishlisted
              ? 'border-[rgba(247,147,30,.5)] text-[#F7931E]'
              : 'border-white/14 text-[#C6C6CC] hover:border-[rgba(247,147,30,.5)] hover:text-[#F7931E]',
          )}
        >
          <HeartIcon size={18} className={wishlisted ? 'fill-current' : undefined} />
        </button>
      </div>

      {max < 20 && max > 0 ? (
        <p className="mb-0 mt-3 text-[12.5px] text-[#7E7E88]">
          {max} available — quantity is capped at what we can ship today.
        </p>
      ) : null}
    </div>
  );
}
