import 'server-only';

import { formatPrice, pluralise } from '@/lib/format';
import { listProducts } from '@/lib/products/queries';
import type { ProductSummary } from '@/types';

import { buildPendingAction, type PendingAction } from './confirm';
import { accessoryCategoriesFor, rankCrossSell, type CrossSellCandidate } from './crosssell';
import { describeOptions } from './variants';
import { resolveReference, extractQuantity, type ReferenceScope } from './references';
import {
  askColour,
  askStorage,
  coloursFor,
  findByPhrase,
  narrow,
  nextQuestionFor,
  saysNoPreference,
  statedColour,
  statedStorage,
  type VariantSelection,
} from './variant-flow';
import { idempotencyKeyFor, runTool, type ToolBudget } from './tools/registry';
import { markRecommendation, recordCommerceEvent } from '@/lib/analytics/track';
import type { ToolCart } from './tools/cart';
import type {
  AgentAction,
  AgentPaymentPayload,
  AgentPurchasePayload,
  AgentCartPayload,
  AgentCheckoutPayload,
  AgentOutcome,
  RecommendedProductPayload,
  ShoppingRequirements,
} from './types';

/**
 * Cart and checkout turn handlers.
 *
 * Each one resolves what the shopper meant, runs the corresponding tool through
 * the registry (so it is validated, budgeted, logged and idempotent), and
 * returns the pieces of the reply. Nothing here talks to the database directly
 * and nothing here computes a price.
 *
 * The prose these produce is deterministic. When a model is configured the
 * agent may rewrite it, but only from the facts already established here.
 */

export interface CartTurnContext {
  conversationId: string;
  budget: ToolBudget;
  toolsUsed: string[];
  scope: ReferenceScope;
  requirements: ShoppingRequirements;
  /** Ordinals the model thought it saw, used only if the rules found none. */
  modelPositions: number[];
}

export interface CartTurnResult {
  message: string;
  outcome: AgentOutcome;
  cart: AgentCartPayload | null;
  checkout: AgentCheckoutPayload | null;
  products: RecommendedProductPayload[];
  actions: AgentAction[];
  pendingAction: PendingAction | null;
  /** Phase 4 — an exact total awaiting approval, and the resulting payment. */
  purchase?: AgentPurchasePayload | null;
  payment?: AgentPaymentPayload | null;
  order?: { id: string; orderNumber: string; totalDisplay: string } | null;
}

const EMPTY: Omit<CartTurnResult, 'message' | 'outcome'> = {
  cart: null,
  checkout: null,
  products: [],
  actions: [],
  pendingAction: null,
};

// ------------------------------------------------------------------ mapping

export function toAgentCart(cart: ToolCart): AgentCartPayload {
  return {
    items: cart.items.map((item) => ({
      cartItemId: item.cart_item_id,
      productId: item.product_id,
      selectedOptions: item.selected_options ?? {},
      name: item.name,
      brand: item.brand,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      lineTotal: item.total_price,
      image: item.image_url,
      available: item.available,
      availableQuantity: item.available_quantity,
      priceChanged: item.price_changed,
    })),
    subtotal: cart.subtotal,
    shipping: cart.shipping,
    savings: cart.savings,
    total: cart.total,
    currency: cart.currency,
    itemCount: cart.item_count,
    issues: cart.issues,
  };
}

/** The cart, as a reference scope entry, so "remove the laptop" can resolve. */
export function cartScopeLines(cart: AgentCartPayload): ReferenceScope['cart'] {
  return cart.items.map((item) => ({
    cartItemId: item.cartItemId,
    productId: item.productId,
    name: item.name,
    brand: item.brand,
    price: item.unitPrice,
    quantity: item.quantity,
  }));
}

async function readCart(context: CartTurnContext): Promise<AgentCartPayload | null> {
  const result = await runTool('get_cart', {}, {
    conversationId: context.conversationId,
    budget: context.budget,
  });
  context.toolsUsed.push('get_cart');
  return result.ok ? toAgentCart(result.output as ToolCart) : null;
}

