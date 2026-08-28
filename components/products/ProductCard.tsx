'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import { useCart } from '@/components/cart/CartProvider';
import { CheckIcon, HeartIcon } from '@/components/ui/icons';
import { DiscountBadge, Price, Rating } from '@/components/ui/primitives';
import { cx, discountPercent } from '@/lib/format';
import type { ProductSummary } from '@/types';

/**
 * The product card from the design: a hairline-bordered tile that lifts 3px on
 * hover, with a 4:3 image, brand eyebrow in mono, name, rating, price and a
 * full-width Add to Cart button that fills with the brand gradient on hover.
 */

export function ProductCard({
  product,
  priority = false,
}: {
  product: ProductSummary;
  priority?: boolean;
}) {
  const { addItem, pending } = useCart();
  const [state, setState] = useState<'idle' | 'adding' | 'added'>('idle');
  const [wishlisted, setWishlisted] = useState(false);

  const off = discountPercent(product.price, product.compareAtPrice);
  const { inStock, lowStock, available } = product.availability;

  const onAdd = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!inStock || state === 'adding') return;

    setState('adding');
    const ok = await addItem(product.id, 1);
    setState(ok ? 'added' : 'idle');
    if (ok) setTimeout(() => setState('idle'), 1800);
  };

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-[16px] border border-white/7 bg-[#0A0A0C] transition-[transform,border-color] duration-200 hover:-translate-y-[3px] hover:border-[rgba(247,147,30,.38)]">
      <Link
        href={`/products/${product.slug}`}
        className="relative block aspect-[4/3] overflow-hidden bg-[#121216]"
      >
        {product.image ? (
          <Image
            src={product.image}
            alt={product.imageAlt ?? `${product.brand} ${product.name}`}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 320px"
            priority={priority}
            className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="grid h-full place-items-center px-4 text-center font-mono text-[11px] uppercase tracking-[0.1em] text-[#4E4E56]">
            {product.brand}
          </div>
        )}

        {off !== null ? <DiscountBadge percent={off} /> : null}

        {!inStock ? (
          <span className="absolute inset-x-0 bottom-0 bg-black/78 py-2 text-center text-[12px] font-medium text-[#FF8B8B] backdrop-blur-sm">
            Out of stock
          </span>
        ) : lowStock ? (
          <span className="absolute inset-x-0 bottom-0 bg-black/72 py-2 text-center text-[12px] font-medium text-[#FFB65C] backdrop-blur-sm">
            Only {available} left
          </span>
        ) : null}
      </Link>

      <button
        type="button"
        aria-label={wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
        aria-pressed={wishlisted}
        onClick={() => setWishlisted((value) => !value)}
        className={cx(
          'absolute right-2.5 top-2.5 grid h-[31px] w-[31px] place-items-center rounded-[9px] border bg-black/55 transition-colors',
          wishlisted
            ? 'border-[rgba(247,147,30,.5)] text-[#F7931E]'
            : 'border-white/10 text-[#C6C6CC] hover:border-[rgba(247,147,30,.5)] hover:text-[#F7931E]',
        )}
      >
        <HeartIcon size={15} className={wishlisted ? 'fill-current' : undefined} />
      </button>

      <div className="flex flex-1 flex-col gap-[7px] p-[15px]">
        <div className="font-mono text-[11px] uppercase leading-none tracking-[0.1em] text-[#7E7E88]">
          {product.brand}
        </div>

        <h3 className="m-0 text-[15px] font-medium leading-[1.35] text-[#EDEDF0]">
          <Link href={`/products/${product.slug}`} className="text-inherit hover:text-white">
            {product.name}
          </Link>
        </h3>

        <Rating value={product.rating} count={product.reviewCount} />

        <Price amount={product.price} compareAt={product.compareAtPrice} className="mt-0.5" />

        <button
          type="button"
          onClick={onAdd}
          disabled={!inStock || pending || state === 'adding'}
          className={cx(
            'mt-auto h-[38px] w-full rounded-[10px] border text-[13.5px] font-medium transition-all duration-200',
            state === 'added'
              ? 'border-transparent bg-[rgba(78,209,126,.14)] text-[#4ED17E]'
              : inStock
                ? 'border-white/12 bg-[#141418] text-white hover:border-transparent hover:brand-gradient hover:text-[#1A0D02]'
                : 'cursor-not-allowed border-white/8 bg-[#0E0E11] text-[#4E4E56]',
          )}
        >
          {state === 'added' ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckIcon size={13} /> Added
            </span>
          ) : state === 'adding' ? (
            'Adding…'
          ) : inStock ? (
            'Add to Cart'
          ) : (
            'Out of stock'
          )}
        </button>
      </div>
    </article>
  );
}

export function ProductGrid({
  products,
  columns = 4,
  priorityCount = 0,
}: {
  products: ProductSummary[];
  columns?: 2 | 3 | 4;
  priorityCount?: number;
}) {
  const cols = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4',
  }[columns];

  return (
    <div className={cx('grid gap-3 sm:gap-4', cols)}>
      {products.map((product, index) => (
        <ProductCard key={product.id} product={product} priority={index < priorityCount} />
      ))}
    </div>
  );
}
