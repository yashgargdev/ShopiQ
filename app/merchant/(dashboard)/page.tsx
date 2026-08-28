import Link from 'next/link';

import { StatCard } from '@/components/merchant/StatCard';
import { AlertIcon, ChevronRightIcon } from '@/components/ui/icons';
import { EmptyState, LinkButton, StatusPill } from '@/components/ui/primitives';
import { formatCompactPrice, formatDate, formatNumber, formatPrice } from '@/lib/format';
import { getDashboardStats, listInventory } from '@/lib/merchant/queries';
import { listAllOrders } from '@/lib/orders/queries';

export const metadata = { title: 'Overview' };

export default async function MerchantOverviewPage() {
  const [stats, { orders }, { rows: inventory }] = await Promise.all([
    getDashboardStats(),
    listAllOrders({ limit: 5 }),
    listInventory({ status: 'all', limit: 200 }),
  ]);

  const needsAttention = inventory
    .filter((row) => row.isActive && row.status !== 'healthy')
    .slice(0, 6);

  return (
    <main className="px-5 pb-16 pt-7 md:px-8 md:pt-9">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-[28px] font-semibold leading-none tracking-[-0.03em]">
            Overview
          </h1>
          <p className="mb-0 mt-3 text-[14px] text-[#7E7E88]">
            Every figure here is read from live data — nothing is simulated.
          </p>
        </div>
        <LinkButton href="/merchant/products/new" variant="primary">
          Add product
        </LinkButton>
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total revenue"
          value={stats.totalRevenue > 0 ? formatCompactPrice(stats.totalRevenue) : '₹0'}
          hint={
            stats.totalOrders === 0
              ? 'No orders yet'
              : `Across ${formatNumber(stats.totalOrders)} orders`
          }
        />
        <StatCard
          label="Orders"
          value={formatNumber(stats.totalOrders)}
          hint={
            stats.openOrders > 0 ? `${stats.openOrders} awaiting fulfilment` : 'Nothing open'
          }
        />
        <StatCard
          label="Average order value"
          value={stats.averageOrderValue > 0 ? formatPrice(stats.averageOrderValue) : '—'}
          hint={stats.totalOrders === 0 ? 'Needs at least one order' : undefined}
        />
        <StatCard
          label="Active products"
          value={formatNumber(stats.activeProducts)}
          hint={`${formatNumber(stats.totalProducts)} total · ${formatNumber(stats.totalCategories)} categories`}
        />
      </div>

      <div className="mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Units on hand"
          value={formatNumber(stats.unitsOnHand)}
          hint="Across every product"
        />
        <StatCard
          label="Low stock"
          value={formatNumber(stats.lowStockProducts)}
          tone={stats.lowStockProducts > 0 ? 'warn' : 'default'}
          hint="At or below reorder point"
          icon={stats.lowStockProducts > 0 ? <AlertIcon size={13} /> : undefined}
        />
        <StatCard
          label="Out of stock"
          value={formatNumber(stats.outOfStockProducts)}
          tone={stats.outOfStockProducts > 0 ? 'danger' : 'default'}
          hint="Active products with nothing available"
        />
        <StatCard
          label="Cancelled / refunded"
          value={formatNumber(stats.cancelledOrders)}
          hint="Excluded from revenue"
        />
      </div>

      <div className="mt-10 grid grid-cols-1 items-start gap-5 xl:grid-cols-[1.3fr_1fr]">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="m-0 text-[18px] font-semibold tracking-[-0.02em]">Recent orders</h2>
            <Link
              href="/merchant/orders"
              className="flex items-center gap-1.5 text-[13.5px] text-[#F7931E] hover:text-[#FFB65C]"
            >
              All orders <ChevronRightIcon size={12} />
            </Link>
          </div>

          {orders.length === 0 ? (
            <EmptyState
              title="No orders yet"
              description="Place a test order from the storefront and it will appear here, with its stock reserved."
              action={
                <LinkButton href="/products" variant="ghost">
                  Open the storefront
                </LinkButton>
              }
            />
          ) : (
            <div className="overflow-hidden rounded-[16px] border border-white/8">
              {orders.map((order) => (
                <Link
                  key={order.id}
                  href={`/merchant/orders/${order.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/6 px-5 py-4 transition-colors last:border-b-0 hover:bg-[#0C0C0E]"
                >
                  <span className="font-mono text-[13px] text-[#C6C6CC]">
                    {order.orderNumber}
                  </span>
                  <span className="text-[13px] text-[#6E6E76]">{formatDate(order.placedAt)}</span>
                  <span className="ml-auto text-[15px] font-semibold">
                    {formatPrice(order.total)}
                  </span>
                  <StatusPill status={order.status} />
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="m-0 text-[18px] font-semibold tracking-[-0.02em]">Needs attention</h2>
            <Link
              href="/merchant/inventory"
              className="flex items-center gap-1.5 text-[13.5px] text-[#F7931E] hover:text-[#FFB65C]"
            >
              Inventory <ChevronRightIcon size={12} />
            </Link>
          </div>

          {needsAttention.length === 0 ? (
            <div className="rounded-[16px] border border-[rgba(78,209,126,.22)] bg-[rgba(78,209,126,.04)] px-5 py-8 text-center">
              <div className="text-[15px] font-medium text-[#4ED17E]">Stock looks healthy</div>
              <p className="mb-0 mt-2 text-[13.5px] text-[#7E7E88]">
                No active product is low or out of stock.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-[16px] border border-white/8">
              {needsAttention.map((row) => (
                <Link
                  key={row.productId}
                  href="/merchant/inventory"
                  className="flex items-center gap-3 border-b border-white/6 px-5 py-3.5 transition-colors last:border-b-0 hover:bg-[#0C0C0E]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">{row.name}</div>
                    <div className="mt-1 font-mono text-[11.5px] text-[#6E6E76]">{row.sku}</div>
                  </div>
                  <span
                    className={
                      row.status === 'out_of_stock'
                        ? 'shrink-0 text-[13px] font-medium text-[#FF8B8B]'
                        : 'shrink-0 text-[13px] font-medium text-[#FFB65C]'
                    }
                  >
                    {row.available} left
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