/**
 * "add it", "add that too", "haan woh bhi add kar do" — an add with no
 * distinguishing term, following a reply that led with one product.
 */
const BARE_ADD = new RegExp(
  [
    '\\badd (it|that|this|them|those|too|also)\\b',
    // A plain "add" only counts when nothing else singles a product out —
    // "add the second one" must not fall through to the lead product.
    '\\badd\\b(?![^.]*\\b(first|second|third|fourth|cheaper|lighter|powerful|rated)\\b)',
    '\\b(woh|wo|ye|yeh) bhi\\b',
    '\\b(that|this) too\\b',
    '\\balso add\\b',
    '\\b(le lo|daal do|daal de)\\b',
  ].join('|'),
  'i',
);

const VIEW_CART: AgentAction = { type: 'view_cart' };
const CHECKOUT: AgentAction = { type: 'checkout' };

// ---------------------------------------------------------------- cart_view

export async function handleCartView(context: CartTurnContext): Promise<CartTurnResult> {
  const cart = await readCart(context);

  if (!cart) {
    return {
      ...EMPTY,
      message: "I couldn't read your cart just now. Please try again in a moment.",
      outcome: 'error',
    };
  }

  if (cart.items.length === 0) {
    return {
      ...EMPTY,
      cart,
      message: "Your cart is empty at the moment. Tell me what you're looking for and I'll find it.",
      outcome: 'cart_updated',
    };
  }

  const lines = cart.items
    .map(
      (item) =>
        // The colour is half the choice for a phone, and the product name does
        // not carry it — leaving it out gives the shopper nothing to check
        // before they pay.
        `${item.quantity} × ${item.name}${describeOptions(item.selectedOptions)} at ${formatPrice(item.unitPrice)}`,
    )
    .join(', ');

  const delivery =
    cart.shipping === 0 ? 'delivery is free' : `delivery is ${formatPrice(cart.shipping)}`;

  return {
    ...EMPTY,
    cart,
    message: `You have ${lines}. Subtotal ${formatPrice(cart.subtotal)}, ${delivery} — ${formatPrice(cart.total)} in total.`,
    outcome: 'cart_updated',
    actions: [VIEW_CART, CHECKOUT],
  };
}

// ----------------------------------------------------------------- cart_add

export async function handleCartAdd(
  message: string,
  context: CartTurnContext,
): Promise<CartTurnResult> {
  const reference = resolveReference(message, context.scope, {
    preferCart: false,
    modelPositions: context.modelPositions,
  });

  // A bare "add it" / "woh bhi add kar do" follows a reply that led with one
  // product. Taking that lead is the useful reading — and because the
  // confirmation names what went in, a wrong guess is one sentence to correct.
  const bareAdd =
    reference.productIds.length === 0 &&
    context.scope.shown.length > 0 &&
    BARE_ADD.test(message);

  const leadProduct = bareAdd ? context.scope.shown[0] : null;

  const quantityHint = extractQuantity(message);
  const quantity =
    quantityHint && quantityHint.relative !== 'decrease' ? Math.max(quantityHint.quantity, 1) : 1;

  if (reference.productIds.length === 0 && !leadProduct) {
    // Nothing on screen matched. Before giving up, try the catalogue: "add an
    // iPhone 17" is a perfectly clear instruction that simply has no reference
    // to resolve against, and answering it with "tell me what you'd like" when
    // they just did is the most annoying thing this assistant could do.
    const found = await findByPhrase(message);
    const narrowed = narrow(found, message);

    if (narrowed.options) {
      const question = askStorage(narrowed.options, quantity);
      return {
        ...EMPTY,
        message: question.message,
        outcome: 'clarify',
        pendingAction: question.pending,
      };
    }

    if (narrowed.product) {
      const next = await nextQuestionFor(narrowed.product, message, quantity);
      if (next.question) {
        return {
          ...EMPTY,
          message: next.question.message,
          outcome: 'clarify',
          pendingAction: next.question.pending,
        };
      }
      return addChosenVariant(narrowed.product.id, quantity, next.colour, context);
    }

    // Otherwise never guess. Ask, and say what the options were.
    const options = context.scope.shown
      .slice(0, 5)
      .map((product, index) => `${index + 1}. ${product.name}`)
      .join('\n');

    return {
      ...EMPTY,
      message:
        reference.confidence === 'ambiguous' && options
          ? `I'm not sure which one you mean. Which of these should I add?\n${options}`
          : context.scope.shown.length > 0
            ? `Which one would you like me to add?\n${options}`
            : "Tell me what you'd like and I'll find it first — then I can add it to your cart.",
      outcome: 'clarify',
    };
  }

  const productId = reference.productIds[0] ?? leadProduct!.productId;

  // A product picked off the screen can still be short a colour.
  const colours = await coloursFor(productId);
  const namedColour = colours.length > 0 ? statedColour(message, colours) : null;

  if (colours.length > 0 && !namedColour && !saysNoPreference(message)) {
    const shownName =
      context.scope.shown.find((shown) => shown.productId === productId)?.name ?? 'that one';
    const question = askColour({ id: productId, name: shownName }, colours, quantity);
    return {
      ...EMPTY,
      message: question.message,
      outcome: 'clarify',
      pendingAction: question.pending,
    };
  }

  return addChosenVariant(productId, quantity, namedColour, context, Boolean(leadProduct));
}

