import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CheckIcon } from '@/components/ui/icons';
import { LinkButton, StatusPill } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api/response';
import { formatDateTime, formatPrice, pluralise } from '@/lib/format';
import { getOrder } from '@/lib/orders/queries';
import type { OrderStatus } from '@/types';

export const metadata: Metadata = {
  title: 'Order',
  robots: { index: false, follow: false },
};

/** The happy-path lifecycle. Cancelled and refunded orders skip the timeline. */
const TIMELINE: OrderStatus[] = ['confirmed', 'processing', 'shipped', 'delivered'];

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);

  let order;
  try {
    order = await getOrder(id);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const justPlaced = query.placed === '1';
  const currentStep = TIMELINE.indexOf(order.status);
  const isTerminal = order.status === 'cancelled' || order.status === 'refunded';

  return (
    <main className="mx-auto max-w-[1000px] px-5 pb-[110px] pt-8 md:px-8 md:pt-11">
      {justPlaced ? (
        <div className="mb-8 flex items-start gap-3.5 rounded-[16px] border border-[rgba(78,209,126,.3)] bg-[rgba(78,209,126,.06)] px-5 py-4.5">
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[rgba(78,209,126,.18)] text-[#4ED17E]">
            <CheckIcon size={12} />
          </span>
          <div>
            <div className="text-[15px] font-medium text-[#4ED17E]">Order placed</div>
            <p className="mb-0 mt-1.5 text-[13.5px] leading-relaxed text-[#9A9AA2]">
              Your stock is reserved. This is a Phase 1 test order — no payment was taken.
            </p>
          </div>
        </div>
      ) : null}

      <nav aria-label="Breadcrumb" className="mb-6 flex items-center gap-2 text-[13px] text-[#6E6E76]">
        <Link href="/orders" className="text-[#6E6E76] hover:text-white">
          Orders
        </Link>
        <span>/</span>
        <span className="font-mono text-[#B9B9C0]">{order.orderNumber}</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="m-0 font-mono text-[24px] font-semibold leading-none tracking-[-0.02em] md:text-[28px]">
            {order.orderNumber}
          </h1>
          <p className="mb-0 mt-3 text-[14px] text-[#7E7E88]">
            Placed {formatDateTime(order.placedAt)} · {order.itemCount}{' '}
            {pluralise(order.itemCount, 'item')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={order.paymentStatus} />
          <StatusPill status={order.status} />
        </div>
      </div>

      {!isTerminal ? (
        <ol className="mb-9 flex list-none flex-wrap gap-2 p-0 sm:flex-nowrap">
          {TIMELINE.map((step, index) => {
            const done = currentStep >= index;
            return (
              <li key={step} className="min-w-[120px] flex-1">
                <div
                  className={`h-1 rounded-full ${done ? 'brand-gradient' : 'bg-white/8'}`}
                  aria-hidden="true"
                />
                <div
                  className={`mt-2.5 text-[12.5px] capitalize ${done ? 'text-[#EDEDF0]' : 'text-[#4E4E56]'}`}
                >
                  {step}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="mb-9 rounded-[14px] border border-[rgba(255,107,107,.25)] bg-[rgba(255,107,107,.04)] px-5 py-4 text-[14px] text-[#FF8B8B]">
          This order was {order.status}. Any reserved stock has been returned to the shelf.
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_340px]">
        <section className="overflow-hidden rounded-[18px] border border-white/8">
          {order.items.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-4 border-b border-white/6 p-5 last:border-b-0 sm:flex-nowrap"
            >
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-[11px] bg-[#121216]">
                {item.imageUrl ? (
                  <Image
                    src={item.imageUrl}
                    alt={item.productName}
                    fill
                    sizes="64px"
                    className="object-cover"
                  />
                ) : null}
              </div>

              <div className="min-w-0 flex-1">
                {item.brand ? (
                  <div className="font-mono text-[11px] uppercase leading-none tracking-[0.1em] text-[#7E7E88]">
                    {item.brand}
                  </div>
                ) : null}
                <div className="mt-2 text-[15px] font-medium leading-[1.3]">
                  {item.productSlug ? (
                    <Link
                      href={`/products/${item.productSlug}`}
                      className="text-white hover:text-[#FFC07A]"
                    >
                      {item.productName}
                    </Link>
                  ) : (
                    item.productName
                  )}
                </div>
                <div className="mt-2 text-[13px] text-[#7E7E88]">
                  Qty {item.quantity} · {formatPrice(item.unitPrice)} each
                  {item.sku ? ` · SKU ${item.sku}` : ''}
                </div>
              </div>

              <div className="shrink-0 text-[16px] font-semibold">
                {formatPrice(item.totalPrice)}
              </div>
            </div>
          ))}
          <p className="m-0 border-t border-white/6 px-5 py-3.5 text-[12.5px] text-[#4E4E56]">
            Prices shown are what you paid at the time of the order, not today&apos;s catalogue
            price.
          </p>
        </section>

        <aside className="flex flex-col gap-3.5">
          <div className="rounded-[18px] border border-white/8 bg-[#08080A] p-6">
            <div className="mb-4.5 text-[16px] font-semibold">Payment summary</div>
            <div className="flex flex-col gap-3 text-[14px] text-[#9A9AA2]">
              <Row label="Subtotal" value={formatPrice(order.subtotal)} />
              {order.discountAmount > 0 ? (
                <Row label="Discount" value={`−${formatPrice(order.discountAmount)}`} accent />
              ) : null}
              <Row
                label="Delivery"
                value={order.shippingAmount === 0 ? 'Free' : formatPrice(order.shippingAmount)}
                accent={order.shippingAmount === 0}
              />
              {order.taxAmount > 0 ? (
                <Row label="Tax" value={formatPrice(order.taxAmount)} />
              ) : null}
            </div>
            <div className="my-5 h-px bg-white/8" />
            <div className="flex items-baseline justify-between">
              <span className="text-[15px] font-medium">Total</span>
              <span className="text-[22px] font-semibold">{formatPrice(order.total)}</span>
            </div>
            <div className="mt-3 text-[12.5px] capitalize text-[#6E6E76]">
              {order.paymentMethod.replace(/_/g, ' ')} · {order.paymentStatus}
            </div>
          </div>

          <div className="rounded-[18px] border border-white/8 bg-[#08080A] p-6">
            <div className="mb-4 text-[16px] font-semibold">Delivery address</div>
            <address className="not-italic text-[14px] leading-[1.75] text-[#9A9AA2]">
              <span className="text-[#EDEDF0]">{order.shippingAddress.fullName}</span>
              <br />
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
              {order.shippingAddress.phone}
            </address>
          </div>

          <LinkButton href="/products" variant="ghost" fullWidth>
            Continue shopping
          </LinkButton>
        </aside>
      </div>
    </main>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      <span className={accent ? 'text-[#4ED17E]' : 'text-white'}>{value}</span>
    </div>
  );
}
