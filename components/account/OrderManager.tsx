'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, LoadingCard, PageTitle, SignedOutNotice, inputClass } from './AccountNav';
import { cx } from '@/lib/format';

/**
 * Order management: status, cancellation, returns and replacements.
 *
 * `can_cancel` and `can_return` are computed by the SERVER from the order's
 * status and its delivery date. The page renders what it is told rather than
 * deciding for itself — otherwise the button and the rule behind it drift, and
 * a customer gets an action that fails when they press it.
 */

interface OrderItem {
  name: string;
  quantity: number;
  price_display: string;
}

interface Order {
  order_number: string;
  status: string;
  payment_status: string;
  total_display: string;
  placed_at: string;
  items: OrderItem[];
  can_cancel: boolean;
  can_return: boolean;
}

const STATUS_TONE: Record<string, string> = {
  pending: 'text-[#F7931E] border-[rgba(247,147,30,.35)] bg-[rgba(247,147,30,.07)]',
  confirmed: 'text-[#F7931E] border-[rgba(247,147,30,.35)] bg-[rgba(247,147,30,.07)]',
  processing: 'text-[#F7931E] border-[rgba(247,147,30,.35)] bg-[rgba(247,147,30,.07)]',
  shipped: 'text-[#7EA8FF] border-[rgba(126,168,255,.35)] bg-[rgba(126,168,255,.07)]',
  delivered: 'text-[#4ADE80] border-[rgba(74,222,128,.3)] bg-[rgba(74,222,128,.07)]',
  cancelled: 'text-[#FF8B8B] border-[rgba(255,107,107,.3)] bg-[rgba(255,107,107,.07)]',
  refunded: 'text-[#9A9AA2] border-white/12 bg-white/4',
};

/** The journey an order takes, for the tracker. */
const JOURNEY = ['confirmed', 'processing', 'shipped', 'delivered'];

