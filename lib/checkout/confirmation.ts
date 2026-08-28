import 'server-only';
import { createHash } from 'node:crypto';
import { adminClient } from '@/lib/supabase/admin';
import { toMinorUnits } from '@/lib/payments/money';
import { recordMoneyEvent } from '@/lib/payments/audit';
import type { Cart } from '@/types';

/**
 * Purchase confirmations.
 *
 * A confirmation is a customer's "yes" bound to an exact cart. It is NOT a
 * message in the transcript — reading consent out of raw conversation text is
 * how an agent ends up treating "yes, tell me more" as authorization to
 * charge ₹80,898. It is a row, with a hash, an amount, a status and a deadline.
 *
 * Four things can end a confirmation before it is used: the cart changes, a
 * price changes, it expires, or the customer cancels. Any of those and the
 * next payment attempt has to ask again.
 */

/** How long a customer's "yes" stays good for. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export type ConfirmationStatus =
  | 'pending'
  | 'confirmed'
  | 'expired'
  | 'invalidated'
  | 'consumed'
  | 'cancelled';

export interface CartSnapshotLine {
  product_id: string;
  name: string;
  quantity: number;
  unit_price_minor: number;
  line_total_minor: number;
}

export interface CartSnapshot {
  items: CartSnapshotLine[];
  subtotal_minor: number;
  shipping_minor: number;
  total_minor: number;
  currency: 'INR';
}

export interface PurchaseConfirmation {
  id: string;
  /** Null for a guest checkout — see guestSessionId. */
  customerId: string | null;
  /** Set instead of customerId when the buyer has no account yet. */
  guestSessionId: string | null;
  conversationId: string | null;
  cartId: string | null;
  snapshot: CartSnapshot;
  cartHash: string;
  amountMinor: number;
  currency: string;
  status: ConfirmationStatus;
  expiresAt: string;
  confirmedAt: string | null;
}

/**
 * Build the canonical snapshot of a cart.
 *
 * Lines are sorted by product id so that the same cart always produces the
 * same bytes regardless of the order rows came back in — otherwise the hash
 * would change for reasons that have nothing to do with what is being bought.
 */
export function snapshotCart(cart: Cart): CartSnapshot {
  const items = cart.items
    .map((item) => ({
      product_id: item.productId,
      name: item.name,
      quantity: item.quantity,
      unit_price_minor: toMinorUnits(item.unitPrice),
      line_total_minor: toMinorUnits(item.lineTotal),
    }))
    .sort((a, b) => a.product_id.localeCompare(b.product_id));

  return {
    items,
    subtotal_minor: toMinorUnits(cart.totals.subtotal),
    shipping_minor: toMinorUnits(cart.totals.shipping),
    total_minor: toMinorUnits(cart.totals.total),
    currency: 'INR',
  };
}

/**
 * Deterministic digest of a snapshot.
 *
 * Only the fields that change what the customer is agreeing to go into the
 * hash — ids, quantities, unit prices and the total. The product NAME is
 * deliberately excluded: a merchant fixing a typo in a title should not
 * invalidate a confirmation mid-checkout.
 */
