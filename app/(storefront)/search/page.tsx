import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { Suspense } from 'react';

import { AskShopiQButton } from '@/components/ai/AskShopiQ';
import { PaginationBar, SortSelect } from '@/components/products/CatalogControls';
import { ProductGrid } from '@/components/products/ProductCard';
import { SearchLink } from '@/components/products/SearchLink';
import { SearchIcon, SparkIcon } from '@/components/ui/icons';
import { EmptyState, GridSkeleton, LinkButton } from '@/components/ui/primitives';
import { formatNumber, formatPrice } from '@/lib/format';
import { listProducts } from '@/lib/products/queries';
import { productQuerySchema } from '@/lib/validation/schemas';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search the ShopiQ catalogue by product, brand, category or specification.',
};

const POPULAR = ['gaming laptops', 'smartphones', 'headphones', 'mechanical keyboard', 'backpack'];

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const single = Array.isArray(value) ? value[value.length - 1] : value;
    if (single) flat[key] = single;
  }

  const query = (flat.q ?? '').trim();

  return (
    <main className="mx-auto max-w-[900px] px-5 pb-[120px] pt-12 md:px-8 md:pt-[70px]">
      <h1 className="m-0 mb-6 text-[24px] font-semibold leading-none tracking-[-0.02em] md:text-[28px]">
        Search ShopiQ
      </h1>

      <SearchLink
        defaultValue={query}
        placeholder="Search products, brands or specifications"
        autoFocus={!query}
        className="h-[66px] rounded-[16px] border-[rgba(247,147,30,.45)] px-5 text-[19px] shadow-[0_0_0_4px_rgba(247,147,30,.08)]"
      />

      <div className="mt-3">
        <AskShopiQButton
          label="Tell ShopiQ what you're looking for"
          className="h-auto w-full justify-start rounded-[14px] border-[rgba(247,147,30,.3)] bg-[linear-gradient(120deg,rgba(247,147,30,.1),rgba(247,147,30,.02))] px-4.5 py-4 text-[14.5px]"
        />
      </div>

      {query ? (
        <Suspense key={query + JSON.stringify(flat)} fallback={<ResultsFallback />}>
          <Results params={flat} />
        </Suspense>
      ) : (
        <PopularSearches />
      )}
    </main>
  );
}

async function Results({ params }: { params: Record<string, string> }) {
  const query = productQuerySchema.parse(params);
  const { products, pagination } = await listProducts(query);
  const term = query.q ?? '';

  if (products.length === 0) {
    return (
      <div className="mt-10">
        <EmptyState
          icon={<SearchIcon size={18} />}
          title={`No results for “${term}”`}
          description="Try a broader term, a brand name, or browse the full catalogue."
          action={
            <LinkButton href="/products" variant="ghost">
              Browse all products
            </LinkButton>
          }
        />

        <div className="mt-8">
          <div className="mb-4 font-mono text-[12px] uppercase tracking-[0.12em] text-[#6E6E76]">
            Try one of these
          </div>
          <div className="flex flex-wrap gap-2">
            {POPULAR.map((item) => (
              <PopularChip key={item} term={item} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const [top, ...rest] = products;

  return (
    <div className="mt-9">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#6E6E76]">
          {formatNumber(pagination.total)} {pagination.total === 1 ? 'result' : 'results'} for “
          {term}”
        </span>
        <SortSelect value={query.sort} />
      </div>

      {/* Best match gets the compact row treatment from the design. */}
      <Link
        href={`/products/${top.slug}`}
        className="mb-6 flex items-center gap-3.5 rounded-[12px] border border-[rgba(247,147,30,.28)] bg-[rgba(247,147,30,.04)] p-3 text-white transition-colors hover:border-[rgba(247,147,30,.5)]"
      >
        <div className="relative h-[52px] w-[52px] shrink-0 overflow-hidden rounded-[10px] bg-[#141418]">
          {top.image ? (
            <Image src={top.image} alt={top.name} fill sizes="52px" className="object-cover" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SparkIcon size={11} className="shrink-0 text-[#F7931E]" />
            <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#FFC07A]">
              Best match
            </span>
          </div>
          <div className="mt-1.5 truncate text-[14.5px] font-medium leading-[1.3]">{top.name}</div>
          <div className="mt-1.5 text-[12.5px] text-[#7E7E88]">
            {top.brand} · {top.rating.toFixed(1)} ★ · {top.category.name}
          </div>
        </div>
        <div className="shrink-0 text-[15px] font-semibold">{formatPrice(top.price)}</div>
      </Link>

      {rest.length > 0 ? <ProductGrid products={rest} columns={3} /> : null}

      <PaginationBar pagination={pagination} baseHref="/search" searchParams={params} />
    </div>
  );
}

function PopularSearches() {
  return (
    <div className="mt-10">
      <div className="mb-4 font-mono text-[12px] uppercase tracking-[0.12em] text-[#6E6E76]">
        Popular searches
      </div>
      <div className="flex flex-wrap gap-2">
        {POPULAR.map((term) => (
          <PopularChip key={term} term={term} />
        ))}
      </div>
    </div>
  );
}

function PopularChip({ term }: { term: string }) {
  return (
    <Link
      href={`/search?q=${encodeURIComponent(term)}`}
      className="rounded-full border border-white/12 px-3.5 py-2 text-[13px] text-[#C6C6CC] transition-colors hover:border-[rgba(247,147,30,.5)] hover:text-white"
    >
      {term}
    </Link>
  );
}

function ResultsFallback() {
  return (
    <div className="mt-9">
      <div className="skeleton mb-4 h-4 w-40 rounded" />
      <GridSkeleton count={6} columns={3} />
    </div>
  );
}