export function OrderManager() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ order: string; text: string; ok: boolean } | null>(null);
  const [supportFor, setSupportFor] = useState<{ order: string; kind: 'return' | 'replacement' } | null>(null);
  const [reason, setReason] = useState('');
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/account/orders', { cache: 'no-store' });
    if (response.status === 401) {
      setSignedOut(true);
      setLoading(false);
      return;
    }
    const payload = await response.json().catch(() => null);
    setOrders(payload?.orders ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (orderNumber: string, action: 'cancel' | 'return' | 'replacement', why?: string) => {
      setBusy(orderNumber);
      setNotice(null);

      const response = await fetch('/api/account/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, orderNumber, ...(why ? { reason: why } : {}) }),
      });
      const payload = await response.json().catch(() => null);
      setBusy(null);

      if (response.status === 401) {
        setSignedOut(true);
        return;
      }

      setNotice({
        order: orderNumber,
        text: payload?.message ?? payload?.error?.message ?? 'Something went wrong.',
        ok: Boolean(payload?.ok),
      });
      if (payload?.orders) setOrders(payload.orders);
      setConfirmCancel(null);
      setSupportFor(null);
      setReason('');
    },
    [],
  );

  if (loading) return <LoadingCard label="Loading your orders…" />;

  if (signedOut) return <SignedOutNotice what="your orders" />;

  if (orders.length === 0) {
    return (
      <>
        <PageTitle title="My orders" />
        <Card className="mx-auto max-w-md text-center">
          <p className="m-0 text-[16px] font-medium text-white">No orders yet</p>
          <p className="m-0 mt-2 text-[13.5px] leading-relaxed text-[#8A8A93]">
            Tell ShopiQ what you need and it will find it for you.
          </p>
        </Card>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle
        title="My orders"
        subtitle={`${orders.length} order${orders.length === 1 ? '' : 's'}`}
      />

      {orders.map((order) => {
        const stage = JOURNEY.indexOf(order.status);
        const cancelled = order.status === 'cancelled';

        return (
          <Card key={order.order_number} className="max-w-4xl">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="m-0 font-mono text-[14px] text-[#F7931E]">{order.order_number}</p>
                <p className="m-0 mt-1 text-[12.5px] text-[#7E7E88]">
                  {new Date(order.placed_at).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                  {' · '}
                  {order.payment_status === 'paid' ? 'Paid' : order.payment_status}
                </p>
              </div>
              <div className="text-right">
                <span
                  className={cx(
                    'inline-block rounded-full border px-2.5 py-1 text-[11.5px] font-medium capitalize',
                    STATUS_TONE[order.status] ?? 'border-white/12 text-[#9A9AA2]',
                  )}
                >
                  {order.status}
                </span>
                <p className="m-0 mt-1.5 text-[15px] font-semibold text-white">
                  {order.total_display}
                </p>
              </div>
            </div>

            {/* Tracker — hidden once cancelled, where a progress bar would lie. */}
            {!cancelled && stage >= 0 ? (
              <div className="mt-4 flex items-center gap-1.5" aria-label={`Status: ${order.status}`}>
                {JOURNEY.map((step, index) => (
                  <div key={step} className="flex flex-1 flex-col gap-1.5">
                    <div
                      className={cx(
                        'h-1 rounded-full',
                        index <= stage ? 'bg-[#F7931E]' : 'bg-white/10',
                      )}
                    />
                    <span
                      className={cx(
                        'text-[10.5px] capitalize',
                        index <= stage ? 'text-[#C6C6CC]' : 'text-[#5E5E66]',
                      )}
                    >
                      {step}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <ul className="mt-4 flex flex-col gap-1.5 border-t border-white/7 pt-3.5">
              {order.items.map((item, index) => (
                <li key={index} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-[#EDEDF0]">{item.name}</span>
                  <span className="shrink-0 text-[#7E7E88]">×{item.quantity}</span>
                  <span className="shrink-0 text-white">{item.price_display}</span>
                </li>
              ))}
            </ul>

            {notice?.order === order.order_number ? (
              <p
                className={cx(
                  'mt-3 text-[12.5px] leading-snug',
                  notice.ok ? 'text-[#4ADE80]' : 'text-[#FF8B8B]',
                )}
              >
                {notice.text}
              </p>
            ) : null}

            {supportFor?.order === order.order_number ? (
              <div className="mt-3.5 rounded-[12px] border border-white/10 bg-[#08080A] p-3.5">
                <p className="m-0 mb-2 text-[13px] font-medium text-white">
                  What went wrong with this {supportFor.kind === 'return' ? 'order' : 'item'}?
                </p>
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. Screen has a dead pixel"
                  maxLength={500}
                  className={inputClass}
                />
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={reason.trim().length < 3 || busy === order.order_number}
                    onClick={() => void act(order.order_number, supportFor.kind, reason)}
                    className="h-9 rounded-full brand-gradient px-4 text-[13px] font-semibold text-[#1A0D02] disabled:opacity-50"
                  >
                    Submit request
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSupportFor(null);
                      setReason('');
                    }}
                    className="h-9 rounded-full border border-white/12 px-4 text-[13px] text-[#C6C6CC] hover:border-white/28"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {(order.can_cancel || order.can_return) && !supportFor ? (
              <div className="mt-3.5 flex flex-wrap gap-2 border-t border-white/7 pt-3.5">
                {order.can_cancel ? (
                  confirmCancel === order.order_number ? (
                    <>
                      <Action
                        tone="danger"
                        disabled={busy === order.order_number}
                        onClick={() => void act(order.order_number, 'cancel')}
                      >
                        {busy === order.order_number ? 'Cancelling…' : 'Yes, cancel it'}
                      </Action>
                      <Action onClick={() => setConfirmCancel(null)}>Keep order</Action>
                    </>
                  ) : (
                    <Action tone="danger" onClick={() => setConfirmCancel(order.order_number)}>
                      Cancel order
                    </Action>
                  )
                ) : null}

                {order.can_return ? (
                  <>
                    <Action
                      onClick={() => setSupportFor({ order: order.order_number, kind: 'return' })}
                    >
                      Return
                    </Action>
                    <Action
                      onClick={() =>
                        setSupportFor({ order: order.order_number, kind: 'replacement' })
                      }
                    >
                      Replacement
                    </Action>
                  </>
                ) : null}
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

function Action({
  children,
  onClick,
  disabled,
  tone = 'default',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'h-9 rounded-full border px-4 text-[13px] font-medium transition-colors disabled:opacity-50',
        tone === 'danger'
          ? 'border-[rgba(255,107,107,.3)] text-[#FF8B8B] hover:border-[rgba(255,107,107,.55)]'
          : 'border-white/12 text-[#C6C6CC] hover:border-white/28 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}