/**
 * Common colour words, for telling "Teal" — a colour we simply do not stock in
 * this model — apart from "show me laptops", which is a change of subject.
 *
 * A short message during a colour question is treated as an attempt at one
 * either way: at that point in the conversation there is very little else a
 * one or two word reply could be.
 */
const COLOUR_WORDS =
  /\b(black|white|blue|green|red|pink|purple|violet|orange|yellow|grey|gray|silver|gold|teal|sage|lavender|mist|cream|beige|bronze|copper|titanium|graphite|midnight|starlight|ultramarine|cobalt|natural|desert|space)\b/i;

function looksLikeColourAttempt(message: string, offered: string[]): boolean {
  if (COLOUR_WORDS.test(message)) return true;
  const words = message.trim().split(/\s+/);
  return words.length <= 2 && offered.length > 0 && !/\b(cart|checkout|order|price)\b/i.test(message);
}

/**
 * Interpret an answer to a parked variant question.
 *
 * Returns null when the message is not an answer at all — the shopper changed
 * the subject — so the caller can drop the parked add and handle it fresh
 * rather than insisting on a reply to a question nobody wants to finish.
 */
export async function handleVariantAnswer(
  message: string,
  selection: VariantSelection,
  context: CartTurnContext,
): Promise<CartTurnResult | null> {
  if (selection.stage === 'storage') {
    const chosenId = statedStorage(message, selection.options);
    if (!chosenId) return null;

    // Storage settled. Colour may still be open.
    const colours = await coloursFor(chosenId);
    const namedColour = colours.length > 0 ? statedColour(message, colours) : null;

    if (colours.length > 0 && !namedColour && !saysNoPreference(message)) {
      const label = selection.options.find((option) => option.id === chosenId)?.label ?? '';
      const question = askColour(
        { id: chosenId, name: label ? `${label} model` : 'that one' },
        colours,
        selection.quantity,
      );
      return {
        ...EMPTY,
        message: question.message,
        outcome: 'clarify',
        pendingAction: question.pending,
      };
    }

    return addChosenVariant(chosenId, selection.quantity, namedColour, context);
  }

  // stage === 'colour'
  if (!selection.productId) return null;

  if (saysNoPreference(message)) {
    return addChosenVariant(selection.productId, selection.quantity, null, context);
  }

  const colour = statedColour(message, selection.colours);
  if (colour) {
    return addChosenVariant(selection.productId, selection.quantity, colour, context);
  }

  // A colour we do not stock is still an answer to the question — the shopper
  // is choosing, they just named something we cannot sell them. Say so and
  // keep the choice open, rather than dropping the half-finished add and
  // silently starting a new search for the word they used.
  if (looksLikeColourAttempt(message, selection.colours)) {
    return {
      ...EMPTY,
      message: `I don't have that one, sorry. The ${selection.colours.length} colours available are: ${selection.colours.join(', ')}. Which would you like?`,
      outcome: 'clarify',
      pendingAction: buildPendingAction(
        'select_variant',
        { ...selection },
        'Choosing a colour',
      ),
    };
  }

  return null;
}

