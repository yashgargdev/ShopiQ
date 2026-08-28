import 'server-only';

import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';

import { badRequest, conflict, notFound } from '@/lib/api/response';
import { getSessionUser } from '@/lib/auth';
import { adminClient } from '@/lib/supabase/admin';
import type {
  Cart,
  CartLine,
  CartMutationOutcome,
  CartMutationResult,
  CartTotals,
} from '@/types';

/**
 * Cart persistence.
 *
 * Signed-in shoppers get a row in public.carts keyed by customer_id, protected
 * by RLS. Guests get a cart keyed by an opaque token held in an httpOnly
 * cookie: the token never reaches client JavaScript, and guest carts carry no
 * customer_id, so no browser session can select them. Both cases are read and
 * written here with the service-role client, after this module has established
 * who the caller is.
 *
 * Cart lines never store a price. Totals are computed from public.products on
 * every read, so a stale cart cannot lock in an old price.
 */

export const GUEST_CART_COOKIE = 'shopiq_cart';
const GUEST_CART_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const FREE_DELIVERY_OVER = Number(process.env.NEXT_PUBLIC_FREE_DELIVERY_OVER ?? 999);
export const DELIVERY_FLAT_RATE = Number(process.env.NEXT_PUBLIC_DELIVERY_FLAT_RATE ?? 79);

interface CartContext {
  cartId: string;
  isGuest: boolean;
  customerId: string | null;
}

/**
 * Find the caller's active cart, creating one only when `create` is set.
 * Read paths pass create=false so a bare page view does not litter the table
 * with empty carts.
 */
export async function resolveCart(create: boolean): Promise<CartContext | null> {
  const user = await getSessionUser();
  const db = adminClient();

  if (user) {
    const { data: existing } = await db
      .from('carts')
      .select('id')
      .eq('customer_id', user.id)
      .eq('status', 'active')
      .maybeSingle();

    if (existing) {
      // A guest cart from before sign-in gets merged in on first touch.
      await mergeGuestCartInto(existing.id as string);
      return { cartId: existing.id as string, isGuest: false, customerId: user.id };
    }

    // No cart on the account yet. If this browser is carrying a guest cart,
    // claim it rather than leaving it detached — otherwise the items would
    // stay tied to a cookie and be lost on another device. This runs on reads
    // too, so signing in is enough to adopt the cart.
    const guestCartId = await findGuestCart();
    if (guestCartId) {
      const adopted = await adoptGuestCart(guestCartId, user.id);
      if (adopted) {
        return { cartId: guestCartId, isGuest: false, customerId: user.id };
      }
      // Lost a race with a concurrent request that already made a cart for
      // this customer — fall through and merge into that one instead.
      const { data: raced } = await db
        .from('carts')
        .select('id')
        .eq('customer_id', user.id)
        .eq('status', 'active')
        .maybeSingle();
      if (raced) {
        await mergeGuestCartInto(raced.id as string);
        return { cartId: raced.id as string, isGuest: false, customerId: user.id };
      }
    }

    if (!create) return null;

    const { data: created, error } = await db
      .from('carts')
      .insert({ customer_id: user.id, status: 'active' })
      .select('id')
      .single();
    if (error) throw error;

    return { cartId: created.id as string, isGuest: false, customerId: user.id };
  }

  const existingGuest = await findGuestCart();
  if (existingGuest) {
    return { cartId: existingGuest, isGuest: true, customerId: null };
  }
  if (!create) return null;

  const token = randomUUID();
  const { data, error } = await db
    .from('carts')
    .insert({ session_token: token, status: 'active' })
    .select('id')
    .single();
  if (error) throw error;

  const store = await cookies();
  store.set(GUEST_CART_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: GUEST_CART_MAX_AGE,
  });

  return { cartId: data.id as string, isGuest: true, customerId: null };
}

async function findGuestCart(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(GUEST_CART_COOKIE)?.value;
  if (!token) return null;

  const { data } = await adminClient()
    .from('carts')
    .select('id')
    .eq('session_token', token)
    .eq('status', 'active')
    .maybeSingle();

  return (data?.id as string | undefined) ?? null;
}

