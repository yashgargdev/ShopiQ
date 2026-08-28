import { StatCard } from '@/components/merchant/StatCard';
import { EmptyState, LinkButton } from '@/components/ui/primitives';
import { formatCompactPrice, formatDate, formatNumber, formatPrice } from '@/lib/format';
import { getDashboardStats } from '@/lib/merchant/queries';

export const metadata = { title: 'Analytics' };

/**
 * Every number on this page is computed from real rows by
 * public.merchant_dashboard_stats(). With no orders yet, the revenue panels
 * show an explicit empty state rather than invented figures.
 */
export default async function MerchantAnalyticsPage() {
  const stats = await getDashboardStats();
  const hasOrders = stats.totalOrders > 0;

  const maxRevenue = Math.max(...stats.recentRevenue.map((day) => Number(day.revenue)), 0);

  return (
    <main className="px-5 pb-16 pt-7 md:px-8 md:pt-9">
      <div className="mb-7">
        <h1 className="m-0 text-[28px] font-semibold leading-none tracking-[-0.03em]">Analytics</h1>
        <p className="mb-0 mt-3 text-[14px] text-[#7E7E88]">
          Live figures from the ShopiQ database. Cancelled and refunded orders are excluded from
          revenue.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total revenue"
          value={hasOrders ? formatCompactPrice(stats.totalRevenue) : '₹0'}
          hint={hasOrders ? formatPrice(stats.totalRevenue) : 'No orders yet'}
        />
        <StatCard
          label="Total orders"
          value={formatNumber(stats.totalOrders)}
          hint={`${formatNumber(stats.openOrders)} open · ${formatNumber(stats.cancelledOrders)} cancelled`}
        />
        <StatCard
          label="Average order value"
          value={hasOrders ? formatPrice(stats.averageOrderValue) : '—'}
          hint={hasOrders ? undefined : 'Needs at least one order'}
        />
        <StatCard
          label="Products"
          value={formatNumber(stats.totalProducts)}
          hint={`${formatNumber(stats.activeProducts)} active`}
        />
      </div>

      <div className="mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Units on hand" value={formatNumber(stats.unitsOnHand)} />
        <StatCard
          label="Low stock products"
          value={formatNumber(stats.lowStockProducts)}
          tone={stats.lowStockProducts > 0 ? 'warn' : 'default'}
        />
        <StatCard
          label="Out of stock"
          value={formatNumber(stats.outOfStockProducts)}
          tone={stats.outOfStockProducts > 0 ? 'danger' : 'default'}
        />
        <StatCard label="Categories" value={formatNumber(stats.totalCategories)} />
      </div>

      <section className="mt-10">
        <h2 className="m-0 mb-4 text-[18px] font-semibold tracking-[-0.02em]">
          Revenue, last 30 days
        </h2>

        {stats.recentRevenue.length === 0 ? (
          <EmptyState
            title="No revenue to chart yet"
            description="Once orders start coming in, daily revenue for the last 30 days appears here."
            action={
              <LinkButton href="/products" variant="ghost">
                Open the storefront
              </LinkButton>
            }
          />
        ) : (
          <div className="rounded-[16px] border border-white/8 bg-[#08080A] p-5 md:p-6">
            <div
              className="flex h-[200px] items-end gap-1.5 overflow-x-auto"
              role="img"
              aria-label={`Daily revenue for the last ${stats.recentRevenue.length} days with data`}
            >
              {stats.recentRevenue.map((day) => {
                const value = Number(day.revenue);
                const height = maxRevenue > 0 ? Math.max((value / maxRevenue) * 100, 3) : 3;
                return (
                  <div
                    key={day.day}
                    className="group flex min-w-[26px] flex-1 flex-col items-center justify-end gap-2"
                    title={`${formatDate(day.day)} · ${formatPrice(value)} · ${day.orders} orders`}
                  >
                    <span className="text-[10px] text-[#6E6E76] opacity-0 transition-opacity group-hover:opacity-100">
                      {formatCompactPrice(value)}
                    </span>
                    <div
                      className="w-full rounded-t-[4px] brand-gradient transition-opacity hover:opacity-80"
                      style={{ height: `${height}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex justify-between font-mono text-[11px] text-[#6E6E76]">
              <span>{formatDate(stats.recentRevenue[0].day)}</span>
              <span>{formatDate(stats.recentRevenue[stats.recentRevenue.length - 1].day)}</span>
            </div>
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="m-0 mb-4 text-[18px] font-semibold tracking-[-0.02em]">
          Top products by revenue
        </h2>

        {stats.topProducts.length === 0 ? (
          <EmptyState
            title="Nothing sold yet"
            description="Your best sellers will be ranked here as soon as orders exist."
          />
        ) : (
          <div className="overflow-hidden rounded-[16px] border border-white/8">
            {stats.topProducts.map((product, index) => (
              <div
                key={product.name}
                className="flex items-center gap-4 border-b border-white/6 px-5 py-4 last:border-b-0"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#141418] font-mono text-[12px] text-[#9A9AA2]">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                  {product.name}
                </span>
                <span className="shrink-0 text-[13px] text-[#7E7E88]">
                  {formatNumber(Number(product.units))} units
                </span>
                <span className="w-24 shrink-0 text-right text-[14px] font-semibold">
                  {formatPrice(Number(product.revenue))}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
