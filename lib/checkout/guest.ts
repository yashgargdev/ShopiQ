import 'server-only';
import { cookies } from 'next/headers';
import { adminClient } from '@/lib/supabase/admin';
import { GUEST_CART_COOKIE } from '@/lib/cart/queries';

/**
 * Guest checkout sessions.
 *
 * A customer must not need an account to shop. But `customers.id` is a foreign
 * key to `auth.users(id)`, so an ORDER cannot exist without one. Guest checkout
 * therefore means: no account is required BEFORE shopping. The account is
 * created at finalization, immediately before the order row, and the customer
 * gets a secure link to set a password afterwards.
 *
 * Until then, the contact and delivery details live here, bound to the guest
 * cart's httpOnly cookie. **Identity is derived from that cookie and never from
 * a request parameter** — the same rule the authenticated path follows, so a
 * caller still cannot name whose cart to charge.
 */

export interface GuestAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  /** Present only when the address came from geolocation. */
  latitude?: number | null;
  longitude?: number | null;
}

export interface GuestCheckoutSession {
  id: string;
  cartId: string;
  conversationId: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  address: GuestAddress | null;
  addressSource: 'geolocation' | 'manual' | null;
  status: 'collecting' | 'ready' | 'consumed' | 'expired';
  expiresAt: string;
}

/** What still has to be collected before checkout can proceed. */
export type MissingDetail = 'name' | 'email' | 'phone' | 'address';

function toSession(row: Record<string, any>): GuestCheckoutSession {
  return {
    id: row.id,
    cartId: row.cart_id,
    conversationId: row.conversation_id ?? null,
    fullName: row.full_name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    address: (row.address as GuestAddress | null) ?? null,
    addressSource: row.address_source ?? null,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

/**
 * What is still missing, in the order the agent should ask for it.
 *
 * Phone is required because a delivery partner needs one; the spec asks for it
 * and an order without it is not actually deliverable.
 */
export function missingDetails(session: GuestCheckoutSession | null): MissingDetail[] {
  if (!session) return ['name', 'email', 'phone', 'address'];
  const missing: MissingDetail[] = [];
  if (!session.fullName?.trim()) missing.push('name');
  if (!session.email?.trim()) missing.push('email');
  if (!session.phone?.trim()) missing.push('phone');
  if (!session.address?.line1?.trim() || !session.address?.city?.trim()) missing.push('address');
  return missing;
}

/** A basic, deliberately permissive email check — the confirmation email is the real test. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/** Indian mobile numbers, with or without +91. */
export function normalisePhone(value: string): string | null {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return null;
}

/** The guest cart token from the httpOnly cookie. Never accepted from a body. */
export async function guestCartToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(GUEST_CART_COOKIE)?.value ?? null;
}

/**
 * Find (or open) the guest checkout session for the current guest cart.
 *
 * Returns null when there is no guest cart cookie at all — an authenticated
 * customer does not need one of these.
 */
export async function resolveGuestSession(
  cartId: string,
  options: { create?: boolean; conversationId?: string | null } = {},
): Promise<GuestCheckoutSession | null> {
  const token = await guestCartToken();
  if (!token) return null;

  const db = adminClient();
  const { data: existing } = await db
    .from('guest_checkout_sessions')
    .select('*')
    .eq('cart_id', cartId)
    .in('status', ['collecting', 'ready'])
    .maybeSingle();

  if (existing) {
    // An expired session is not silently reused — stale delivery details are
    // exactly the kind of thing that should be re-confirmed.
    if (Date.parse(existing.expires_at) <= Date.now()) {
      await db
        .from('guest_checkout_sessions')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (!options.create) return null;
    } else {
      return toSession(existing);
    }
  }

  if (!options.create) return null;

  const { data, error } = await db
    .from('guest_checkout_sessions')
    .insert({
      cart_id: cartId,
      session_token: token,
      conversation_id: options.conversationId ?? null,
      status: 'collecting',
    })
    .select('*')
    .single();

  if (error) throw error;
  return toSession(data);
}

/**
 * Record one or more collected details.
 *
 * Every field is validated here rather than trusted from the transcript: an
 * STT mishearing of an email address is a very ordinary event, and an invoice
 * sent to the wrong person is not recoverable.
 */
export async function updateGuestSession(
  sessionId: string,
  patch: {
    fullName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: GuestAddress | null;
    addressSource?: 'geolocation' | 'manual' | null;
    conversationId?: string | null;
  },
): Promise<{ session: GuestCheckoutSession; rejected: string[] }> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const rejected: string[] = [];

  if (patch.fullName !== undefined) {
    const name = patch.fullName?.trim() ?? '';
    if (name.length >= 2 && name.length <= 120) update.full_name = name;
    else if (name) rejected.push('name');
  }

  if (patch.email !== undefined) {
    const email = patch.email?.trim().toLowerCase() ?? '';
    if (looksLikeEmail(email)) update.email = email;
    else if (email) rejected.push('email');
  }

  if (patch.phone !== undefined) {
    const phone = normalisePhone(patch.phone ?? '');
    if (phone) update.phone = phone;
    else if (patch.phone?.trim()) rejected.push('phone');
  }

  if (patch.address !== undefined) {
    const address = patch.address;
    if (address?.line1?.trim() && address?.city?.trim()) {
      update.address = {
        line1: address.line1.trim().slice(0, 200),
        line2: address.line2?.trim().slice(0, 200) ?? null,
        city: address.city.trim().slice(0, 100),
        state: address.state?.trim().slice(0, 100) ?? '',
        postalCode: address.postalCode?.trim().slice(0, 20) ?? '',
        country: address.country?.trim().slice(0, 60) || 'India',
        latitude: address.latitude ?? null,
        longitude: address.longitude ?? null,
      };
      if (patch.addressSource) update.address_source = patch.addressSource;
    } else if (address) {
      rejected.push('address');
    }
  }

  if (patch.conversationId) update.conversation_id = patch.conversationId;

  const db = adminClient();
  const { data, error } = await db
    .from('guest_checkout_sessions')
    .update(update)
    .eq('id', sessionId)
    .select('*')
    .single();
  if (error) throw error;

  const session = toSession(data);

  // Promote to `ready` only when everything needed is present, so the payment
  // gate has a single boolean to check rather than re-deriving completeness.
  const stillMissing = missingDetails(session);
  const nextStatus = stillMissing.length === 0 ? 'ready' : 'collecting';
  if (session.status !== nextStatus && session.status !== 'consumed') {
    await db.from('guest_checkout_sessions').update({ status: nextStatus }).eq('id', sessionId);
    session.status = nextStatus as GuestCheckoutSession['status'];
  }

  return { session, rejected };
}

/** Mark a session used once its order exists. */
export async function consumeGuestSession(
  sessionId: string,
  meta: { orderId: string; customerId: string },
): Promise<void> {
  await adminClient()
    .from('guest_checkout_sessions')
    .update({
      status: 'consumed',
      order_id: meta.orderId,
      customer_id: meta.customerId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
}

export async function loadGuestSessionById(id: string): Promise<GuestCheckoutSession | null> {
  const { data, error } = await adminClient()
    .from('guest_checkout_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? toSession(data) : null;
}
