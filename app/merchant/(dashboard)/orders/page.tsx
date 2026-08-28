import Link from 'next/link';

import { EmptyState, LinkButton, StatusPill } from '@/components/ui/primitives';
import { cx, formatDate, formatNumber, formatPrice, pluralise } from '@/lib/format';
import { listAllOrders } from '@/lib/orders/queries';
import { ORDER_STATUS_VALUES } from '@/lib/validation/schemas';
import type { OrderStatus } from '@/types';

export const metadata = { title: 'Orders' };

export default async function MerchantOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const statusParam = typeof params.status === 'string' ? params.status : undefined;
  const status = ORDER_STATUS_VALUES.includes(statusParam as OrderStatus)
    ? (statusParam as OrderStatus)
    : undefined;

  const page = Math.max(Number(typeof params.page === 'string' ? params.page : 1) || 1, 1);
  const limit = 25;

  const { orders, total } = await listAllOrders({ status, limit, offset: (page - 1) * limit });
  const totalPages = Math.max(Math.ceil(total / limit), 1);

  return (
    <main className="px-5 pb-16 pt-7 md:px-8 md:pt-9">
      <div className="mb-7">
        <h1 className="m-0 text-[28px] font-semibold leading-none tracking-[-0.03em]">Orders</h1>
        <p className="mb-0 mt-3 text-[14px] text-[#7E7E88]">
          {formatNumber(total)} {pluralise(total, 'order')}
          {status ? ` · filtered by ${status}` : ''}
        </p>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        <Link
          href="/merchant/orders"
          className={cx(
            'rounded-full px-3.5 py-2 text-[13px] leading-none transition-colors',
            !status
              ? 'bg-white font-medium text-black'
              : 'border border-white/12 text-[#B9B9C0] hover:border-white/25 hover:text-white',
          )}
        >
          All
        </Link>
        {ORDER_STATUS_VALUES.map((value) => (
          <Link
            key={value}
            href={`/merchant/orders?status=${value}`}
            className={cx(
              'rounded-full px-3.5 py-2 text-[13px] capitalize leading-none transition-colors',
              status === value
                ? 'bg-white font-medium text-black'
                : 'border border-white/12 text-[#B9B9C0] hover:border-white/25 hover:text-white',
            )}
          >
            {value}
          </Link>
        ))}
      </div>

      {orders.length === 0 ? (
        <EmptyState
          title={status ? `No ${status} orders` : 'No orders yet'}
          description={
            status
              ? 'Nothing in the catalogue is in that state right now.'
              : 'Place a test order from the storefront to see the full flow, including stock reservation.'
          }
          action={
            status ? (
              <LinkButton href="/merchant/orders" variant="ghost">
                Show all orders
              </LinkButton>
            ) : (
              <LinkButton href="/products" variant="ghost">
                Open the storefront
              </LinkButton>
            )
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[16px] border border-white/8">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr className="border-b border-white/8 bg-[#0A0A0C]">
                <Th>Order</Th>
                <Th>Customer</Th>
                <Th className="text-right">Items</Th>
                <Th className="text-right">Total</Th>
                <Th>Payment</Th>
                <Th>Status</Th>
                <Th className="text-right">Date</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr
                  key={order.id}
                  className="border-b border-white/6 transition-colors last:border-b-0 hover:bg-[#0A0A0C]"
                >
                  <td className="px-4 py-3 font-mono text-[13px] text-[#EDEDF0]">
                    {order.orderNumber}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-[13.5px] text-[#EDEDF0]">
                      {order.shippingAddress.fullName}
                    </div>
                    <div className="mt-1 truncate text-[12px] text-[#6E6E76]">
                      {order.contactEmail}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-[13.5px] text-[#9A9AA2]">
                    {order.itemCount}
                  </td>
                  <td className="px-4 py-3 text-right text-[14px] font-semibold">
                    {formatPrice(order.total)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={order.paymentStatus} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={order.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-[12.5px] text-[#6E6E76]">
                    {formatDate(order.placedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/merchant/orders/${order.id}`}
                      className="inline-flex h-8 items-center rounded-[8px] border border-white/12 px-3 text-[12.5px] text-[#C6C6CC] transition-colors hover:border-white/28 hover:text-white"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="mt-6 flex justify-center gap-2">
          {Array.from({ length: totalPages }, (_, index) => index + 1).map((entry) => (
            <Link
              key={entry}
              href={`/merchant/orders?${new URLSearchParams({
                ...(status ? { status } : {}),
                ...(entry > 1 ? { page: String(entry) } : {}),
              }).toString()}`}
              className={
                entry === page
                  ? 'grid h-9 min-w-9 place-items-center rounded-[9px] brand-gradient px-2.5 text-[13.5px] font-semibold text-[#1A0D02]'
                  : 'grid h-9 min-w-9 place-items-center rounded-[9px] border border-white/12 px-2.5 text-[13.5px] text-[#C6C6CC] hover:border-white/28'
              }
            >
              {entry}
            </Link>
          ))}
        </div>
      ) : null}
    </main>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-3 text-[11.5px] font-medium uppercase tracking-[0.08em] text-[#6E6E76] ${className ?? ''}`}
    >
      {children}
    </th>
  );
}
