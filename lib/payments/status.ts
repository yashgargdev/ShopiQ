import 'server-only';
import { adminClient } from '@/lib/supabase/admin';
import { formatMinorUnits } from './money';

/**
 * Read-only views over payment and order state, for the AI tools and the UI.
 *
 * Everything here comes from the database. The assistant is never in a
 * position to describe a payment from memory, which is what stops it saying
 * "your payment went through" about a payment that is still unverified.
 */

/** What the assistant is allowed to say for each stored status. */
const PAYMENT_PHRASING: Record<string, { settled: boolean; say: string }> = {
  created: { settled: false, say: 'Your payment has been prepared but not completed yet.' },
  pending: { settled: false, say: 'Your payment is still in progress.' },
  authorized: { settled: false, say: 'Your payment is authorized and being finalised.' },
  captured: { settled: true, say: 'Your payment went through.' },
  failed: { settled: false, say: "The payment wasn't completed." },
  cancelled: { settled: false, say: 'That payment was cancelled, so nothing was charged.' },
  refunded: { settled: true, say: 'That payment was refunded.' },
  verification_pending: { settled: false, say: 'Your payment is still being verified.' },
};

export interface PaymentView {
  payment_id: string;
  status: string;
  settled: boolean;
  statement: string;
  amount_minor: number;
  amount_display: string;
  currency: string;
  provider: string;
  order_id: string | null;
  order_number: string | null;
  failure_reason: string | null;
  created_at: string;
}

export async function getPaymentStatus(
  customerId: string,
  paymentId?: string | null,
): Promise<PaymentView | null> {
  const db = adminClient();
  let query = db
    .from('payments')
    .select(
      'id, status, amount_minor, currency, provider, order_id, failure_reason, created_at, orders(order_number)',
    )
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (paymentId) query = query.eq('id', paymentId);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const phrasing = PAYMENT_PHRASING[data.status] ?? {
    settled: false,
    say: 'Your payment status is still being determined.',
  };

  return {
    payment_id: data.id,
    status: data.status,
    settled: phrasing.settled,
    statement: phrasing.say,
    amount_minor: Number(data.amount_minor),
    amount_display: formatMinorUnits(Number(data.amount_minor)),
    currency: data.currency,
    provider: data.provider,
    order_id: data.order_id ?? null,
    order_number: (data as any).orders?.order_number ?? null,
    failure_reason: data.failure_reason ?? null,
    created_at: data.created_at,
  };
}

export interface OrderView {
  order_id: string;
  order_number: string;
  status: string;
  payment_status: string;
  confirmed: boolean;
  total_display: string;
  total: number;
  currency: string;
  placed_at: string;
  items: Array<{
    name: string;
    brand: string | null;
    quantity: number;
    unit_price: number;
    unit_price_display: string;
    total_price: number;
  }>;
}

/** The customer's most recent order, or a named one they own. */
export async function getOrderStatus(
  customerId: string,
  orderId?: string | null,
): Promise<OrderView | null> {
  const db = adminClient();
  let query = db
    .from('orders')
    .select(
      `id, order_number, status, payment_status, total, currency, placed_at,
       order_items ( product_name, brand, quantity, unit_price, total_price )`,
    )
    .eq('customer_id', customerId)
    .order('placed_at', { ascending: false })
    .limit(1);

  if (orderId) query = query.eq('id', orderId);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const total = Number(data.total);
  return {
    order_id: data.id,
    order_number: data.order_number,
    status: data.status,
    payment_status: data.payment_status,
    // "Confirmed" means paid AND not cancelled — not merely that a row exists.
    confirmed: data.payment_status === 'paid' && data.status !== 'cancelled',
    total,
    total_display: formatMinorUnits(Math.round(total * 100)),
    currency: data.currency,
    placed_at: data.placed_at,
    items: ((data as any).order_items ?? []).map((item: any) => ({
      name: item.product_name,
      brand: item.brand ?? null,
      quantity: item.quantity,
      unit_price: Number(item.unit_price),
      unit_price_display: formatMinorUnits(Math.round(Number(item.unit_price) * 100)),
      total_price: Number(item.total_price),
    })),
  };
}
