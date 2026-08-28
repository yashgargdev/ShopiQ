import type { Metadata } from 'next';
import Link from 'next/link';

import { ChevronRightIcon, SparkIcon } from '@/components/ui/icons';
import { EmptyState, LinkButton } from '@/components/ui/primitives';
import { formatNumber } from '@/lib/format';
import { listCategories } from '@/lib/products/queries';

export const metadata: Metadata = {
  title: 'Categories',
  description: 'Browse ShopiQ by category — electronics, gaming, fashion and home.',
};

export default async function CategoriesPage() {
  const all = await listCategories();
  const roots = all.filter((category) => category.parentId === null);

  if (roots.length === 0) {
    return (
      <main className="mx-auto max-w-[1320px] px-5 pb-[110px] pt-11 md:px-8">
        <h1 className="m-0 mb-8 text-[30px] font-semibold tracking-[-0.03em] md:text-[40px]">
          Categories
        </h1>
        <EmptyState
          title="No categories yet"
          description="Create a category in the merchant panel and it will appear here."
          action={
            <LinkButton href="/merchant/products" variant="ghost">
              Open merchant panel
            </LinkButton>
          }
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[1320px] px-5 pb-[110px] pt-11 md:px-8">
      <h1 className="m-0 text-[30px] font-semibold leading-none tracking-[-0.03em] md:text-[40px]">
        Categories
      </h1>
      <p className="mb-11 mt-3 text-[15px] text-[#7E7E88]">
        {formatNumber(all.filter((c) => c.parentId !== null).length)} categories across{' '}
        {roots.length} departments
      </p>

      <div className="flex flex-col gap-11">
        {roots.map((root) => (
          <section key={root.id}>
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="m-0 text-[22px] font-semibold leading-none tracking-[-0.02em]">
                  {root.name}
                </h2>
                {root.description ? (
                  <p className="mb-0 mt-2.5 text-[14px] text-[#7E7E88]">{root.description}</p>
                ) : null}
              </div>
              <Link
                href={`/products?category=${root.slug}`}
                className="flex items-center gap-1.5 text-[13.5px] text-[#F7931E] hover:text-[#FFB65C]"
              >
                All {formatNumber(root.productCount ?? 0)} products
                <ChevronRightIcon size={12} />
              </Link>
            </div>

            <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-4">
              {(root.children ?? []).map((child) => (
                <Link
                  key={child.id}
                  href={`/categories/${child.slug}`}
                  className="flex items-center gap-3.5 rounded-[14px] border border-white/7 bg-[#0A0A0C] p-3.5 text-white transition-[border-color,background] duration-200 hover:border-[rgba(247,147,30,.4)] hover:bg-[#0E0E11]"
                >
                  <div className="grid h-13 w-13 shrink-0 place-items-center rounded-[11px] bg-[#141418] text-[#7E7E88]">
                    <SparkIcon size={18} />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[14.5px] font-medium leading-[1.2]">
                      {child.name}
                    </div>
                    <div className="mt-1.5 text-[12.5px] leading-[1.2] text-[#7E7E88]">
                      {child.productCount} products
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
