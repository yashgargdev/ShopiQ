import { formatOrderNumber } from '@/lib/orders/number';
import 'server-only';
import { adminClient } from '@/lib/supabase/admin';
import { getSessionUser } from '@/lib/auth';
import { normalisePhone } from '@/lib/checkout/guest';
import { recordMoneyEvent } from '@/lib/payments/audit';
import { formatPrice } from '@/lib/format';

/**
 * Account and order-support tools.
 *
 * These are the first tools that touch a customer's PERSONAL data rather than
 * the catalogue, so one rule governs all of them:
 *
 *   **Identity is read from the session inside this file. It is never a
 *   parameter, so no tool signature has anywhere to put someone else's id.**
 *
 * A model that hallucinates `{"customer_id": "..."}` gets a schema rejection
 * because the field does not exist; a model that hallucinates an order number
 * gets NOT_FOUND because every lookup is scoped to the signed-in customer
 * before the id is even compared.
 */

export class NotSignedInError extends Error {
  constructor() {
    super('You need to sign in before I can look at your account.');
    this.name = 'NotSignedInError';
  }
}

/** The signed-in customer, or a refusal. Never returns someone else's id. */
async function requireCustomer(): Promise<string> {
  const user = await getSessionUser();
  if (!user) throw new NotSignedInError();
  return user.id;
}

/** Order statuses a customer is allowed to cancel from. */
const CANCELLABLE = new Set(['pending', 'confirmed', 'processing']);

/** How long after delivery a return or replacement can be asked for. */
const RETURN_WINDOW_DAYS = 7;

// ---------------------------------------------------------------- profile

export interface ProfileView {
  full_name: string | null;
  email: string | null;
  phone: string | null;
  default_address: Record<string, unknown> | null;
}

export async function getProfile(): Promise<ProfileView> {
  const customerId = await requireCustomer();
  const db = adminClient();

  const { data: customer } = await db
    .from('customers')
    .select('full_name, email, phone')
    .eq('id', customerId)
    .maybeSingle();

  const { data: address } = await db
    .from('customer_addresses')
    .select('line1, line2, city, state, postal_code, country')
    .eq('customer_id', customerId)
    .eq('is_default', true)
    .maybeSingle();

  return {
    full_name: customer?.full_name ?? null,
    email: customer?.email ?? null,
    phone: customer?.phone ?? null,
    default_address: address ?? null,
  };
}

