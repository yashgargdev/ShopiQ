import 'server-only';

import { DELIVERY_FLAT_RATE, FREE_DELIVERY_OVER, getCart } from '@/lib/cart/queries';
import { formatPrice } from '@/lib/format';
import type { Cart, CartLine } from '@/types';

/**
 * Checkout preparation.
 *
 * A validated, priced preview — nothing more. It does not create an order, does
 * not reserve stock and does not touch payment. Phase 3 stops here by design;
 * `POST /api/orders` (Phase 1) remains the only thing that writes an order, and
 * payment is Phase 4.
 *
 * Every figure comes from the live catalogue. The shopper is told, explicitly,
 * about anything that changed since they added an item — a price move or a
 * stock drop is surfaced rather than silently applied.
 */

export type CheckoutBlocker =
  | 'empty_cart'
  | 'out_of_stock'
  | 'insufficient_stock'
  | 'product_unavailable';

export interface CheckoutChange {
  kind: 'price_increase' | 'price_decrease' | 'quantity_reduced' | 'item_unavailable';
  cartItemId: string | null;
  productName: string;
  message: string;
  /** Present on price changes. */
  from?: number;
  to?: number;
}

export interface CheckoutLine {
  cart_item_id: string;
  product_id: string;
  name: string;
  brand: string;
  slug: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  image_url: string | null;
  available: boolean;
  available_quantity: number;
}

export interface CheckoutPreview {
  valid: boolean;
  items: CheckoutLine[];
  subtotal: number;
  shipping: number;
  savings: number;
  total: number;
  currency: 'INR';
  item_count: number;
  /** Why checkout cannot proceed, if it cannot. */
  blockers: CheckoutBlocker[];
  /** Things that changed since the items were added — always surfaced. */
  changes: CheckoutChange[];
  /** One sentence the assistant can say verbatim. */
  summary: string;
  /** Where the shopper goes next. Phase 3 never proceeds past this. */
  checkout_url: string;
}

function toLine(item: CartLine): CheckoutLine {
  return {
    cart_item_id: item.id,
    product_id: item.productId,
    name: item.name,
    brand: item.brand,
    slug: item.slug,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    total_price: item.lineTotal,
    image_url: item.image,
    available: item.availability.inStock,
    available_quantity: item.availability.available,
  };
}

/**
 * Validate and price the current cart.
 *
 * Note the totals are recomputed here from the live cart rather than trusted
 * from anywhere else — the same arithmetic the order RPC will do, so the
 * preview and the eventual charge agree.
 */
export async function prepareCheckout(): Promise<CheckoutPreview> {
  const cart: Cart = await getCart();

  const blockers: CheckoutBlocker[] = [];
  const changes: CheckoutChange[] = [];

  if (cart.items.length === 0) {
    return {
      valid: false,
      items: [],
      subtotal: 0,
      shipping: 0,
      savings: 0,
      total: 0,
      currency: 'INR',
      item_count: 0,
      blockers: ['empty_cart'],
      changes: [],
      summary: 'Your cart is empty, so there is nothing to check out yet.',
      checkout_url: '/checkout',
    };
  }

  for (const item of cart.items) {
    if (!item.availability.inStock) {
      blockers.push('out_of_stock');
      changes.push({
        kind: 'item_unavailable',
        cartItemId: item.id,
        productName: item.name,
        message: `${item.name} has gone out of stock since you added it.`,
      });
      continue;
    }

    if (item.exceedsStock) {
      blockers.push('insufficient_stock');
      changes.push({
        kind: 'quantity_reduced',
        cartItemId: item.id,
        productName: item.name,
        message: `Only ${item.availability.available} of ${item.name} ${
          item.availability.available === 1 ? 'is' : 'are'
        } available — you have ${item.quantity} in your cart.`,
      });
    }

    if (item.priceChanged && item.priceAtAdd !== null) {
      const increased = item.unitPrice > item.priceAtAdd;
      changes.push({
        kind: increased ? 'price_increase' : 'price_decrease',
        cartItemId: item.id,
        productName: item.name,
        from: item.priceAtAdd,
        to: item.unitPrice,
        message: `${item.name} is now ${formatPrice(item.unitPrice)} — it was ${formatPrice(
          item.priceAtAdd,
        )} when you added it.`,
      });
    }
  }

  // Cart totals already come from the live catalogue; reuse them so the preview
  // and the cart can never disagree.
  const { subtotal, shipping, savings, total, itemCount } = cart.totals;
  const valid = blockers.length === 0;

  return {
    valid,
    items: cart.items.map(toLine),
    subtotal,
    shipping,
    savings,
    total,
    currency: 'INR',
    item_count: itemCount,
    blockers: [...new Set(blockers)],
    changes,
    summary: buildSummary(valid, cart, changes),
    checkout_url: '/checkout',
  };
}

function buildSummary(valid: boolean, cart: Cart, changes: CheckoutChange[]): string {
  const count = cart.totals.itemCount;
  const noun = count === 1 ? 'item' : 'items';
  const delivery =
    cart.totals.shipping === 0
      ? 'with free delivery'
      : `plus ${formatPrice(cart.totals.shipping)} delivery`;

  if (!valid) {
    const first = changes[0];
    return `${first?.message ?? 'Something in your cart needs attention.'} Fix that and I can take you to checkout.`;
  }

  const priceNote = changes.some((change) => change.kind.startsWith('price'))
    ? ' Note that a price has changed since you added it.'
    : '';

  return `${count} ${noun}, ${formatPrice(cart.totals.subtotal)} ${delivery} — ${formatPrice(
    cart.totals.total,
  )} in total.${priceNote}`;
}

/** Exported so the docs and the UI can state the rule in one place. */
export const DELIVERY_RULE = {
  freeOver: FREE_DELIVERY_OVER,
  flatRate: DELIVERY_FLAT_RATE,
} as const;