export function hashSnapshot(snapshot: CartSnapshot): string {
  const canonical = JSON.stringify({
    items: snapshot.items.map((line) => [line.product_id, line.quantity, line.unit_price_minor]),
    total: snapshot.total_minor,
    currency: snapshot.currency,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Snapshot and hash in one step. */
export function cartFingerprint(cart: Cart): { snapshot: CartSnapshot; hash: string } {
  const snapshot = snapshotCart(cart);
  return { snapshot, hash: hashSnapshot(snapshot) };
}

function toConfirmation(row: Record<string, any>): PurchaseConfirmation {
  return {
    id: row.id,
    customerId: row.customer_id ?? null,
    guestSessionId: row.guest_session_id ?? null,
    conversationId: row.conversation_id ?? null,
    cartId: row.cart_id ?? null,
    snapshot: row.cart_snapshot as CartSnapshot,
    cartHash: row.cart_hash,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at ?? null,
  };
}

/**
 * Open a confirmation for the current cart and mark any earlier open ones
 * invalidated — a customer can only have one live "yes" at a time.
 */
export async function createConfirmation(params: {
  /** One of these two must be set; the caller has already established which. */
  customerId?: string | null;
  guestSessionId?: string | null;
  conversationId?: string | null;
  cartId: string;
  cart: Cart;
  /**
   * Where this order ships, as shown to the customer at the moment they were
   * quoted. Snapshotted rather than looked up later: a confirmation binds the
   * exact cart and the exact amount, and the destination is the third term of
   * the same agreement.
   */
  shippingAddressId?: string | null;
  shippingAddress?: Record<string, unknown> | null;
}): Promise<PurchaseConfirmation> {
  const db = adminClient();
  const { snapshot, hash } = cartFingerprint(params.cart);

  // Only one live confirmation per buyer at a time, whichever kind they are.
  const invalidate = db
    .from('purchase_confirmations')
    .update({ status: 'invalidated', updated_at: new Date().toISOString() })
    .in('status', ['pending', 'confirmed']);
  await (params.customerId
    ? invalidate.eq('customer_id', params.customerId)
    : invalidate.eq('guest_session_id', params.guestSessionId!));

  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString();

  const { data, error } = await db
    .from('purchase_confirmations')
    .insert({
      customer_id: params.customerId ?? null,
      guest_session_id: params.guestSessionId ?? null,
      conversation_id: params.conversationId ?? null,
      cart_id: params.cartId,
      cart_snapshot: snapshot,
      cart_hash: hash,
      amount_minor: snapshot.total_minor,
      currency: 'INR',
      status: 'pending',
      expires_at: expiresAt,
      shipping_address_id: params.shippingAddressId ?? null,
      shipping_address: params.shippingAddress ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;

  await recordMoneyEvent({
    event: 'confirmation_requested',
    customerId: params.customerId ?? null,
    conversationId: params.conversationId ?? null,
    confirmationId: data.id,
    amountMinor: snapshot.total_minor,
    currency: 'INR',
    detail: { items: snapshot.items.length, cart_hash: hash },
  });

  return toConfirmation(data);
}

/** Turn a pending confirmation into a confirmed one. */
export async function grantConfirmation(
  confirmationId: string,
  owner: { customerId?: string | null; guestSessionId?: string | null },
): Promise<PurchaseConfirmation | null> {
  const db = adminClient();
  // Scoped to the owner, so granting someone else's confirmation matches
  // nothing rather than succeeding.
  let query = db
    .from('purchase_confirmations')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', confirmationId)
    .eq('status', 'pending');
  query = owner.customerId
    ? query.eq('customer_id', owner.customerId)
    : query.eq('guest_session_id', owner.guestSessionId!);
  const { data, error } = await query.select('*').maybeSingle();

  if (error) throw error;
  if (!data) return null;

  await recordMoneyEvent({
    event: 'confirmation_granted',
    customerId: owner.customerId ?? null,
    confirmationId,
    amountMinor: Number(data.amount_minor),
    currency: data.currency,
  });

  return toConfirmation(data);
}

/** The customer's most recent confirmation that could still authorize a payment. */
export async function loadLiveConfirmation(
  customerId: string | null,
  guestSessionId: string | null = null,
): Promise<PurchaseConfirmation | null> {
  if (!customerId && !guestSessionId) return null;
  let query = adminClient()
    .from('purchase_confirmations')
    .select('*')
    .in('status', ['pending', 'confirmed']);
  query = customerId
    ? query.eq('customer_id', customerId)
    : query.eq('guest_session_id', guestSessionId!);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? toConfirmation(data) : null;
}

export async function loadConfirmation(id: string): Promise<PurchaseConfirmation | null> {
  const { data, error } = await adminClient()
    .from('purchase_confirmations')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? toConfirmation(data) : null;
}

/** Move a confirmation to a terminal state. */
export async function closeConfirmation(
  confirmationId: string,
  status: Extract<ConfirmationStatus, 'expired' | 'invalidated' | 'cancelled' | 'consumed'>,
  meta: { customerId?: string | null; reason?: string } = {},
): Promise<void> {
  await adminClient()
    .from('purchase_confirmations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', confirmationId);

  const event =
    status === 'expired'
      ? 'confirmation_expired'
      : status === 'cancelled'
        ? 'confirmation_cancelled'
        : status === 'consumed'
          ? 'confirmation_consumed'
          : 'confirmation_invalidated';

  await recordMoneyEvent({
    event,
    customerId: meta.customerId ?? null,
    confirmationId,
    detail: meta.reason ? { reason: meta.reason } : {},
  });
}

export function isConfirmationExpired(confirmation: PurchaseConfirmation): boolean {
  return Date.parse(confirmation.expiresAt) <= Date.now();
}