/**
 * Attach a guest cart to a customer who has no cart of their own: the same
 * rows simply change owner, so nothing has to be copied. Returns false when
 * the customer already has an active cart (the partial unique index rejects
 * the update), so the caller can fall back to merging.
 */
async function adoptGuestCart(cartId: string, customerId: string): Promise<boolean> {
  const { error } = await adminClient()
    .from('carts')
    .update({ customer_id: customerId, session_token: null })
    .eq('id', cartId)
    .eq('status', 'active')
    .is('customer_id', null);

  if (error) return false;

  const store = await cookies();
  store.delete(GUEST_CART_COOKIE);
  return true;
}

/**
 * Move guest cart lines into the signed-in cart, summing quantities where the
 * same product appears in both, then retire the guest cart.
 */
async function mergeGuestCartInto(targetCartId: string): Promise<void> {
  const store = await cookies();
  const token = store.get(GUEST_CART_COOKIE)?.value;
  if (!token) return;

  const db = adminClient();
  const { data: guestCart } = await db
    .from('carts')
    .select('id')
    .eq('session_token', token)
    .eq('status', 'active')
    .maybeSingle();

  if (!guestCart || guestCart.id === targetCartId) return;

  const [{ data: guestItems }, { data: targetItems }] = await Promise.all([
    db
      .from('cart_items')
      .select('product_id, quantity, selected_options')
      .eq('cart_id', guestCart.id),
    db
      .from('cart_items')
      .select('product_id, quantity, selected_options')
      .eq('cart_id', targetCartId),
  ]);

  // Identity is (product, options): a Sage iPhone and a White one must survive
  // the merge as two lines rather than being folded into one.
  const merged = new Map<string, { productId: string; options: unknown; quantity: number }>();
  const identify = (productId: string, options: unknown) =>
    `${productId}|${JSON.stringify(options ?? {})}`;

  for (const item of targetItems ?? []) {
    const key = identify(item.product_id as string, item.selected_options);
    merged.set(key, {
      productId: item.product_id as string,
      options: item.selected_options ?? {},
      quantity: item.quantity as number,
    });
  }
  for (const item of guestItems ?? []) {
    const key = identify(item.product_id as string, item.selected_options);
    const existing = merged.get(key);
    merged.set(key, {
      productId: item.product_id as string,
      options: item.selected_options ?? {},
      quantity: Math.min((existing?.quantity ?? 0) + (item.quantity as number), 20),
    });
  }

  if (merged.size > 0) {
    const rows = Array.from(merged.values(), (entry) => ({
      cart_id: targetCartId,
      product_id: entry.productId,
      quantity: entry.quantity,
      selected_options: entry.options,
    }));
    await db
      .from('cart_items')
      .upsert(rows, { onConflict: 'cart_id,product_id,selected_options' });
  }

  await db.from('carts').update({ status: 'abandoned' }).eq('id', guestCart.id);
  store.delete(GUEST_CART_COOKIE);
}

// ---------------------------------------------------------------------------

const EMPTY_TOTALS: CartTotals = {
  subtotal: 0,
  savings: 0,
  shipping: 0,
  total: 0,
  currency: 'INR',
  itemCount: 0,
};

export function emptyCart(cartId = '', isGuest = true): Cart {
  return { id: cartId, isGuest, items: [], totals: EMPTY_TOTALS, issues: [] };
}

/** Read the cart with live prices and live stock. */
export async function getCart(): Promise<Cart> {
  const context = await resolveCart(false);
  if (!context) return emptyCart();
  return loadCart(context);
}

/**
 * Coerce the stored jsonb into the string map the rest of the app expects.
 *
 * Rows written before options existed carry `{}`; anything unexpected is
 * dropped rather than rendered, since this text ends up in front of a customer.
 */
function normaliseOptions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 60) out[key] = value;
  }
  return out;
}

