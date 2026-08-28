import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { OrderStatusControl } from '@/components/merchant/OrderStatusControl';
import { StatusPill } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api/response';
import { formatDateTime, formatPrice, pluralise } from '@/lib/format';
import { getOrderAsMerchant } from '@/lib/orders/queries';

export const metadata = { title: 'Order detail' };

export default async function MerchantOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let order;
  try {
    order = await getOrderAsMerchant(id);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  return (
    <main className="px-5 pb-16 pt-7 md:px-8 md:pt-9">
      <nav
        aria-label="Breadcrumb"
        className="mb-5 flex items-center gap-2 text-[13px] text-[#6E6E76]"
      >
        <Link href="/merchant/orders" className="text-[#6E6E76] hover:text-white">
          Orders
        </Link>
        <span>/</span>
        <span className="font-mono text-[#B9B9C0]">{order.orderNumber}</span>
      </nav>

      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="m-0 font-mono text-[24px] font-semibold leading-none tracking-[-0.02em]">
            {order.orderNumber}
          </h1>
          <p className="mb-0 mt-3 text-[13.5px] text-[#7E7E88]">
            {formatDateTime(order.placedAt)} · {order.itemCount}{' '}
            {pluralise(order.itemCount, 'item')} · {order.paymentMethod.replace(/_/g, ' ')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={order.paymentStatus} />
          <StatusPill status={order.status} />
        </div>
      </div>

      <div className="mb-6 rounded-[16px] border border-white/8 bg-[#08080A] p-5 md:p-6">
        <OrderStatusControl orderId={order.id} status={order.status} />
      </div>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[1.4fr_1fr]">
        <section className="overflow-hidden rounded-[16px] border border-white/8">
          <div className="border-b border-white/8 bg-[#0A0A0C] px-5 py-3 text-[11.5px] font-medium uppercase tracking-[0.08em] text-[#6E6E76]">
            Items
          </div>
          {order.items.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-4 border-b border-white/6 px-5 py-4 last:border-b-0 sm:flex-nowrap"
            >
              <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[9px] bg-[#121216]">
                {item.imageUrl ? (
                  <Image
                    src={item.imageUrl}
                    alt=""
                    fill
                    sizes="48px"
                    className="object-cover"
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium leading-tight">
                  {item.productId ? (
                    <Link
                      href={`/merchant/products/${item.productId}`}
                      className="text-white hover:text-[#FFC07A]"
                    >
                      {item.productName}
                    </Link>
                  ) : (
                    <span className="text-[#9A9AA2]">
                      {item.productName} <span className="text-[#6E6E76]">(product removed)</span>
                    </span>
                  )}
                </div>
                <div className="mt-1.5 font-mono text-[11.5px] text-[#6E6E76]">
                  {item.sku ?? '—'} · {formatPrice(item.unitPrice)} × {item.quantity}
                </div>
              </div>
              <div className="shrink-0 text-[15px] font-semibold">
                {formatPrice(item.totalPrice)}
              </div>
            </div>
          ))}
          <p className="m-0 bg-[#0A0A0C] px-5 py-3 text-[12px] text-[#4E4E56]">
            Line prices are snapshots taken when the order was placed.
          </p>
        </section>

        <div className="flex flex-col gap-4">
          <section className="rounded-[16px] border border-white/8 bg-[#08080A] p-6">
            <div className="mb-4 text-[16px] font-semibold">Totals</div>
            <div className="flex flex-col gap-3 text-[14px] text-[#9A9AA2]">
              <Row label="Subtotal" value={formatPrice(order.subtotal)} />
              {order.discountAmount > 0 ? (
                <Row label="Discount" value={`−${formatPrice(order.discountAmount)}`} />
              ) : null}
              <Row
                label="Delivery"
                value={order.shippingAmount === 0 ? 'Free' : formatPrice(order.shippingAmount)}
              />
              {order.taxAmount > 0 ? <Row label="Tax" value={formatPrice(order.taxAmount)} /> : null}
            </div>
            <div className="my-5 h-px bg-white/8" />
            <div className="flex items-baseline justify-between">
              <span className="text-[15px] font-medium">Total</span>
              <span className="text-[22px] font-semibold">{formatPrice(order.total)}</span>
            </div>
          </section>

          <section className="rounded-[16px] border border-white/8 bg-[#08080A] p-6">
            <div className="mb-4 text-[16px] font-semibold">Customer</div>
            <address className="not-italic text-[14px] leading-[1.75] text-[#9A9AA2]">
              <span className="text-[#EDEDF0]">{order.shippingAddress.fullName}</span>
              <br />
              {order.contactEmail}
              <br />
              {order.contactPhone ?? order.shippingAddress.phone}
            </address>

            <div className="my-4 h-px bg-white/8" />

            <div className="mb-2 text-[12.5px] uppercase tracking-[0.08em] text-[#6E6E76]">
              Ship to
            </div>
            <address className="not-italic text-[14px] leading-[1.75] text-[#9A9AA2]">
              {order.shippingAddress.line1}
              <br />
              {order.shippingAddress.line2 ? (
                <>
                  {order.shippingAddress.line2}
                  <br />
                </>
              ) : null}
              {order.shippingAddress.city}, {order.shippingAddress.state}{' '}
              {order.shippingAddress.postalCode}
              <br />
              {order.shippingAddress.country}
            </address>

            {order.notes ? (
              <>
                <div className="my-4 h-px bg-white/8" />
                <div className="mb-2 text-[12.5px] uppercase tracking-[0.08em] text-[#6E6E76]">
                  Delivery notes
                </div>
                <p className="m-0 text-[14px] leading-relaxed text-[#9A9AA2]">{order.notes}</p>
              </>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      <span className="text-white">{value}</span>
    </div>
  );
}
