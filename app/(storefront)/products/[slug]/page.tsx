import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AiPromptChip } from '@/components/ai/AskShopiQ';
import { AddToCartPanel } from '@/components/products/AddToCartPanel';
import { ProductGallery } from '@/components/products/ProductGallery';
import { ProductGrid } from '@/components/products/ProductCard';
import { SparkIcon } from '@/components/ui/icons';
import { Price, Rating, SectionHeading, StockPill } from '@/components/ui/primitives';
import { ProductReviews } from '@/components/products/ProductReviews';
import { ApiError } from '@/lib/api/response';
import { deliveryEstimate, formatNumber, formatSpecValue } from '@/lib/format';
import { getProductDetail } from '@/lib/products/queries';

/** The six specs the design surfaces in the summary grid, in priority order. */
const HIGHLIGHT_KEYS = [
  'processor',
  'gpu',
  'ram_gb',
  'storage_gb',
  'display_size',
  'weight_kg',
  'type',
  'noise_cancellation',
  'battery_hours',
  'battery_mah',
  'material',
  'capacity_l',
  'switch_type',
  'sensor_dpi',
  'panel_type',
  'refresh_rate_hz',
];

async function loadProduct(slug: string) {
  try {
    return await getProductDetail(slug);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const product = await getProductDetail(slug);
    return {
      title: `${product.brand} ${product.name}`,
      description: product.shortDescription ?? product.description ?? undefined,
      openGraph: {
        title: `${product.brand} ${product.name}`,
        description: product.shortDescription ?? undefined,
        images: product.image ? [product.image] : undefined,
      },
    };
  } catch {
    return { title: 'Product' };
  }
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await loadProduct(slug);

  const highlights = HIGHLIGHT_KEYS.map((key) =>
    product.specifications.find((spec) => spec.key === key),
  )
    .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec))
    .slice(0, 6);

  return (
    <main className="mx-auto max-w-[1320px] px-5 pb-[110px] pt-6 md:px-8 md:pt-8">
      <nav
        aria-label="Breadcrumb"
        className="mb-7 flex flex-wrap items-center gap-2 text-[13px] text-[#6E6E76]"
      >
        <Link href="/products" className="text-[#6E6E76] hover:text-white">
          Products
        </Link>
        <span>/</span>
        <Link
          href={`/categories/${product.category.slug}`}
          className="text-[#6E6E76] hover:text-white"
        >
          {product.category.name}
        </Link>
        <span>/</span>
        <span className="text-[#B9B9C0]">{product.name}</span>
      </nav>

      <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-15">
        <ProductGallery images={product.images} productName={product.name} />

        <div>
          <div className="font-mono text-[11.5px] uppercase leading-none tracking-[0.1em] text-[#7E7E88]">
            {product.brand}
          </div>

          <h1 className="mb-0 mt-3 text-[28px] font-semibold leading-[1.15] tracking-[-0.03em] md:text-[36px]">
            {product.name}
          </h1>

          <div className="mt-4 flex flex-wrap items-center gap-3.5 text-[14px] text-[#9A9AA2]">
            <Rating value={product.rating} size={15} />
            <span>
              {formatNumber(product.reviewCount)}{' '}
              {product.reviewCount === 1 ? 'review' : 'reviews'}
            </span>
            <span className="text-[#3A3A42]">·</span>
            <span className="font-mono text-[12.5px]">SKU {product.sku}</span>
          </div>

          <Price
            amount={product.price}
            compareAt={product.compareAtPrice}
            currency={product.currency}
            size="xl"
            className="mt-6"
          />

          <StockPill
            available={product.availability.available}
            inStock={product.availability.inStock}
            lowStock={product.availability.lowStock}
            className="mt-3.5"
          />

          {product.shortDescription ? (
            <p className="mb-0 mt-6 text-[15.5px] leading-[1.65] text-pretty text-[#9A9AA2]">
              {product.shortDescription}
            </p>
          ) : null}

          {highlights.length > 0 ? (
            <div className="mt-6.5 grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-white/7 bg-white/7">
              {highlights.map((spec) => (
                <div key={spec.key} className="bg-[#0A0A0C] px-4 py-3.5">
                  <div className="text-[12px] leading-none text-[#6E6E76]">{spec.label}</div>
                  <div className="mt-2 text-[14px] font-medium leading-tight">
                    {formatSpecValue(spec.value, spec.unit)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <AddToCartPanel productId={product.id} availability={product.availability} />

          {/* AI entry point — kept from the design, honest about Phase 2. */}
          <div className="mt-5.5 rounded-[16px] border border-[rgba(247,147,30,.28)] bg-[linear-gradient(160deg,rgba(247,147,30,.09),rgba(247,147,30,.02))] p-4.5">
            <div className="flex items-center gap-2.5 text-[14px] font-medium text-[#FFC07A]">
              <SparkIcon size={15} />
              Ask ShopiQ about this product
            </div>
            <div className="mt-3.5 flex flex-wrap gap-2">
              <AiPromptChip context={`Is the ${product.name} good for programming?`}>
                Is this good for programming?
              </AiPromptChip>
              <AiPromptChip context={`How is the battery life on the ${product.name}?`}>
                How is the battery life?
              </AiPromptChip>
              {product.related[0] ? (
                <AiPromptChip
                  context={`Compare the ${product.name} with the ${product.related[0].name}.`}
                >
                  Compare with {product.related[0].brand} {product.related[0].name}
                </AiPromptChip>
              ) : null}
            </div>
          </div>

          <div className="mt-6.5 flex flex-wrap gap-6.5 text-[13.5px] leading-[1.5] text-[#9A9AA2]">
            <div>
              <div className="font-medium text-[#EDEDF0]">Free delivery</div>
              {deliveryEstimate(2)}
            </div>
            <div>
              <div className="font-medium text-[#EDEDF0]">7-day returns</div>
              No questions asked
            </div>
            <div>
              <div className="font-medium text-[#EDEDF0]">1-year warranty</div>
              Brand warranty
            </div>
          </div>
        </div>
      </div>

      {product.description ? (
        <section className="mt-16 max-w-[820px]">
          <h2 className="m-0 mb-4 text-[20px] font-semibold tracking-[-0.02em]">
            About this product
          </h2>
          <p className="m-0 text-[15.5px] leading-[1.75] text-pretty text-[#9A9AA2]">
            {product.description}
          </p>
        </section>
      ) : null}

      {product.specifications.length > 0 ? (
        <section className="mt-14">
          <h2 className="m-0 mb-5 text-[20px] font-semibold tracking-[-0.02em]">Specifications</h2>
          <div className="overflow-hidden rounded-[16px] border border-white/8">
            <dl className="m-0 grid grid-cols-1 md:grid-cols-2">
              {product.specifications.map((spec) => (
                <div
                  key={spec.key}
                  className="flex items-start gap-4 border-b border-white/6 px-5 py-3.5 last:border-b-0 md:odd:border-r md:odd:border-r-white/6"
                >
                  <dt className="w-[45%] shrink-0 text-[13.5px] text-[#7E7E88]">{spec.label}</dt>
                  <dd className="m-0 text-[14px] font-medium text-[#EDEDF0]">
                    {formatSpecValue(spec.value, spec.unit)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="mb-0 mt-3.5 text-[12.5px] text-[#4E4E56]">
            Specifications are stored as typed values, so ShopiQ&apos;s assistant will be able to
            compare and filter on them directly.
          </p>
        </section>
      ) : null}

      <Suspense fallback={null}>
        <ProductReviews productId={product.id} />
      </Suspense>

      {product.related.length > 0 ? (
        <section className="mt-16">
          <SectionHeading
            title="More in this category"
            subtitle={`Other ${product.category.name.toLowerCase()} shoppers also look at`}
          />
          <ProductGrid products={product.related} columns={4} />
        </section>
      ) : null}
    </main>
  );
}