export async function loadCart(context: CartContext): Promise<Cart> {
  const db = adminClient();

  const { data, error } = await db
    .from('cart_items')
    .select(
      `id, quantity, created_at, price_at_add, selected_options,
       product:products!inner (
         id, name, slug, brand, price, compare_at_price, currency, is_active,
         images:product_images ( public_url, is_primary, sort_order ),
         inventory ( quantity, reserved_quantity, low_stock_threshold )
       )`,
    )
    .eq('cart_id', context.cartId)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const issues: string[] = [];
  const items: CartLine[] = [];

  for (const row of (data ?? []) as Array<Record<string, any>>) {
    const product = row.product as Record<string, any>;
    if (!product?.is_active) {
      issues.push(`${product?.name ?? 'An item'} is no longer available and was skipped.`);
      continue;
    }

    const inventory = Array.isArray(product.inventory) ? product.inventory[0] : product.inventory;
    const available = Math.max(
      (inventory?.quantity ?? 0) - (inventory?.reserved_quantity ?? 0),
      0,
    );
    const lowStockThreshold = inventory?.low_stock_threshold ?? 5;

    const image = (product.images ?? [])
      .slice()
      .sort(
        (a: Record<string, any>, b: Record<string, any>) =>
          Number(b.is_primary) - Number(a.is_primary) ||
          (a.sort_order ?? 0) - (b.sort_order ?? 0),
      )[0];

    const quantity = row.quantity as number;
    const unitPrice = Number(product.price);
    const exceedsStock = quantity > available;

    if (exceedsStock) {
      issues.push(
        available === 0
          ? `${product.name} is out of stock.`
          : `Only ${available} of ${product.name} ${available === 1 ? 'is' : 'are'} left — reduce the quantity to check out.`,
      );
    }

    const priceAtAdd =
      row.price_at_add === null || row.price_at_add === undefined
        ? null
        : Number(row.price_at_add);

    items.push({
      id: row.id as string,
      productId: product.id as string,
      name: product.name as string,
      slug: product.slug as string,
      brand: product.brand as string,
      image: (image?.public_url as string | undefined) ?? null,
      quantity,
      unitPrice,
      lineTotal: Number((unitPrice * quantity).toFixed(2)),
      compareAtPrice:
        product.compare_at_price === null ? null : Number(product.compare_at_price),
      currency: product.currency ?? 'INR',
      availability: {
        available,
        inStock: available > 0,
        lowStock: available > 0 && available <= lowStockThreshold,
      },
      exceedsStock,
      priceAtAdd,
      // A change of a rupee or less is rounding, not a price move.
      priceChanged: priceAtAdd !== null && Math.abs(priceAtAdd - unitPrice) > 1,
      selectedOptions: normaliseOptions(row.selected_options),
    });
  }

  return {
    id: context.cartId,
    isGuest: context.isGuest,
    items,
    totals: computeTotals(items),
    issues,
  };
}

/**
 * Totals mirror public.create_order_from_cart(): free delivery over the
 * threshold, otherwise a flat rate. Change both together.
 */
