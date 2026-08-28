import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import {
  FilterSidebar,
  MobileFilterButton,
  PaginationBar,
  SortSelect,
} from '@/components/products/CatalogControls';
import { ProductGrid } from '@/components/products/ProductCard';
import { SearchIcon } from '@/components/ui/icons';
import { EmptyState, GridSkeleton, LinkButton } from '@/components/ui/primitives';
import { formatNumber } from '@/lib/format';
import { getCatalogFacets, getCategoryBySlug, listProducts } from '@/lib/products/queries';
import { productQuerySchema } from '@/lib/validation/schemas';

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);
  if (!category) return { title: 'Category' };

  return {
    title: category.name,
    description:
      category.description ?? `Browse ${category.name.toLowerCase()} on ShopiQ.`,
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ slug }, raw] = await Promise.all([params, searchParams]);

  const category = await getCategoryBySlug(slug);
  if (!category) notFound();

  const flat: Record<string, string> = { category: slug };
  for (const [key, value] of Object.entries(raw)) {
    const single = Array.isArray(value) ? value[value.length - 1] : value;
    if (single && key !== 'category') flat[key] = single;
  }

  const query = productQuerySchema.parse(flat);
  const facets = await getCatalogFacets(slug);

  const filterState = {
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
    <main className="mx-auto max-w-[1320px] px-5 pb-[110px] pt-8 md:px-8 md:pt-11">
      <nav
        aria-label="Breadcrumb"
        className="mb-6 flex items-center gap-2 text-[13px] text-[#6E6E76]"
      >
        <Link href="/categories" className="text-[#6E6E76] hover:text-white">
          Categories
        </Link>
        <span>/</span>
        <span className="text-[#B9B9C0]">{category.name}</span>
      </nav>

      <h1 className="m-0 text-[30px] font-semibold leading-none tracking-[-0.03em] md:text-[40px]">
        {category.name}
      </h1>
      <p className="mb-9 mt-3 max-w-[620px] text-[15px] leading-relaxed text-[#7E7E88]">
        {category.description ? `${category.description} · ` : ''}
        {formatNumber(facets.total)} {facets.total === 1 ? 'product' : 'products'}
      </p>

      {category.children && category.children.length > 0 ? (
        <div className="-mx-5 mb-8 flex gap-2 overflow-x-auto px-5 md:mx-0 md:flex-wrap md:px-0">
          {category.children.map((child) => (
            <Link
              key={child.id}
              href={`/categories/${child.slug}`}
              className="shrink-0 whitespace-nowrap rounded-full border border-white/12 px-3.5 py-2 text-[13px] text-[#B9B9C0] transition-colors hover:border-white/25 hover:text-white"
            >
              {child.name}
              <span className="ml-1.5 text-[#6E6E76]">{child.productCount}</span>
            </Link>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-9 lg:grid-cols-[248px_1fr]">
        <FilterSidebar
          facets={facets}
          state={filterState}
          className="sticky top-[100px] hidden lg:flex"
        />

        <div>
          <div className="mb-4.5 flex items-center justify-between gap-3">
            <span className="text-[13.5px] text-[#7E7E88]">
              {facets.total === 0 ? 'No products' : `${formatNumber(facets.total)} in stock list`}
            </span>
            <div className="flex items-center gap-2">
              <MobileFilterButton facets={facets} state={filterState} activeCount={activeCount} />
              <SortSelect value={query.sort} />
            </div>
          </div>

          <Suspense
            key={JSON.stringify(flat)}
            fallback={<GridSkeleton count={9} columns={3} />}
          >
            <Results params={flat} slug={slug} />
          </Suspense>
        </div>
      </div>
    </main>
  );
}

async function Results({ params, slug }: { params: Record<string, string>; slug: string }) {
  const query = productQuerySchema.parse(params);
  const { products, pagination } = await listProducts(query);

  if (products.length === 0) {
    return (
      <EmptyState
        icon={<SearchIcon size={18} />}
        title="Nothing here yet"
        description="No products in this category match your filters."
        action={
          <LinkButton href={`/categories/${slug}`} variant="ghost">
            Clear filters
          </LinkButton>
        }
      />
    );
  }

  const { category: _category, ...rest } = params;

  return (
    <>
      <ProductGrid products={products} columns={3} priorityCount={3} />
      <PaginationBar
        pagination={pagination}
        baseHref={`/categories/${slug}`}
        searchParams={rest}
      />
    </>
  );
}
