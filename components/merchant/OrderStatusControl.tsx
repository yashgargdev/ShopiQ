'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { InlineAlert } from '@/components/ui/primitives';
import { cx } from '@/lib/format';
import { ORDER_STATUS_VALUES } from '@/lib/validation/schemas';
import type { OrderStatus } from '@/types';

/**
 * Moves an order through its lifecycle. Each transition also moves stock:
 * shipping consumes the reservation, cancelling releases it — both inside one
 * database transaction, so the two can never drift apart.
 */

const EXPLAIN: Record<string, string> = {
  shipped: 'Marking as shipped removes the reserved units from stock permanently.',
  delivered: 'Delivered keeps the stock consumed.',
  cancelled: 'Cancelling returns the reserved units to available stock.',
  refunded: 'Refunding returns the units to stock and marks the payment refunded.',
};

export function OrderStatusControl({
  orderId,
  status,
}: {
  orderId: string;
  status: OrderStatus;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = async (next: OrderStatus) => {
    if (next === status || pending) return;

    setPending(next);
    setError(null);

    try {
      const response = await fetch(`/api/merchant/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? 'Could not update the order.');
      } else {
        router.refresh();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div>
      <div className="mb-3 text-[12.5px] uppercase tracking-[0.08em] text-[#6E6E76]">
        Update status
      </div>

      <div className="flex flex-wrap gap-2">
        {ORDER_STATUS_VALUES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => change(value)}
            disabled={pending !== null}
            className={cx(
              'rounded-full px-3.5 py-2 text-[13px] capitalize leading-none transition-colors disabled:opacity-50',
              value === status
                ? 'brand-gradient font-medium text-[#1A0D02]'
                : 'border border-white/12 text-[#B9B9C0] hover:border-white/28 hover:text-white',
            )}
          >
            {pending === value ? 'Saving…' : value}
          </button>
        ))}
      </div>

      {EXPLAIN[status] ? (
        <p className="mb-0 mt-3.5 text-[12.5px] leading-relaxed text-[#6E6E76]">
          {EXPLAIN[status]}
        </p>
      ) : null}

      {error ? (
        <div className="mt-3.5">
          <InlineAlert tone="error">{error}</InlineAlert>
        </div>
      ) : null}
    </div>
  );
}