/**
 * Perform the add once every axis is settled.
 *
 * Shared by the ordinary path and by the variant conversation, so an iPhone
 * added after two questions goes through exactly the same tool call, audit
 * trail and attribution as one added in a single breath.
 */
export async function addChosenVariant(
  productId: string,
  quantity: number,
  colour: string | null,
  context: CartTurnContext,
  inferredPick = false,
): Promise<CartTurnResult> {
  const input = {
    product_id: productId,
    quantity,
    ...(colour ? { colour } : {}),
  };

  const result = await runTool('add_to_cart', input, {
    conversationId: context.conversationId,
    budget: context.budget,
    idempotencyKey: idempotencyKeyFor(context.conversationId, 'add_to_cart', input),
  });
  context.toolsUsed.push('add_to_cart');

  if (result.ok) {
    // Close the attribution loop: this add is what turns an impression into a
    // conversion, and it is only creditable because an impression row already
    // exists from when the product was shown.
    // The conversation is enough to find the impression: the chat route
    // stamps every impression row with it.
    const identity = { conversationId: context.conversationId };
    await markRecommendation(identity, productId, 'added_to_cart');
    await recordCommerceEvent('ai_add_to_cart', identity, { channel: 'ai', productId });
  }

  if (!result.ok) {
    return {
      ...EMPTY,
      // The registry passes stock/availability messages through verbatim —
      // they are written for the shopper.
      message: `I couldn't add that: ${result.error}`,
      outcome: 'error',
    };
  }

  const output = result.output as {
    cart: ToolCart;
    quantity: number;
    note: string | null;
  };
  const cart = toAgentCart(output.cart);
  const line = cart.items.find((item) => item.productId === productId);
  const name = line?.name ?? 'that product';

  // Say the colour back. It is the half of the choice the product name does
  // not carry, so leaving it out gives the shopper nothing to check.
  const colourSuffix = colour ? ` in ${colour}` : '';

  // When we inferred the product rather than being told, say so — the shopper
  // needs to be able to catch a wrong pick.
  const inferred = inferredPick ? ' (the one I suggested — say the word if you meant another)' : '';

  const confirmation = output.note
    ? `${output.note} Your cart total is now ${formatPrice(cart.total)}.`
    : `Added ${output.quantity > 1 ? `${output.quantity} × ` : ''}${name}${colourSuffix}${inferred} to your cart. That brings your total to ${formatPrice(cart.total)}.`;

  return {
    ...EMPTY,
    cart,
    message: confirmation,
    outcome: 'cart_updated',
    actions: [VIEW_CART, CHECKOUT],
  };
}

// -------------------------------------------------------------- cart_remove

export async function handleCartRemove(
  message: string,
  context: CartTurnContext,
): Promise<CartTurnResult> {
  if (context.scope.cart.length === 0) {
    return {
      ...EMPTY,
      message: 'Your cart is already empty — there is nothing to remove.',
      outcome: 'clarify',
    };
  }

  const reference = resolveReference(message, context.scope, { preferCart: true });

  // With one line in the cart, "remove it" can only mean that line. With
  // several, guessing would be worse than asking.
  const cartItemId =
    reference.cartItemIds[0] ??
    (context.scope.cart.length === 1 ? context.scope.cart[0].cartItemId : null);

  if (!cartItemId) {
    const options = context.scope.cart
      .map((line, index) => `${index + 1}. ${line.name}`)
      .join('\n');
    return {
      ...EMPTY,
      message: `Which one should I remove?\n${options}`,
      outcome: 'clarify',
    };
  }
  const input = { cart_item_id: cartItemId };

  const result = await runTool('remove_from_cart', input, {
    conversationId: context.conversationId,
    budget: context.budget,
    idempotencyKey: idempotencyKeyFor(context.conversationId, 'remove_from_cart', input),
  });
  context.toolsUsed.push('remove_from_cart');

  if (!result.ok) {
    return { ...EMPTY, message: `I couldn't remove that: ${result.error}`, outcome: 'error' };
  }

  const output = result.output as { cart: ToolCart; note: string | null };
  const cart = toAgentCart(output.cart);

  const tail =
    cart.items.length === 0
      ? 'Your cart is now empty.'
      : `Your cart total is now ${formatPrice(cart.total)}.`;

  return {
    ...EMPTY,
    cart,
    message: `${output.note ?? 'Removed it.'} ${tail}`,
    outcome: 'cart_updated',
    actions: cart.items.length > 0 ? [VIEW_CART, CHECKOUT] : [],
  };
}

