'use client';

import Image from 'next/image';
import { useState } from 'react';

import { cx } from '@/lib/format';
import type { ProductImage } from '@/types';

/** Square main image with a four-up thumbnail strip, as in the design. */
export function ProductGallery({
  images,
  productName,
}: {
  images: ProductImage[];
  productName: string;
}) {
  const [active, setActive] = useState(0);

  if (images.length === 0) {
    return (
      <div className="grid aspect-square place-items-center rounded-[20px] border border-white/7 bg-[#101014] font-mono text-[12px] uppercase tracking-[0.1em] text-[#4E4E56]">
        No image
      </div>
    );
  }

  const current = images[Math.min(active, images.length - 1)];

  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-[20px] border border-white/7 bg-[#101014]">
        <Image
          src={current.url}
          alt={current.alt ?? productName}
          fill
          priority
          sizes="(max-width: 1024px) 100vw, 620px"
          className="object-cover"
        />
      </div>

      {current.attribution ? (
        <p className="mt-2 text-[11px] leading-snug text-[#6E6E78]">
          Photo:{' '}
          {current.sourceUrl ? (
            <a
              href={current.sourceUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline decoration-white/20 underline-offset-2 hover:text-[#C6C6CC]"
            >
              {current.attribution}
            </a>
          ) : (
            current.attribution
          )}
          {current.license ? ` · ${current.license}` : null}
        </p>
      ) : null}

      {images.length > 1 ? (
        <div className="mt-3 grid grid-cols-4 gap-3">
          {images.slice(0, 8).map((image, index) => (
            <button
              key={image.id}
              type="button"
              onClick={() => setActive(index)}
              aria-label={`View image ${index + 1} of ${images.length}`}
              aria-current={index === active}
              className={cx(
                'relative aspect-square overflow-hidden rounded-[12px] border bg-[#101014] transition-colors',
                index === active
                  ? 'border-[rgba(247,147,30,.5)]'
                  : 'border-white/7 hover:border-white/20',
              )}
            >
              <Image
                src={image.url}
                alt=""
                fill
                sizes="120px"
                className="object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
