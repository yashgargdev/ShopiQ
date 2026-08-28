import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AskShopiQButton } from '@/components/ai/AskShopiQ';
import {
  CategoryChips,
  FilterSidebar,
  MobileFilterButton,
  PaginationBar,
  SortSelect,
} from '@/components/products/CatalogControls';
import { ProductGrid } from '@/components/products/ProductCard';
import { SearchIcon } from '@/components/ui/icons';
import { EmptyState, GridSkeleton, LinkButton } from '@/components/ui/primitives';
import { formatNumber } from '@/lib/format';
import { getCatalogFacets, listLeafCategories, listProducts } from '@/lib/products/queries';
import { productQuerySchema } from '@/lib/validation/schemas';
import { SearchLink } from '@/components/products/SearchLink';

export const metadata: Metadata = {
  title: 'Products',
  description: 'Browse the full ShopiQ catalogue — laptops, phones, gaming gear and accessories.',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;
  const flat = flatten(raw);

  return (
    <main className="mx-auto max-w-[1320px] px-5 pb-[110px] pt-10 md:px-8 md:pt-11">
      <h1 className="m-0 text-[30px] font-semibold leading-none tracking-[-0.03em] md:text-[40px]">
        Products
      </h1>

      <Suspense fallback={<div className="mt-3 h-5" />}>
        <ResultCount params={flat} />
      </Suspense>

      <div className="mb-3.5 mt-7 flex flex-col gap-3 sm:flex-row">
        <SearchLink className="flex-1" />
        <AskShopiQButton
          label="Describe what you need"
          className="h-12 shrink-0 rounded-[12px] px-4.5 text-[14px]"
        />
      </div>

      <Suspense fallback={null}>
        <Filters params={flat} />
      </Suspense>
    </main>
  );
}

async function ResultCount({ params }: { params: Record<string, string> }) {
  const query = productQuerySchema.parse(params);
  const facets = await getCatalogFacets(query.category);
  const categoryLabel = query.category
    ? (facets.categories.find((c) => c.slug === query.category)?.name ?? query.category)
    : 'across every category';

  return (
    <p className="mb-0 mt-3 text-[15px] text-[#7E7E88]">
      {formatNumber(facets.total)} {facets.total === 1 ? 'product' : 'products'} ·{' '}
      {query.category ? categoryLabel : 'laptops, phones, gaming and accessories'}
    </p>
  );
}

async function Filters({ params }: { params: Record<string, string> }) {
  const query = productQuerySchema.parse(params);

  const [facets, categories] = await Promise.all([
    getCatalogFacets(query.category),
    listLeafCategories(),
  ]);

  const filterState = {
    category: query.category,
    brands: query.brand ?? [],
    minPrice: query.minPrice,
    maxPrice: query.maxPrice,
    rating: query.rating,
    inStock: query.inStock ?? false,
  };

  const activeCount =
    (filterState.brands.length > 0 ? 1 : 0) +
    (filterState.minPrice !== undefined || filterState.maxPrice !== undefined ? 1 : 0) +
    (filterState.rating !== undefined ? 1 : 0) +
    (filterState.inStock ? 1 : 0);

  return (
    <>
      <div className="mb-8">
        <CategoryChips
          categories={categories
            .filter((category) => (category.productCount ?? 0) > 0)
            .map((category) => ({ slug: category.slug, name: category.name }))}
          activeSlug={query.category}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-9 lg:grid-cols-[248px_1fr]">
        <FilterSidebar
          facets={facets}
          state={filterState}
          className="sticky top-[100px] hidden lg:flex"
        />

        <div>
          <div className="mb-4.5 flex items-center justify-between gap-3">
            <Suspense fallback={<span className="text-[13.5px] text-[#7E7E88]">Loading…</span>}>
              <ShowingCount params={params} />
            </Suspense>
            <div className="flex items-center gap-2">
              <MobileFilterButton facets={facets} state={filterState} activeCount={activeCount} />
              <SortSelect value={query.sort} />
            </div>
          </div>

          <Suspense fallback={<GridSkeleton count={9} columns={3} />}>
            <Results params={params} />
          </Suspense>
        </div>
      </div>
    </>
  );
}

async function ShowingCount({ params }: { params: Record<string, string> }) {
  const query = productQuerySchema.parse(params);
  const { products, pagination } = await listProducts(query);

  return (
    <span className="text-[13.5px] text-[#7E7E88]">
      {pagination.total === 0
        ? 'No matches'
        : `Showing ${formatNumber(products.length)} of ${formatNumber(pagination.total)}`}
    </span>
  );
}

async function Results({ params }: { params: Record<string, string> }) {
  const query = productQuerySchema.parse(params);
  const { products, pagination } = await listProducts(query);

  if (products.length === 0) {
    return (
      <EmptyState
        icon={<SearchIcon size={18} />}
        title="Nothing matched those filters"
        description="Try widening the price range, clearing a brand, or turning off the in-stock filter."
        action={
          <LinkButton href="/products" variant="ghost">
            Clear all filters
          </LinkButton>
        }
      />
    );
  }

  return (
    <>
      <ProductGrid products={products} columns={3} priorityCount={3} />
      <PaginationBar pagination={pagination} baseHref="/products" searchParams={params} />
    </>
  );
}

function flatten(params: SearchParams): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const single = Array.isArray(value) ? value[value.length - 1] : value;
    if (single !== undefined && single !== '') flat[key] = single;
  }
  return flat;
}