// -------------------------------------------------------------- cart_update

export async function handleCartUpdate(
  message: string,
  context: CartTurnContext,
): Promise<CartTurnResult> {
  if (context.scope.cart.length === 0) {
    return {
      ...EMPTY,
      message: 'Your cart is empty, so there is no quantity to change yet.',
      outcome: 'clarify',
    };
  }

  const reference = resolveReference(message, context.scope, { preferCart: true });

  // With a single line in the cart, "make it two" is unambiguous.
  const cartItemId =
    reference.cartItemIds[0] ??
    (context.scope.cart.length === 1 ? context.scope.cart[0].cartItemId : null);

  if (!cartItemId) {
    const options = context.scope.cart
      .map((line, index) => `${index + 1}. ${line.name} (currently ${line.quantity})`)
      .join('\n');
    return {
      ...EMPTY,
      message: `Which item's quantity should I change?\n${options}`,
      outcome: 'clarify',
    };
  }

  const current = context.scope.cart.find((line) => line.cartItemId === cartItemId);
  const hint = extractQuantity(message);

  if (!hint) {
    return {
      ...EMPTY,
      message: `How many ${current?.name ?? 'of those'} would you like? You currently have ${current?.quantity ?? 1}.`,
      outcome: 'clarify',
    };
  }

  // A relative change is applied to what is actually in the cart, not to
  // whatever the model believed was there.
  const base = current?.quantity ?? 1;
  const target =
    hint.relative === 'increase'
      ? base + hint.quantity
      : hint.relative === 'decrease'
        ? base - hint.quantity
        : hint.quantity;

  const quantity = Math.max(0, Math.min(target, 20));
  const input = { cart_item_id: cartItemId, quantity };

  const result = await runTool('update_cart_quantity', input, {
    conversationId: context.conversationId,
    budget: context.budget,
    idempotencyKey: idempotencyKeyFor(context.conversationId, 'update_cart_quantity', input),
  });
  context.toolsUsed.push('update_cart_quantity');

  if (!result.ok) {
    return { ...EMPTY, message: `I couldn't change that: ${result.error}`, outcome: 'error' };
  }

  const output = result.output as { cart: ToolCart; quantity: number; note: string | null };
  const cart = toAgentCart(output.cart);

  const headline =
    output.quantity === 0
      ? `Removed ${current?.name ?? 'that item'} from your cart.`
      : `${current?.name ?? 'That item'} is now ${output.quantity} ${pluralise(output.quantity, 'unit')}.`;

  return {
    ...EMPTY,
    cart,
    message: `${output.note ?? headline} Your total is ${formatPrice(cart.total)}.`,
    outcome: 'cart_updated',
    actions: cart.items.length > 0 ? [VIEW_CART, CHECKOUT] : [],
  };
}

// --------------------------------------------------------------- cart_clear

/**
 * Clearing the cart never happens on the first ask. This turn only proposes
 * it; the registry additionally refuses to run `clear_cart` without
 * `confirmed`, so a model that skipped the question still cannot empty a cart.
 */