export function computeTotals(items: CartLine[]): CartTotals {
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const savings = items.reduce(
    (sum, item) =>
      sum +
      (item.compareAtPrice && item.compareAtPrice > item.unitPrice
        ? (item.compareAtPrice - item.unitPrice) * item.quantity
        : 0),
    0,
  );
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const shipping = itemCount === 0 || subtotal >= FREE_DELIVERY_OVER ? 0 : DELIVERY_FLAT_RATE;

  return {
    subtotal: round(subtotal),
    savings: round(savings),
    shipping,
    total: round(subtotal + shipping),
    currency: 'INR',
    itemCount,
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------- mutations

/** Highest quantity one cart line may hold. */
export const MAX_PER_LINE = 20;

const NO_OUTCOME: CartMutationOutcome = {
  cartItemId: null,
  productName: null,
  requested: 0,
  applied: 0,
  available: 0,
  clamped: false,
  removed: false,
};

/**
 * Translate the sentinel errors raised by the cart RPCs into API errors.
 * Postgres messages never reach the caller.
 */
function translateCartError(message: string): never {
  if (message.includes('INVALID_QUANTITY')) {
    throw badRequest('Quantity must be at least 1.');
  }
  if (message.includes('PRODUCT_NOT_FOUND')) {
    throw notFound('That product is not available.');
  }
  if (message.includes('PRODUCT_INACTIVE')) {
    const name = message.split('PRODUCT_INACTIVE:')[1]?.split('\n')[0]?.trim();
    throw conflict(name ? `${name} is no longer available.` : 'That product is no longer available.');
  }
  if (message.includes('OUT_OF_STOCK')) {
    const name = message.split('OUT_OF_STOCK:')[1]?.split('\n')[0]?.trim();
    throw conflict(name ? `${name} is out of stock.` : 'That product is out of stock.');
  }
  if (message.includes('ITEM_NOT_FOUND')) {
    throw notFound('That item is not in your cart.');
  }
  throw new Error(message);
}

/**
 * Add to the cart.
 *
 * The check-and-write happens inside public.cart_add_item() under an inventory
 * row lock, so two concurrent adds of the last unit cannot both believe they
 * got it. The quantity is still clamped rather than rejected — asking for a
 * 13th of something with 12 in stock should leave 12 in the cart — but the
 * returned `outcome` says so, which is what lets the assistant report what it
 * actually did instead of what it was asked to do.
 */
export async function addItem(
  productId: string,
  quantity: number,
  selectedOptions: Record<string, string> = {},
): Promise<CartMutationResult> {
  const context = await resolveCart(true);
  if (!context) throw new Error('Could not open a cart.');

  const { data, error } = await adminClient().rpc('cart_add_item', {
    p_cart_id: context.cartId,
    p_product_id: productId,
    p_quantity: quantity,
    p_max_per_line: MAX_PER_LINE,
    p_selected_options: selectedOptions,
  });

  if (error) translateCartError(error.message ?? '');

  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    cart: await loadCart(context),
    outcome: {
      cartItemId: (raw.cartItemId as string) ?? null,
      productName: (raw.productName as string) ?? null,
      requested: Number(raw.requestedTotal ?? quantity),
      applied: Number(raw.appliedTotal ?? 0),
      available: Number(raw.available ?? 0),
      clamped: Boolean(raw.clamped),
      removed: false,
    },
  };
}

/** Set a line to an exact quantity. Zero removes it. */
export async function updateItem(
  itemId: string,
  quantity: number,
): Promise<CartMutationResult> {
  const context = await resolveCart(false);
  if (!context) throw notFound('Your cart is empty.');

  const { data, error } = await adminClient().rpc('cart_set_quantity', {
    p_cart_id: context.cartId,
    p_cart_item_id: itemId,
    p_quantity: quantity,
    p_max_per_line: MAX_PER_LINE,
  });

  if (error) translateCartError(error.message ?? '');

  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    cart: await loadCart(context),
    outcome: {
      cartItemId: (raw.cartItemId as string) ?? itemId,
      productName: (raw.productName as string) ?? null,
      requested: Number(raw.requestedTotal ?? quantity),
      applied: Number(raw.appliedTotal ?? 0),
      available: Number(raw.available ?? 0),
      clamped: Boolean(raw.clamped),
      removed: Boolean(raw.removed),
    },
  };
}

export async function removeItem(itemId: string): Promise<CartMutationResult> {
  const context = await resolveCart(false);
  if (!context) throw notFound('Your cart is empty.');

  const db = adminClient();

  // Read the name before deleting, so the reply can name what went.
  const { data: existing } = await db
    .from('cart_items')
    .select('id, product:products ( name )')
    .eq('id', itemId)
    .eq('cart_id', context.cartId)
    .maybeSingle();

  if (!existing) throw notFound('That item is not in your cart.');

  // The cart_id predicate is the ownership check: another shopper's item id
  // matches nothing.
  await db.from('cart_items').delete().eq('id', itemId).eq('cart_id', context.cartId);

  const product = existing.product as { name?: string } | { name?: string }[] | null;
  const productName = Array.isArray(product) ? (product[0]?.name ?? null) : (product?.name ?? null);

  return {
    cart: await loadCart(context),
    outcome: { ...NO_OUTCOME, cartItemId: itemId, productName, removed: true },
  };
}

export async function clearCart(): Promise<Cart> {
  const context = await resolveCart(false);
  if (!context) return emptyCart();

  await adminClient().from('cart_items').delete().eq('cart_id', context.cartId);
  return loadCart(context);
}

