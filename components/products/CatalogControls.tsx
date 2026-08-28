'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';

import { ChevronDownIcon, CheckIcon, FilterIcon, CloseIcon } from '@/components/ui/icons';
import { cx, formatPrice } from '@/lib/format';
import { SORT_OPTIONS } from '@/lib/validation/schemas';
import type { CatalogFacets, Pagination } from '@/types';

/**
 * Filters, sorting and pagination for the catalogue.
 *
 * All state lives in the URL: the server component re-renders from the query
 * string, so results are shareable, bookmarkable and survive a refresh.
 */

const SORT_LABELS: Record<(typeof SORT_OPTIONS)[number], string> = {
  relevance: 'Relevance',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  rating: 'Top rated',
  newest: 'Newest',
  discount: 'Biggest discount',
};

function useQueryUpdater() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  return useCallback(
    (updates: Record<string, string | string[] | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || (Array.isArray(value) && value.length === 0) || value === '') {
          next.delete(key);
        } else {
          next.set(key, Array.isArray(value) ? value.join(',') : value);
        }
      }
      // Any filter change invalidates the current page number.
      if (!('page' in updates)) next.delete('page');
      const query = next.toString();
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
}

/* ------------------------------------------------------------------ sorting */

export function SortSelect({ value }: { value: string }) {
  const update = useQueryUpdater();

  return (
    <label className="flex items-center gap-2.5 text-[13.5px] text-[#C6C6CC]">
      <span className="hidden sm:inline">Sort</span>
      <span className="relative inline-flex h-9 items-center gap-2 rounded-[9px] border border-white/12 pl-3 pr-8 transition-colors hover:border-white/25">
        {SORT_LABELS[value as keyof typeof SORT_LABELS] ?? 'Relevance'}
        <ChevronDownIcon size={12} className="pointer-events-none absolute right-3" />
        <select
          value={value}
          onChange={(event) => update({ sort: event.target.value })}
          aria-label="Sort products"
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option} value={option} className="bg-[#0C0C0E] text-white">
              {SORT_LABELS[option]}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

/* ------------------------------------------------------- category quick chips */

export function CategoryChips({
  categories,
  activeSlug,
}: {
  categories: Array<{ slug: string; name: string }>;
  activeSlug?: string;
}) {
  const update = useQueryUpdater();

  return (
    <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 md:mx-0 md:flex-wrap md:px-0">
      <button
        type="button"
        onClick={() => update({ category: null })}
        className={cx(
          'shrink-0 rounded-full px-3.5 py-2 text-[13px] leading-none transition-colors',
          !activeSlug
            ? 'bg-white font-medium text-black'
            : 'border border-white/12 text-[#B9B9C0] hover:border-white/25 hover:text-white',
        )}
      >
        All
      </button>
      {categories.map((category) => (
        <button
          key={category.slug}
          type="button"
          onClick={() => update({ category: category.slug })}
          className={cx(
            'shrink-0 whitespace-nowrap rounded-full px-3.5 py-2 text-[13px] leading-none transition-colors',
            activeSlug === category.slug
              ? 'bg-white font-medium text-black'
              : 'border border-white/12 text-[#B9B9C0] hover:border-white/25 hover:text-white',
          )}
        >
          {category.name}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ sidebar */

interface FilterState {
  category?: string;
  brands: string[];
  minPrice?: number;
  maxPrice?: number;
  rating?: number;
  inStock: boolean;
}

export function FilterSidebar({
  facets,
  state,
  className,
}: {
  facets: CatalogFacets;
  state: FilterState;
  className?: string;
}) {
  const update = useQueryUpdater();

  const toggleBrand = (brand: string) => {
    const next = state.brands.includes(brand)
      ? state.brands.filter((value) => value !== brand)
      : [...state.brands, brand];
    update({ brand: next });
  };

  const hasFilters =
    state.brands.length > 0 ||
    state.minPrice !== undefined ||
    state.maxPrice !== undefined ||
    state.rating !== undefined ||
    state.inStock ||
    Boolean(state.category);

  return (
    <aside className={cx('flex flex-col gap-6.5', className)}>
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold">Filters</span>
        {hasFilters ? (
          <button
            type="button"
            onClick={() =>
              update({
                brand: null,
                minPrice: null,
                maxPrice: null,
                rating: null,
                inStock: null,
                category: null,
              })
            }
            className="border-none bg-transparent p-0 text-[13px] text-[#F7931E] hover:text-[#FFB65C]"
          >
            Clear all
          </button>
        ) : null}
      </div>

      {facets.categories.length > 1 ? (
        <FilterGroup label="Category">
          {facets.categories.slice(0, 10).map((category) => (
            <Checkbox
              key={category.id}
              checked={state.category === category.slug}
              onChange={() =>
                update({ category: state.category === category.slug ? null : category.slug })
              }
              count={category.count}
            >
              {category.name}
            </Checkbox>
          ))}
        </FilterGroup>
      ) : null}

      <PriceFilter
        min={facets.priceRange.min}
        max={facets.priceRange.max}
        value={[state.minPrice, state.maxPrice]}
        onChange={(next) =>
          update({
            minPrice: next[0] !== undefined ? String(next[0]) : null,
            maxPrice: next[1] !== undefined ? String(next[1]) : null,
          })
        }
      />

      {facets.brands.length > 0 ? (
        <FilterGroup label="Brand">
          <div className="max-h-64 overflow-y-auto pr-1">
            {facets.brands.map((brand) => (
              <Checkbox
                key={brand.name}
                checked={state.brands.includes(brand.name)}
                onChange={() => toggleBrand(brand.name)}
                count={brand.count}
              >
                {brand.name}
              </Checkbox>
            ))}
          </div>
        </FilterGroup>
      ) : null}

      <FilterGroup label="Rating">
        {[4.5, 4, 3.5].map((rating) => (
          <Radio
            key={rating}
            checked={state.rating === rating}
            onChange={() => update({ rating: state.rating === rating ? null : String(rating) })}
          >
            {rating} &amp; above
          </Radio>
        ))}
      </FilterGroup>

      <FilterGroup label="Availability">
        <Checkbox
          checked={state.inStock}
          onChange={() => update({ inStock: state.inStock ? null : 'true' })}
        >
          In stock
        </Checkbox>
      </FilterGroup>
    </aside>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3.5 text-[12.5px] font-medium uppercase leading-none tracking-[0.08em] text-[#7E7E88]">
        {label}
      </div>
      <div className="flex flex-col gap-2.5 text-[14px] text-[#C6C6CC]">{children}</div>
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  count,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-1 transition-colors hover:text-white">
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
      <span
        className={cx(
          'grid h-4 w-4 shrink-0 place-items-center rounded-[4px] transition-colors',
          checked ? 'brand-gradient text-[#1A0D02]' : 'border border-white/20',
        )}
      >
        {checked ? <CheckIcon size={10} /> : null}
      </span>
      <span className="min-w-0 truncate">{children}</span>
      {count !== undefined ? (
        <span className="ml-auto shrink-0 text-[#6E6E76]">{count}</span>
      ) : null}
    </label>
  );
}

function Radio({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-1 transition-colors hover:text-white">
      <input type="radio" checked={checked} onChange={onChange} className="sr-only" />
      <span
        className={cx(
          'h-4 w-4 shrink-0 rounded-full transition-all',
          checked ? 'border-[5px] border-[#F7931E] bg-black' : 'border border-white/20',
        )}
      />
      {children}
    </label>
  );
}

function PriceFilter({
  min,
  max,
  value,
  onChange,
}: {
  min: number;
  max: number;
  value: [number | undefined, number | undefined];
  onChange: (next: [number | undefined, number | undefined]) => void;
}) {
  const [draft, setDraft] = useState<[string, string]>([
    value[0] !== undefined ? String(value[0]) : '',
    value[1] !== undefined ? String(value[1]) : '',
  ]);

  const commit = () => {
    const lower = draft[0].trim() === '' ? undefined : Math.max(Number(draft[0]), 0);
    const upper = draft[1].trim() === '' ? undefined : Math.max(Number(draft[1]), 0);
    if ((lower !== undefined && !Number.isFinite(lower)) || (upper !== undefined && !Number.isFinite(upper))) {
      return;
    }
    // Swap rather than reject when the bounds are entered the wrong way round.
    if (lower !== undefined && upper !== undefined && lower > upper) {
      onChange([upper, lower]);
      setDraft([String(upper), String(lower)]);
      return;
    }
    onChange([lower, upper]);
  };

  return (
    <div>
      <div className="mb-3.5 text-[12.5px] font-medium uppercase leading-none tracking-[0.08em] text-[#7E7E88]">
        Price
      </div>
      <div className="flex items-center gap-2">
        <input
          inputMode="numeric"
          value={draft[0]}
          onChange={(event) => setDraft([event.target.value.replace(/\D/g, ''), draft[1]])}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
          placeholder="Min"
          aria-label="Minimum price"
          className="h-10 w-full min-w-0 rounded-[10px] border border-white/10 bg-[#0C0C0E] px-3 font-mono text-[13px] text-[#EDEDF0] outline-none transition-colors focus:border-[rgba(247,147,30,.5)]"
        />
        <span className="text-[#4E4E56]">—</span>
        <input
          inputMode="numeric"
          value={draft[1]}
          onChange={(event) => setDraft([draft[0], event.target.value.replace(/\D/g, '')])}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
          placeholder="Max"
          aria-label="Maximum price"
          className="h-10 w-full min-w-0 rounded-[10px] border border-white/10 bg-[#0C0C0E] px-3 font-mono text-[13px] text-[#EDEDF0] outline-none transition-colors focus:border-[rgba(247,147,30,.5)]"
        />
      </div>
      <div className="mt-3 flex justify-between font-mono text-[12px] text-[#6E6E76]">
        <span>{formatPrice(min)}</span>
        <span>{formatPrice(max)}</span>
      </div>
    </div>
  );
}

/** Sidebar in a drawer, for the mobile layout. */
export function MobileFilterButton({
  facets,
  state,
  activeCount,
}: {
  facets: CatalogFacets;
  state: FilterState;
  activeCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 shrink-0 items-center gap-2 rounded-[9px] border border-white/12 px-3 text-[13px] text-[#C6C6CC] lg:hidden"
      >
        <FilterIcon size={14} />
        Filters
        {activeCount > 0 ? (
          <span className="rounded-full brand-gradient px-1.5 text-[11px] font-semibold text-[#1A0D02]">
            {activeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="fixed inset-0 z-100 lg:hidden">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-[3px]" onClick={() => setOpen(false)} />
          <div className="animate-sheet-up absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-[22px] border border-b-0 border-white/10 bg-[#08080A] px-5 pb-8 pt-3">
            <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-white/20" />
            <div className="mb-5 flex items-center justify-between">
              <span className="text-[17px] font-semibold">Filters</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close filters"
                className="grid h-8 w-8 place-items-center rounded-[9px] border border-white/10 text-[#9A9AA2]"
              >
                <CloseIcon size={15} />
              </button>
            </div>
            <FilterSidebar facets={facets} state={state} />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-7 h-12 w-full rounded-[12px] brand-gradient text-[15px] font-semibold text-[#1A0D02]"
            >
              Show results
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- pagination */

export function PaginationBar({
  pagination,
  baseHref,
  searchParams,
}: {
  pagination: Pagination;
  baseHref: string;
  searchParams: Record<string, string | undefined>;
}) {
  if (pagination.totalPages <= 1) return null;

  const hrefForPage = (page: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value && key !== 'page') params.set(key, value);
    }
    if (page > 1) params.set('page', String(page));
    const query = params.toString();
    return query ? `${baseHref}?${query}` : baseHref;
  };

  const { page, totalPages } = pagination;
  const pages = pageWindow(page, totalPages);

  return (
    <nav
      aria-label="Pagination"
      className="mt-10 flex flex-wrap items-center justify-center gap-2"
    >
      <PageLink href={hrefForPage(page - 1)} disabled={!pagination.hasPreviousPage}>
        Previous
      </PageLink>

      {pages.map((entry, index) =>
        entry === '…' ? (
          <span key={`gap-${index}`} className="px-1 text-[13px] text-[#4E4E56]">
            …
          </span>
        ) : (
          <Link
            key={entry}
            href={hrefForPage(entry)}
            aria-current={entry === page ? 'page' : undefined}
            className={cx(
              'grid h-9 min-w-9 place-items-center rounded-[9px] px-2.5 text-[13.5px] transition-colors',
              entry === page
                ? 'brand-gradient font-semibold text-[#1A0D02]'
                : 'border border-white/12 text-[#C6C6CC] hover:border-white/28 hover:text-white',
            )}
          >
            {entry}
          </Link>
        ),
      )}

      <PageLink href={hrefForPage(page + 1)} disabled={!pagination.hasNextPage}>
        Next
      </PageLink>
    </nav>
  );
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="grid h-9 cursor-not-allowed place-items-center rounded-[9px] border border-white/6 px-3.5 text-[13.5px] text-[#3A3A42]">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="grid h-9 place-items-center rounded-[9px] border border-white/12 px-3.5 text-[13.5px] text-[#C6C6CC] transition-colors hover:border-white/28 hover:text-white"
    >
      {children}
    </Link>
  );
}

/** 1 … 4 5 [6] 7 8 … 20 */
function pageWindow(current: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const pages = new Set<number>([1, total, current]);
  for (let offset = 1; offset <= 1; offset++) {
    if (current - offset > 1) pages.add(current - offset);
    if (current + offset < total) pages.add(current + offset);
  }

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const result: Array<number | '…'> = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) result.push('…');
    result.push(page);
    previous = page;
  }
  return result;
}