export async function handleCartClearRequest(
  context: CartTurnContext,
): Promise<CartTurnResult> {
  const cart = await readCart(context);

  if (!cart || cart.items.length === 0) {
    return {
      ...EMPTY,
      cart,
      message: 'Your cart is already empty.',
      outcome: 'cart_updated',
    };
  }

  const count = cart.itemCount;
  const summary = `Remove all ${count} ${pluralise(count, 'item')} from your cart (${formatPrice(cart.total)})`;

  return {
    ...EMPTY,
    cart,
    message: `You currently have ${count} ${pluralise(count, 'item')} in your cart, worth ${formatPrice(
      cart.total,
    )}. Do you want me to remove all of them?`,
    outcome: 'awaiting_confirmation',
    pendingAction: buildPendingAction('clear_cart', {}, summary),
    actions: [
      { type: 'confirm', action: 'clear_cart', label: 'Yes, clear it' },
      { type: 'cancel', action: 'clear_cart' },
    ],
  };
}

/** Runs only after the shopper has said yes in a turn of their own. */
export async function executeCartClear(context: CartTurnContext): Promise<CartTurnResult> {
  const result = await runTool('clear_cart', {}, {
    conversationId: context.conversationId,
    budget: context.budget,
    confirmed: true,
  });
  context.toolsUsed.push('clear_cart');

  if (!result.ok) {
    return { ...EMPTY, message: `I couldn't clear your cart: ${result.error}`, outcome: 'error' };
  }

  const output = result.output as { cart: ToolCart; note: string | null };
  return {
    ...EMPTY,
    cart: toAgentCart(output.cart),
    message: `${output.note ?? 'Cleared your cart.'} Let me know when you want to start again.`,
    outcome: 'cart_updated',
  };
}

// ----------------------------------------------------------------- checkout

export async function handleCheckout(context: CartTurnContext): Promise<CartTurnResult> {
  const result = await runTool('prepare_checkout', {}, {
    conversationId: context.conversationId,
    budget: context.budget,
  });
  context.toolsUsed.push('prepare_checkout');

  if (!result.ok) {
    return {
      ...EMPTY,
      message: "I couldn't prepare your checkout just now. Please try again in a moment.",
      outcome: 'error',
    };
  }

  const raw = result.output as {
    valid: boolean;
    items: Array<Record<string, unknown>>;
    subtotal: number;
    shipping: number;
    savings: number;
    total: number;
    currency: string;
    item_count: number;
    blockers: string[];
    changes: Array<{ kind: string; product_name: string; message: string }>;
    summary: string;
    checkout_url: string;
  };

  const checkout: AgentCheckoutPayload = {
    valid: raw.valid,
    items: raw.items.map((item) => ({
      cartItemId: item.cart_item_id as string,
      productId: item.product_id as string,
      selectedOptions: (item.selected_options as Record<string, string> | undefined) ?? {},
      name: item.name as string,
      brand: item.brand as string,
      quantity: item.quantity as number,
      unitPrice: item.unit_price as number,
      lineTotal: item.total_price as number,
      image: (item.image_url as string | null) ?? null,
      available: item.available as boolean,
      availableQuantity: item.available_quantity as number,
      priceChanged: false,
    })),
    subtotal: raw.subtotal,
    shipping: raw.shipping,
    savings: raw.savings,
    total: raw.total,
    currency: raw.currency,
    itemCount: raw.item_count,
    blockers: raw.blockers,
    changes: raw.changes.map((change) => ({
      kind: change.kind,
      productName: change.product_name,
      message: change.message,
    })),
    summary: raw.summary,
    checkoutUrl: raw.checkout_url,
    createsOrder: false,
    createsPayment: false,
  };

  if (raw.item_count === 0) {
    return {
      ...EMPTY,
      checkout,
      message: "There's nothing in your cart to check out yet.",
      outcome: 'checkout_blocked',
    };
  }

  // Anything that changed is said out loud before the total, never after.
  const changeNote = checkout.changes.length > 0 ? `${checkout.changes[0].message} ` : '';

  if (!raw.valid) {
    return {
      ...EMPTY,
      checkout,
      message: `${changeNote}I can't take you to checkout until that's sorted. Tell me what you'd like to do and I'll adjust the cart.`,
      outcome: 'checkout_blocked',
      actions: [VIEW_CART],
    };
  }

  return {
    ...EMPTY,
    checkout,
    message: `${changeNote}${raw.summary} Here's the summary — continue to checkout when you're ready.`,
    outcome: 'checkout_ready',
    actions: [CHECKOUT, VIEW_CART],
  };
}

