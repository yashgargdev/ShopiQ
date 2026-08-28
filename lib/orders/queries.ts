import 'server-only';

import { ApiError, badRequest, mapDatabaseError, notFound } from '@/lib/api/response';
import { ensureCustomerRecord } from '@/lib/auth';
import { adminClient } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { resolveCart } from '@/lib/cart/queries';
import type { Order, OrderItem, OrderStatus, SessionUser, ShippingAddress } from '@/types';

/**
 * Order reads and the checkout write path.
 *
 * Creation goes through public.create_order_from_cart(), which is the only
 * writer of public.orders. It re-reads every price from the catalogue and locks
 * the inventory rows inside one transaction, so the client cannot influence
 * what it is charged.
 */

const ORDER_SELECT = `
  id, order_number, status, payment_status, payment_method, subtotal, discount_amount,
  shipping_amount, tax_amount, total, currency, shipping_address, contact_email,
  contact_phone, notes, placed_at, created_at,
  items:order_items ( id, product_id, product_name, product_slug, brand, sku, image_url,
                      quantity, unit_price, total_price )
`;

function mapOrder(row: Record<string, any>): Order {
  const items: OrderItem[] = (row.items ?? []).map((item: Record<string, any>) => ({
    id: item.id,
    productId: item.product_id ?? null,
    productName: item.product_name,
    productSlug: item.product_slug ?? null,
    brand: item.brand ?? null,
    sku: item.sku ?? null,
    imageUrl: item.image_url ?? null,
    quantity: item.quantity,
    unitPrice: Number(item.unit_price),
    totalPrice: Number(item.total_price),
  }));

  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status as OrderStatus,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    subtotal: Number(row.subtotal),
    discountAmount: Number(row.discount_amount),
    shippingAmount: Number(row.shipping_amount),
    taxAmount: Number(row.tax_amount),
    total: Number(row.total),
    currency: row.currency,
    shippingAddress: row.shipping_address as ShippingAddress,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone ?? null,
    notes: row.notes ?? null,
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    placedAt: row.placed_at,
    createdAt: row.created_at,
  };
}

/** A shopper's own orders. RLS restricts this to the caller. */
export async function listMyOrders(): Promise<Order[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_SELECT)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapOrder);
}

/**
 * A single order. The RLS policy already limits this to the owner (or a
 * merchant), so a customer cannot read someone else's order by guessing an id.
 */
export async function getOrder(orderId: string): Promise<Order> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_SELECT)
    .eq('id', orderId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Order not found.');
  return mapOrder(data);
}

export interface CreateOrderInput {
  contactEmail: string;
  contactPhone?: string;
  shippingAddress: ShippingAddress;
  notes?: string;
  saveAddress?: boolean;
}

export interface CreatedOrder {
  orderId: string;
  orderNumber: string;
  subtotal: number;
  shippingAmount: number;
  total: number;
}

export async function createOrderFromCart(
  user: SessionUser,
  input: CreateOrderInput,
): Promise<CreatedOrder> {
  const context = await resolveCart(false);
  if (!context) throw badRequest('Your cart is empty.');

  await ensureCustomerRecord(user);

  const db = adminClient();

  // A guest cart becomes the signed-in customer's cart at checkout, so the
  // order can be attributed and the customer can see it in their history.
  if (context.isGuest) {
    await db
      .from('carts')
      .update({ customer_id: user.id, session_token: null })
      .eq('id', context.cartId);
  }

  const { data, error } = await db.rpc('create_order_from_cart', {
    p_cart_id: context.cartId,
    p_customer_id: user.id,
    p_contact_email: input.contactEmail,
    p_contact_phone: input.contactPhone || null,
    p_shipping_address: input.shippingAddress,
    p_notes: input.notes || null,
  });

  if (error) {
    const mapped = mapDatabaseError(error);
    if (mapped) throw mapped;
    throw error;
  }

  if (input.saveAddress) {
    await saveAddress(user.id, input.shippingAddress);
  }

  return data as CreatedOrder;
}

async function saveAddress(customerId: string, address: ShippingAddress): Promise<void> {
  const db = adminClient();
  const { data: existing } = await db
    .from('customer_addresses')
    .select('id')
    .eq('customer_id', customerId)
    .eq('is_default', true)
    .maybeSingle();

  const row = {
    customer_id: customerId,
    full_name: address.fullName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2 || null,
    city: address.city,
    state: address.state,
    postal_code: address.postalCode,
    country: address.country || 'IN',
    is_default: true,
  };

  if (existing) {
    await db.from('customer_addresses').update(row).eq('id', existing.id);
  } else {
    await db.from('customer_addresses').insert(row);
  }
}

export async function getDefaultAddress(customerId: string): Promise<ShippingAddress | null> {
  const { data } = await adminClient()
    .from('customer_addresses')
    .select('full_name, phone, line1, line2, city, state, postal_code, country')
    .eq('customer_id', customerId)
    .eq('is_default', true)
    .maybeSingle();

  if (!data) return null;
  return {
    fullName: data.full_name as string,
    phone: data.phone as string,
    line1: data.line1 as string,
    line2: (data.line2 as string | null) ?? null,
    city: data.city as string,
    state: data.state as string,
    postalCode: data.postal_code as string,
    country: (data.country as string) ?? 'IN',
  };
}

// ------------------------------------------------------------------ merchant

export interface MerchantOrderFilters {
  status?: OrderStatus;
  limit?: number;
  offset?: number;
}

export async function listAllOrders(
  filters: MerchantOrderFilters = {},
): Promise<{ orders: Order[]; total: number }> {
  const db = adminClient();
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  let query = db
    .from('orders')
    .select(ORDER_SELECT, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters.status) query = query.eq('status', filters.status);

  const { data, error, count } = await query;
  if (error) throw error;

  return { orders: (data ?? []).map(mapOrder), total: count ?? 0 };
}

export async function getOrderAsMerchant(orderId: string): Promise<Order> {
  const { data, error } = await adminClient()
    .from('orders')
    .select(ORDER_SELECT)
    .eq('id', orderId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Order not found.');
  return mapOrder(data);
}

/**
 * Change an order's status. The RPC moves stock between quantity and
 * reserved_quantity to match the new status, inside one transaction.
 */
export async function updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
  const { error } = await adminClient().rpc('set_order_status', {
    p_order_id: orderId,
    p_status: status,
  });

  if (error) {
    const mapped = mapDatabaseError(error);
    if (mapped) throw mapped;
    throw new ApiError('INTERNAL_ERROR', 'Could not update the order status.');
  }
}
