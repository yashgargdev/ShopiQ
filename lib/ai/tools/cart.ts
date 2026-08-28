import 'server-only';

import { ApiError, conflict, notFound } from '@/lib/api/response';
import {
  addItem,
  clearCart as clearCartService,
  getCart as getCartService,
  removeItem,
  updateItem,
} from '@/lib/cart/queries';
import { prepareCheckout } from '@/lib/checkout/prepare';
import { getProductDetail } from '@/lib/products/queries';
import { coloursFromImageKeys, statedColour } from '@/lib/ai/variants';
import type { Cart, CartMutationOutcome } from '@/types';

import type {
  AddToCartInput,
  RemoveFromCartInput,
  UpdateCartQuantityInput,
} from './schemas';

/**
 * The cart tools — the first AI tools in ShopiQ that change commerce state.
 *
 * Each one is a thin wrapper over `lib/cart/queries.ts`, the same service the
 * website's own cart routes call. That is deliberate: there is exactly one
 * implementation of "add to cart", so the AI and the UI cannot drift apart, and
 * the validation the UI gets is the validation the AI gets.
 *
 * Note what these functions do NOT take: a customer id, a cart id, a price, or
 * a total. Identity is resolved from the session inside the service; money is
 * read from the catalogue. The model has no way to supply any of it.
 */

// ------------------------------------------------------------- shared shape

export interface ToolCartLine {
  cart_item_id: string;
  product_id: string;
  /** Chosen options, e.g. { colour: 'Sage' }. Empty when none apply. */
  selected_options: Record<string, string>;
  name: string;
  brand: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  image_url: string | null;
  available: boolean;
  available_quantity: number;
  /** Set when the catalogue price moved since this line was added. */
  price_changed: boolean;
}

export interface ToolCart {
  items: ToolCartLine[];
  subtotal: number;
  shipping: number;
  savings: number;
  total: number;
  currency: 'INR';
  item_count: number;
  /** Anything the shopper should know: out of stock, quantity too high. */
  issues: string[];
}

export function toToolCart(cart: Cart): ToolCart {
  return {
    items: cart.items.map((item) => ({
      cart_item_id: item.id,
      product_id: item.productId,
      selected_options: item.selectedOptions,
      name: item.name,
      brand: item.brand,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      total_price: item.lineTotal,
      image_url: item.image,
      available: item.availability.inStock,
      available_quantity: item.availability.available,
      price_changed: item.priceChanged,
    })),
    // All five figures are computed server-side from the live catalogue. The
    // model is given them so it can state them, never so it can derive them.
    subtotal: cart.totals.subtotal,
    shipping: cart.totals.shipping,
    savings: cart.totals.savings,
    total: cart.totals.total,
    currency: 'INR',
    item_count: cart.totals.itemCount,
    issues: cart.issues,
  };
}

/**
 * A short, factual note about what the mutation actually did — including when
 * stock forced a smaller quantity than asked for. The assistant is expected to
 * relay this rather than assert what it requested.
 */
function describeOutcome(outcome: CartMutationOutcome): string | null {
  if (outcome.removed) {
    return outcome.productName ? `Removed ${outcome.productName}.` : 'Removed that item.';
  }
  if (outcome.clamped) {
    const name = outcome.productName ?? 'that product';
    return `Only ${outcome.available} of ${name} ${
      outcome.available === 1 ? 'is' : 'are'
    } available, so the quantity is now ${outcome.applied} rather than ${outcome.requested}.`;
  }
  return null;
}

// ----------------------------------------------------------------- get_cart

export async function getCart(): Promise<ToolCart> {
  return toToolCart(await getCartService());
}

// -------------------------------------------------------------- add_to_cart

export interface CartMutationToolResult {
  success: true;
  cart: ToolCart;
  cart_item_id: string | null;
  quantity: number;
  /** Non-null when reality differed from the request. Say this out loud. */
  note: string | null;
}

export async function addToCart(input: AddToCartInput): Promise<CartMutationToolResult> {
  // The tool contract accepts a slug as well as an id, because the model works
  // from what it saw in search results. Resolving it here also means an
  // inactive or unknown product fails before the cart is touched.
  const product = await getProductDetail(input.product_id);

  // Never trust a supplied colour. The offered list comes from the images this
  // product actually has, so an option that is not on it is silently dropped
  // rather than written to a line the customer will later be shipped against.
  const offered = coloursFromImageKeys(product.images.map((image) => image.url));
  const requested = input.colour ? statedColour(input.colour, offered) : null;
  const selectedOptions: Record<string, string> = requested ? { colour: requested } : {};

  const { cart, outcome } = await addItem(product.id, input.quantity ?? 1, selectedOptions);

  return {
    success: true,
    cart: toToolCart(cart),
    cart_item_id: outcome.cartItemId,
    quantity: outcome.applied,
    note: describeOutcome(outcome),
  };
}

// --------------------------------------------------------- remove_from_cart

export async function removeFromCart(
  input: RemoveFromCartInput,
): Promise<CartMutationToolResult> {
  // Ownership is enforced inside the service: the delete is scoped to the
  // caller's own cart id, so another shopper's item id matches nothing and
  // comes back as "not in your cart".
  const { cart, outcome } = await removeItem(input.cart_item_id);

  return {
    success: true,
    cart: toToolCart(cart),
    cart_item_id: outcome.cartItemId,
    quantity: 0,
    note: describeOutcome(outcome),
  };
}

// ----------------------------------------------------- update_cart_quantity

export async function updateCartQuantity(
  input: UpdateCartQuantityInput,
): Promise<CartMutationToolResult> {
  const { cart, outcome } = await updateItem(input.cart_item_id, input.quantity);

  return {
    success: true,
    cart: toToolCart(cart),
    cart_item_id: outcome.cartItemId,
    quantity: outcome.applied,
    note: describeOutcome(outcome),
  };
}

// --------------------------------------------------------------- clear_cart

export async function clearCart(): Promise<CartMutationToolResult> {
  const before = await getCartService();
  if (before.items.length === 0) {
    return {
      success: true,
      cart: toToolCart(before),
      cart_item_id: null,
      quantity: 0,
      note: 'The cart was already empty.',
    };
  }

  const cart = await clearCartService();
  const count = before.totals.itemCount;

  return {
    success: true,
    cart: toToolCart(cart),
    cart_item_id: null,
    quantity: 0,
    note: `Removed ${count} ${count === 1 ? 'item' : 'items'} from the cart.`,
  };
}

// --------------------------------------------------------- prepare_checkout

export async function prepareCheckoutTool() {
  const preview = await prepareCheckout();

  // A blocked checkout is a normal, expected outcome — not an error. The
  // assistant needs the detail so it can explain what to fix.
  return {
    valid: preview.valid,
    items: preview.items,
    subtotal: preview.subtotal,
    shipping: preview.shipping,
    savings: preview.savings,
    total: preview.total,
    currency: preview.currency,
    item_count: preview.item_count,
    blockers: preview.blockers,
    changes: preview.changes.map((change) => ({
      kind: change.kind,
      product_name: change.productName,
      message: change.message,
      from: change.from ?? null,
      to: change.to ?? null,
    })),
    summary: preview.summary,
    checkout_url: preview.checkout_url,
    /* Phase 3 stops here. No order is created and no payment is started. */
    creates_order: false,
    creates_payment: false,
  };
}

export { ApiError, conflict, notFound };