// --------------------------------------------------------------- cross-sell

export interface CrossSellTurn extends CartTurnResult {
  candidates: CrossSellCandidate[];
}

/**
 * Suggest accessories for an anchor product — the most recent cart line, or
 * the top product the shopper was just shown.
 */
export async function handleCrossSell(
  context: CartTurnContext,
  anchor: ProductSummary | null,
): Promise<CartTurnResult> {
  // Never recommend something the shopper already has in their basket.
  const alreadyInCart = new Set(context.scope.cart.map((line) => line.productId));
  if (!anchor) {
    return {
      ...EMPTY,
      message:
        "Tell me which product you're pairing things with and I'll suggest what goes well with it.",
      outcome: 'clarify',
    };
  }

  const categories = accessoryCategoriesFor(anchor.category.slug);
  if (categories.length === 0) {
    return {
      ...EMPTY,
      message: `I don't have accessories in the catalogue that specifically pair with the ${anchor.name}.`,
      outcome: 'empty',
    };
  }

  // Search each paired category through the tool layer, then rank in code.
  const batches = await Promise.all(
    categories.slice(0, 4).map(async (slug) => {
      const result = await runTool(
        'search_products',
        { category: slug, in_stock_only: true, sort: 'rating', limit: 6 },
        { conversationId: context.conversationId, budget: context.budget },
      );
      return result.ok ? (result.output as { products: Array<{ id: string }> }).products : [];
    }),
  );
  context.toolsUsed.push('search_products');

  const ids = new Set(batches.flat().map((product) => product.id));
  if (ids.size === 0) {
    return {
      ...EMPTY,
      message: `Nothing that pairs with the ${anchor.name} is in stock right now.`,
      outcome: 'empty',
    };
  }

  // Re-read as full summaries so scoring sees real specs and stock.
  const summaries = (await loadSummaries(categories.slice(0, 4))).filter(
    (product) => !alreadyInCart.has(product.id),
  );
  const ranked = rankCrossSell(anchor, summaries, context.requirements.useCases, 3);

  if (ranked.length === 0) {
    return {
      ...EMPTY,
      message: `I couldn't find a good accessory match for the ${anchor.name} in stock right now.`,
      outcome: 'empty',
    };
  }

  const top = ranked[0];
  const message = `Since you're getting the ${anchor.name}, ${top.reason.replace(
    / \(₹[\d,]+\)$/,
    '',
  )}. I found the ${top.product.name} at ${formatPrice(top.product.price)}.`;

  return {
    ...EMPTY,
    message,
    outcome: 'matches',
    products: ranked.map((candidate) => crossSellToPayload(candidate)),
    actions: ranked.map((candidate) => ({
      type: 'add_to_cart' as const,
      productId: candidate.product.id,
      label: `Add ${candidate.product.name}`,
    })),
  };
}

async function loadSummaries(categorySlugs: string[]): Promise<ProductSummary[]> {
  const batches = await Promise.all(
    categorySlugs.map(async (slug) => {
      const { products } = await listProducts({
        page: 1,
        limit: 6,
        category: slug,
        sort: 'rating',
        inStock: true,
      } as Parameters<typeof listProducts>[0]);
      return products;
    }),
  );

  const seen = new Set<string>();
  return batches.flat().filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

function crossSellToPayload(candidate: CrossSellCandidate): RecommendedProductPayload {
  const { product } = candidate;
  return {
    productId: product.id,
    name: product.name,
    brand: product.brand,
    slug: product.slug,
    price: product.price,
    compareAtPrice: product.compareAtPrice,
    currency: product.currency,
    rating: product.rating,
    reviewCount: product.reviewCount,
    image: product.image,
    available: product.availability.inStock,
    availableQuantity: product.availability.available,
    lowStock: product.availability.lowStock,
    score: candidate.score,
    reason: candidate.reason,
    matchReasons: [candidate.reason],
    limitations: product.availability.lowStock
      ? [`only ${product.availability.available} left in stock`]
      : [],
    keySpecs: {},
  };
}
