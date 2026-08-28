import Link from 'next/link';

import { InventoryTable } from '@/components/merchant/InventoryTable';
import { StatCard } from '@/components/merchant/StatCard';
import { EmptyState, LinkButton } from '@/components/ui/primitives';
import { cx, formatNumber } from '@/lib/format';
import { listInventory } from '@/lib/merchant/queries';

export const metadata = { title: 'Inventory' };

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'low_stock', label: 'Low stock' },
  { value: 'out_of_stock', label: 'Out of stock' },
] as const;

export default async function MerchantInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const statusParam = typeof params.status === 'string' ? params.status : 'all';
  const status = (
    statusParam === 'low_stock' || statusParam === 'out_of_stock' ? statusParam : 'all'
  ) as 'all' | 'low_stock' | 'out_of_stock';
  const search = typeof params.q === 'string' ? params.q : undefined;

  const { rows } = await listInventory({ status, search, limit: 200 });

  // Totals are for the full catalogue, not just the filtered page.
  const { rows: allRows } = await listInventory({ status: 'all', limit: 500 });
  const active = allRows.filter((row) => row.isActive);
  const lowStock = active.filter((row) => row.status === 'low_stock').length;
  const outOfStock = active.filter((row) => row.status === 'out_of_stock').length;
  const unitsOnHand = allRows.reduce((sum, row) => sum + row.quantity, 0);
  const reserved = allRows.reduce((sum, row) => sum + row.reservedQuantity, 0);

  return (
    <main className="px-5 pb-16 pt-7 md:px-8 md:pt-9">
      <div className="mb-7">
        <h1 className="m-0 text-[28px] font-semibold leading-none tracking-[-0.03em]">Inventory</h1>
        <p className="mb-0 mt-3 text-[14px] text-[#7E7E88]">
          Edit stock inline. Available is quantity minus what is reserved against open orders.
        </p>
      </div>

      <div className="mb-7 grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <StatCard label="Units on hand" value={formatNumber(unitsOnHand)} />
        <StatCard
          label="Reserved"
          value={formatNumber(reserved)}
          hint="Held against open orders"
        />
        <StatCard
          label="Low stock"
          value={formatNumber(lowStock)}
          tone={lowStock > 0 ? 'warn' : 'default'}
        />
        <StatCard
          label="Out of stock"
          value={formatNumber(outOfStock)}
          tone={outOfStock > 0 ? 'danger' : 'default'}
        />
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {FILTERS.map((filter) => (
            <Link
              key={filter.value}
              href={
                filter.value === 'all'
                  ? '/merchant/inventory'
                  : `/merchant/inventory?status=${filter.value}`
              }
              className={cx(
                'rounded-full px-3.5 py-2 text-[13px] leading-none transition-colors',
                status === filter.value
                  ? 'bg-white font-medium text-black'
                  : 'border border-white/12 text-[#B9B9C0] hover:border-white/25 hover:text-white',
              )}
            >
              {filter.label}
            </Link>
          ))}
        </div>

        <form action="/merchant/inventory" className="ml-auto">
          {status !== 'all' ? <input type="hidden" name="status" value={status} /> : null}
          <input
            name="q"
            defaultValue={search}
            placeholder="Search name, brand or SKU"
            aria-label="Search inventory"
            className="h-10 w-full min-w-[240px] rounded-[10px] border border-white/10 bg-[#0C0C0E] px-3.5 text-[13.5px] text-[#EDEDF0] outline-none transition-colors focus:border-[rgba(247,147,30,.5)]"
          />
        </form>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={
            status === 'low_stock'
              ? 'Nothing is running low'
              : status === 'out_of_stock'
                ? 'Nothing is out of stock'
                : 'No products yet'
          }
          description={
            status === 'all'
              ? 'Add a product and its opening stock will appear here.'
              : 'Stock levels are healthy across the catalogue.'
          }
          action={
            status === 'all' ? (
              <LinkButton href="/merchant/products/new" variant="primary">
                Add product
              </LinkButton>
            ) : (
              <LinkButton href="/merchant/inventory" variant="ghost">
                Show all products
              </LinkButton>
            )
          }
        />
      ) : (
        <InventoryTable rows={rows} />
      )}
    </main>
  );
}