export interface ProfileUpdate {
  full_name?: string | null;
  phone?: string | null;
  address?: {
    line1: string;
    line2?: string | null;
    city: string;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
}

/**
 * Update the signed-in customer's own details.
 *
 * Note what cannot be changed here: the email address. It is the credential —
 * the only thing a one-time code is sent to — so letting the assistant rewrite
 * it would turn "edit my profile" into account takeover.
 */
export async function updateProfile(input: ProfileUpdate): Promise<{
  updated: string[];
  rejected: string[];
  profile: ProfileView;
}> {
  const customerId = await requireCustomer();
  const db = adminClient();

  const patch: Record<string, unknown> = {};
  const updated: string[] = [];
  const rejected: string[] = [];

  if (input.full_name !== undefined) {
    const name = (input.full_name ?? '').trim();
    if (name.length >= 2 && name.length <= 120) {
      patch.full_name = name;
      updated.push('name');
    } else if (name) {
      rejected.push('name');
    }
  }

  if (input.phone !== undefined) {
    const phone = normalisePhone(input.phone ?? '');
    if (phone) {
      patch.phone = phone;
      updated.push('phone');
    } else if ((input.phone ?? '').trim()) {
      rejected.push('phone');
    }
  }

  if (Object.keys(patch).length > 0) {
    patch.updated_at = new Date().toISOString();
    await db.from('customers').update(patch).eq('id', customerId);
  }

  if (input.address) {
    const address = input.address;
    if (address.line1?.trim() && address.city?.trim()) {
      // One default address per customer: the previous default is demoted
      // rather than leaving two rows both claiming to be it.
      await db
        .from('customer_addresses')
        .update({ is_default: false })
        .eq('customer_id', customerId);

      await db.from('customer_addresses').insert({
        customer_id: customerId,
        line1: address.line1.trim().slice(0, 200),
        line2: address.line2?.trim().slice(0, 200) ?? null,
        city: address.city.trim().slice(0, 100),
        state: address.state?.trim().slice(0, 100) ?? '',
        postal_code: address.postal_code?.trim().slice(0, 20) ?? '',
        country: address.country?.trim().slice(0, 60) || 'India',
        is_default: true,
      });
      updated.push('address');
    } else {
      rejected.push('address');
    }
  }

  return { updated, rejected, profile: await getProfile() };
}

// ----------------------------------------------------------------- orders

export interface OrderSummary {
  order_number: string;
  status: string;
  payment_status: string;
  total_display: string;
  placed_at: string;
  items: Array<{ name: string; quantity: number; price_display: string }>;
  can_cancel: boolean;
  can_return: boolean;
}

function toSummary(row: Record<string, any>): OrderSummary {
  const deliveredAt = row.status === 'delivered' ? Date.parse(row.updated_at ?? row.placed_at) : null;
  const withinWindow =
    deliveredAt !== null && Date.now() - deliveredAt <= RETURN_WINDOW_DAYS * 86_400_000;

  return {
    order_number: row.order_number,
    status: row.status,
    payment_status: row.payment_status,
    total_display: formatPrice(Number(row.total)),
    placed_at: row.placed_at,
    items: (row.order_items ?? []).map((item: any) => ({
      name: item.product_name,
      quantity: item.quantity,
      price_display: formatPrice(Number(item.total_price)),
    })),
    can_cancel: CANCELLABLE.has(row.status),
    can_return: withinWindow,
  };
}

const ORDER_COLUMNS =
  'id, order_number, status, payment_status, total, placed_at, updated_at, order_items ( product_name, quantity, total_price )';

/** The signed-in customer's orders, newest first. */
export async function listMyOrders(limit = 5): Promise<OrderSummary[]> {
  const customerId = await requireCustomer();
  const { data } = await adminClient()
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('customer_id', customerId)
    .order('placed_at', { ascending: false })
    .limit(Math.min(limit, 20));
  return (data ?? []).map(toSummary);
}

/**
 * One order by number.
 *
 * The customer filter is part of the query, not a check afterwards — so
 * another customer's order number simply matches nothing. It is reported as
 * "no such order", which is also all the caller is entitled to know.
 */
export async function getOrderByNumber(orderNumber: string): Promise<OrderSummary | null> {
  const customerId = await requireCustomer();
  const { data } = await adminClient()
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('customer_id', customerId)
    .ilike('order_number', orderNumber.trim())
    .maybeSingle();
  return data ? toSummary(data) : null;
}

export interface OrderActionResult {
  ok: boolean;
  order_number: string;
  status?: string;
  reason?: string;
  message: string;
}

/**
 * Cancel an order the customer owns.
 *
 * Uses `set_order_status()`, the same Phase 1 RPC the merchant panel uses, so
 * the inventory movement that goes with a cancellation happens exactly once
 * and under the same row locks. There is no second cancellation path.
 */
export async function cancelOrder(orderNumber: string): Promise<OrderActionResult> {
  const customerId = await requireCustomer();
  const db = adminClient();

  const { data: order } = await db
    .from('orders')
    .select('id, order_number, status')
    .eq('customer_id', customerId)
    .ilike('order_number', orderNumber.trim())
    .maybeSingle();

  if (!order) {
    return {
      ok: false,
      order_number: orderNumber,
      reason: 'NOT_FOUND',
      message: "I couldn't find that order on your account.",
    };
  }

  if (!CANCELLABLE.has(order.status)) {
    return {
      ok: false,
      order_number: order.order_number,
      status: order.status,
      reason: 'NOT_CANCELLABLE',
      message:
        order.status === 'cancelled'
          ? 'That order is already cancelled.'
          : `That order is already ${order.status}, so I can't cancel it here. I can start a return instead.`,
    };
  }

  const { error } = await db.rpc('set_order_status', {
    p_order_id: order.id,
    p_status: 'cancelled',
  });

  if (error) {
    return {
      ok: false,
      order_number: order.order_number,
      reason: 'FAILED',
      message: "I couldn't cancel that just now. Please try again.",
    };
  }

  await recordMoneyEvent({
    event: 'order_cancelled',
    customerId,
    orderId: order.id,
    detail: { order_number: order.order_number, via: 'agent' },
  });

  return {
    ok: true,
    order_number: order.order_number,
    status: 'cancelled',
    message: `Order ${formatOrderNumber(order.order_number)} has been cancelled. Any payment will be refunded to the original method.`,
  };
}

export type SupportKind = 'return' | 'replacement';

/**
 * Open a return or replacement request.
 *
 * This records the request; it does not move money. A refund is a merchant
 * decision with a payment consequence, and an assistant that could issue one
 * on request would be a far bigger authority than anything else in ShopiQ.
 */
export async function requestSupport(
  orderNumber: string,
  kind: SupportKind,
  reason: string,
): Promise<OrderActionResult> {
  const customerId = await requireCustomer();
  const db = adminClient();

  const { data: order } = await db
    .from('orders')
    .select('id, order_number, status, updated_at, placed_at')
    .eq('customer_id', customerId)
    .ilike('order_number', orderNumber.trim())
    .maybeSingle();

  if (!order) {
    return {
      ok: false,
      order_number: orderNumber,
      reason: 'NOT_FOUND',
      message: "I couldn't find that order on your account.",
    };
  }

  if (order.status !== 'delivered') {
    return {
      ok: false,
      order_number: order.order_number,
      status: order.status,
      reason: 'NOT_DELIVERED',
      message: `That order is ${order.status}. I can start a ${kind} once it has been delivered${CANCELLABLE.has(order.status) ? ', or cancel it now if you prefer' : ''}.`,
    };
  }

  const deliveredAt = Date.parse(order.updated_at ?? order.placed_at);
  if (Date.now() - deliveredAt > RETURN_WINDOW_DAYS * 86_400_000) {
    return {
      ok: false,
      order_number: order.order_number,
      reason: 'WINDOW_CLOSED',
      message: `The ${RETURN_WINDOW_DAYS}-day window for that order has closed, so I can't start a ${kind} automatically. Our support team can still help.`,
    };
  }

  const { data: existing } = await db
    .from('order_support_requests')
    .select('id, kind, status')
    .eq('order_id', order.id)
    .in('status', ['open', 'in_review'])
    .maybeSingle();

  if (existing) {
    return {
      ok: false,
      order_number: order.order_number,
      reason: 'ALREADY_OPEN',
      message: `There's already an open ${existing.kind} request for that order.`,
    };
  }

  const { error } = await db.from('order_support_requests').insert({
    order_id: order.id,
    customer_id: customerId,
    kind,
    reason: reason.trim().slice(0, 500),
    status: 'open',
  });

  if (error) {
    return {
      ok: false,
      order_number: order.order_number,
      reason: 'FAILED',
      message: `I couldn't start that ${kind} just now. Please try again.`,
    };
  }

  await recordMoneyEvent({
    event: kind === 'return' ? 'return_requested' : 'replacement_requested',
    customerId,
    orderId: order.id,
    detail: { order_number: order.order_number },
  });

  return {
    ok: true,
    order_number: order.order_number,
    message: `I've opened a ${kind} request for order ${formatOrderNumber(order.order_number)}. You'll get an email with the next steps.`,
  };
}
