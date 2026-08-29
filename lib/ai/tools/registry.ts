import 'server-only';

import { z } from 'zod';

import { ApiError } from '@/lib/api/response';
import { adminClient } from '@/lib/supabase/admin';
import type { ProviderToolDefinition } from '@/lib/ai/provider';
import {
  checkInventory,
  compareProducts,
  getCategories,
  getProduct,
  getRelatedProducts,
  searchProducts,
} from './implementations';
import {
  addToCart,
  clearCart,
  getCart,
  prepareCheckoutTool,
  removeFromCart,
  updateCartQuantity,
} from './cart';
import {
  createPaymentTool,
  getCheckoutConfirmationTool,
  getOrderStatusTool,
  getPaymentStatusTool,
} from './payment';
import {
  cancelOrderTool,
  getOrderTool,
  getProfileTool,
  listMyOrdersTool,
  requestSupportTool,
  updateProfileTool,
} from './account-tools';
import { findCompatibleProductsTool, findRecommendationsTool } from './catalog-tools';
import { findCompatibleProductsInput, findRecommendationsInput } from './schemas';
import {
  cancelOrderInput,
  getOrderInput,
  getProfileInput,
  listMyOrdersInput,
  requestSupportInput,
  updateProfileInput,
} from './schemas';
import {
  addToCartInput,
  checkInventoryInput,
  createPaymentInput,
  getCheckoutConfirmationInput,
  getOrderStatusInput,
  getPaymentStatusInput,
  clearCartInput,
  compareProductsInput,
  getCartInput,
  getCategoriesInput,
  getProductInput,
  getRelatedProductsInput,
  prepareCheckoutInput,
  removeFromCartInput,
  searchProductsInput,
  updateCartQuantityInput,
} from './schemas';

/**
 * The tool registry.
 *
 * This is the security boundary between the model and ShopiQ's commerce data.
 * A tool call only runs if:
 *   1. the name is in this table (an allowlist, not a lookup by string), and
 *   2. the arguments parse against that tool's Zod schema.
 *
 * Anything else is rejected and logged with status 'rejected'. The model never
 * receives a database handle, a service-role key, or a SQL string.
 *
 * Phase 3 introduced the first tools that CHANGE commerce state. Three
 * properties keep that safe:
 *
 *   `mutates`              marks a tool as a write, for logging and for the
 *                          agent's own routing.
 *   `requiresConfirmation` blocks execution unless the caller passes
 *                          `confirmed: true` — which the agent only does after
 *                          the shopper has said yes in a separate turn.
 *   idempotency            a repeated write with the same key inside a short
 *                          window returns the first result instead of running
 *                          again, so a retried tool call cannot double-add.
 *
 * What is still impossible by construction: creating an order, taking a
 * payment, or naming a price. Those tools do not exist here, so there is
 * nothing for a model to call.
 */

/**
 * The permission ladder. Each rung can do strictly more than the one below,
 * and each rung has to satisfy strictly more before it runs.
 *
 *   1 READ     catalogue and cart reads. No state changes.
 *   2 SHOPPING cart writes. Reversible, cheap to undo.
 *   3 CHECKOUT validate and price. Creates nothing.
 *   4 MONEY    starts a charge. Requires an authenticated customer, a valid
 *              cart, live prices, live stock, a matching cart hash and an
 *              unexpired explicit confirmation — see lib/payments/authorize.ts.
 */
export type ToolLevel = 1 | 2 | 3 | 4 | 5;

/** Extra context a tool may need. Never supplied by the model. */
export interface ToolRunMeta {
  conversationId?: string | null;
}

export interface ToolDescriptor<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  run: (input: TInput, meta?: ToolRunMeta) => Promise<TOutput>;
  /** True for tools that change commerce state. */
  mutates: boolean;
  /** Destructive or high-impact: needs an explicit yes in its own turn. */
  requiresConfirmation: boolean;
  /** Safe to de-duplicate on retry within the idempotency window. */
  idempotent: boolean;
  /** Permission rung. */
  level: ToolLevel;
  /**
   * Declared risk. Derived from the level rather than hand-set, so a tool
   * cannot be promoted to level 4 while still describing itself as low risk.
   */
  risk: ToolRisk;
  /** Whether the tool needs a signed-in customer to mean anything. */
  requiresAuth: boolean;
}

/** Risk classes, one per permission rung. */
export type ToolRisk = 'low' | 'medium' | 'high' | 'critical';

const RISK_BY_LEVEL: Record<ToolLevel, ToolRisk> = {
  1: 'low',
  2: 'medium',
  3: 'medium',
  4: 'critical',
  // Level 5 reads and writes a named person's own data. Not critical — it
  // moves no money — but higher than shopping, because the failure mode is
  // touching the wrong customer rather than the wrong product.
  5: 'high',
};

function describe<TInput, TOutput>(
  descriptor: Omit<
    ToolDescriptor<TInput, TOutput>,
    'requiresConfirmation' | 'idempotent' | 'level' | 'risk' | 'requiresAuth'
  > &
    Partial<Pick<ToolDescriptor<TInput, TOutput>, 'requiresConfirmation' | 'idempotent' | 'level'>>,
): ToolDescriptor<TInput, TOutput> {
  const level = descriptor.level ?? 1;
  return {
    requiresConfirmation: false,
    idempotent: false,
    level: 1,
    // Risk and auth follow from the rung, so they cannot drift out of step
    // with what the tool is actually allowed to do.
    risk: RISK_BY_LEVEL[level],
    requiresAuth: level >= 2,
    ...descriptor,
  };
}

const TOOLS = {
  search_products: describe({
    name: 'search_products',
    description:
      'Search the ShopiQ catalogue. Filter by free text, category slug, brand, price range, minimum rating, stock, and typed specifications (e.g. {"ram_gb_min": 16, "gpu": "RTX 4060"}). Returns real products with live prices and stock.',
    schema: searchProductsInput,
    run: searchProducts,
    mutates: false,
  }),

  get_product: describe({
    name: 'get_product',
    description:
      'Get full details for one product by id or slug: description, price, rating, images, every specification, live availability and related products.',
    schema: getProductInput,
    run: getProduct,
    mutates: false,
  }),

  compare_products: describe({
    name: 'compare_products',
    description:
      'Compare 2 to 4 products attribute by attribute using real catalogue values. Returns aligned rows with a winner per row where one exists.',
    schema: compareProductsInput,
    run: compareProducts,
    mutates: false,
  }),

  check_inventory: describe({
    name: 'check_inventory',
    description: 'Check whether a product is in stock right now and how many units are available.',
    schema: checkInventoryInput,
    run: checkInventory,
    mutates: false,
  }),

  get_categories: describe({
    name: 'get_categories',
    description:
      'List the active ShopiQ categories with product counts. Use this to map what the shopper said onto a real category slug before searching.',
    schema: getCategoriesInput,
    run: getCategories,
    mutates: false,
  }),

  find_recommendations: describe({
    name: 'find_recommendations',
    description:
      'What to suggest alongside a product the customer is looking at or has bought: accessories, ecosystem items, compatible parts. Returns real in-stock products with a score and the reason each was chosen. Optionally narrow by relationship type or category, or exclude brands the customer has ruled out.',
    schema: findRecommendationsInput,
    run: findRecommendationsTool,
    mutates: false,
  }),

  find_compatible_products: describe({
    name: 'find_compatible_products',
    description:
      'Products in a category that will actually work with a given product — the right memory for a board, a television a console can drive. Returns only what meets the requirement; an empty list means nothing in stock qualifies, which is the honest answer.',
    schema: findCompatibleProductsInput,
    run: findCompatibleProductsTool,
    mutates: false,
  }),

  get_related_products: describe({
    name: 'get_related_products',
    description:
      'Find products related to a given product through real catalogue relationships: same_category, same_brand, or accessories that pair with it.',
    schema: getRelatedProductsInput,
    run: getRelatedProducts,
    mutates: false,
  }),

  // ------------------------------------------------------------------ cart
  // The customer is always the signed-in (or guest-session) shopper resolved
  // server-side. None of these tools accepts an identity, a price or a total.

  get_cart: describe({
    name: 'get_cart',
    description:
      "Read the current customer's cart: line items with live prices and stock, plus the server-calculated subtotal, delivery and total. Takes no arguments — the customer is identified from their session.",
    schema: getCartInput,
    run: getCart,
    mutates: false,
  }),

  add_to_cart: describe({
    name: 'add_to_cart',
    description:
      'Add a product to the cart by product id or slug. Quantity defaults to 1. If stock cannot cover the request the quantity is reduced and the result says so in `note` — relay that, do not claim the requested quantity.',
    schema: addToCartInput,
    run: addToCart,
    mutates: true,
    idempotent: true,
    level: 2,
  }),

  remove_from_cart: describe({
    name: 'remove_from_cart',
    description:
      'Remove one line from the cart by its cart_item_id (from get_cart). Only the current customer\'s own lines can be removed.',
    schema: removeFromCartInput,
    run: removeFromCart,
    mutates: true,
    idempotent: true,
    level: 2,
  }),

  update_cart_quantity: describe({
    name: 'update_cart_quantity',
    description:
      'Set a cart line to an exact quantity by cart_item_id. Quantity 0 removes the line. If stock is lower than asked, the quantity is reduced and `note` explains it.',
    schema: updateCartQuantityInput,
    run: updateCartQuantity,
    mutates: true,
    idempotent: true,
    level: 2,
  }),

  clear_cart: describe({
    name: 'clear_cart',
    description:
      'Remove EVERY item from the cart. Destructive: ask the customer to confirm first, in their own words, and only call this after they have said yes.',
    schema: clearCartInput,
    run: clearCart,
    mutates: true,
    requiresConfirmation: true,
    level: 2,
  }),

  // -------------------------------------------------------------- checkout
  prepare_checkout: describe({
    name: 'prepare_checkout',
    description:
      'Validate and price the cart, returning an order summary the customer can review. Does NOT create an order and does NOT take payment — it is a preview. Reports any price change or stock problem in `changes` and `blockers`.',
    schema: prepareCheckoutInput,
    run: prepareCheckoutTool,
    mutates: false,
    level: 3,
  }),

  // ------------------------------------------------------------- level 4
  // Money actions. `create_payment` starts a charge; the other three only
  // read. None of them accepts an amount, a price or a customer id.

  get_checkout_confirmation: describe({
    name: 'get_checkout_confirmation',
    description:
      'Check whether the customer has a live checkout confirmation, what total it covers and whether it has expired. Read-only. Call this before offering to pay so you can re-quote instead of being refused.',
    schema: getCheckoutConfirmationInput,
    run: getCheckoutConfirmationTool,
    mutates: false,
    level: 3,
  }),

  create_payment: describe({
    name: 'create_payment',
    description:
      'Start a Razorpay payment for the confirmed checkout. Takes NO arguments: the amount, the customer and the cart all come from the server. Only call this AFTER the customer has explicitly approved the exact total and get_checkout_confirmation reports confirmed. It does not charge anyone — it prepares the provider checkout the customer completes themselves. If it returns success:false, tell the customer the reason; do not retry.',
    schema: createPaymentInput,
    run: createPaymentTool,
    mutates: true,
    idempotent: true,
    // The real gate is authorizePayment() inside the implementation, which
    // re-checks all seventeen conditions. This flag is declared as well so
    // that IF anyone ever routes this through runTool(), the registry refuses
    // it without an explicit confirmation rather than relying on the callee.
    requiresConfirmation: true,
    level: 4,
  }),

  get_payment_status: describe({
    name: 'get_payment_status',
    description:
      "Read the authoritative status of the customer's payment. Use `settled` to decide what to say: only settled:true means the money went through. If status is verification_pending you must say the payment is still being verified — never that it succeeded.",
    schema: getPaymentStatusInput,
    run: getPaymentStatusTool,
    mutates: false,
    level: 4,
  }),

  get_order_status: describe({
    name: 'get_order_status',
    description:
      "Read the customer's order from the database: order number, items, quantities, unit prices, total, payment status and whether it is confirmed. Use this for any question about what they bought or paid — never answer from memory.",
    schema: getOrderStatusInput,
    run: getOrderStatusTool,
    mutates: false,
    level: 4,
  }),

  // ------------------------------------------------- account & support (5)
  //
  // Level 5 is the customer's OWN personal data and their placed orders.
  // Every one of these resolves identity from the session inside its
  // implementation and none takes a customer id, so a model cannot address
  // another shopper's account even by hallucinating a perfectly-formed uuid.

  get_profile: describe({
    name: 'get_profile',
    description:
      "Read the signed-in customer's own name, email, phone and default delivery address. Requires sign-in; if they are not signed in, ask them to sign in rather than guessing their details.",
    schema: getProfileInput,
    run: getProfileTool,
    mutates: false,
    level: 5,
  }),

  update_profile: describe({
    name: 'update_profile',
    description:
      "Update the signed-in customer's own name, phone or default delivery address. The email address cannot be changed here — it is the sign-in credential. Only send fields the customer actually asked to change.",
    schema: updateProfileInput,
    run: updateProfileTool,
    mutates: true,
    idempotent: true,
    level: 5,
  }),

  list_my_orders: describe({
    name: 'list_my_orders',
    description:
      "List the signed-in customer's own recent orders with status and totals. Use this when they ask about 'my orders' without naming one.",
    schema: listMyOrdersInput,
    run: listMyOrdersTool,
    mutates: false,
    level: 5,
  }),

  get_order: describe({
    name: 'get_order',
    description:
      "Read one of the signed-in customer's orders by its order number, including whether it can still be cancelled or returned. Never state an order detail you did not read here.",
    schema: getOrderInput,
    run: getOrderTool,
    mutates: false,
    level: 5,
  }),

  cancel_order: describe({
    name: 'cancel_order',
    description:
      "Cancel one of the signed-in customer's own orders. Only works while the order is pending, confirmed or processing. Ask the customer to confirm before calling this — it cannot be undone.",
    schema: cancelOrderInput,
    run: cancelOrderTool,
    mutates: true,
    requiresConfirmation: true,
    idempotent: true,
    level: 5,
  }),

  request_support: describe({
    name: 'request_support',
    description:
      "Open a return or replacement request for one of the signed-in customer's delivered orders. Records the request only — it does not issue a refund. Ask for a brief reason first.",
    schema: requestSupportInput,
    run: requestSupportTool,
    mutates: true,
    idempotent: true,
    level: 5,
  }),
} as const;

export type ToolName = keyof typeof TOOLS;

export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}

// ---------------------------------------------------------------------- result

export type ToolResult =
  | { ok: true; tool: ToolName; output: unknown; durationMs: number; deduped?: boolean }
  | {
      ok: false;
      tool: string;
      error: string;
      code:
        | 'UNKNOWN_TOOL'
        | 'INVALID_ARGUMENTS'
        | 'NOT_FOUND'
        | 'CONFLICT'
        | 'NEEDS_CONFIRMATION'
        | 'FAILED';
      durationMs: number;
    };

export interface ToolCallContext {
  conversationId?: string | null;
  messageId?: string | null;
  /** Guards against a runaway loop burning the catalogue. */
  budget?: ToolBudget;
  /**
   * Set only by the agent, and only after the shopper has explicitly agreed in
   * a turn of their own. A model asking for a destructive tool cannot set this
   * — it is not part of any tool's argument schema.
   */
  confirmed?: boolean;
  /**
   * Stable key for a write. A repeat within IDEMPOTENCY_WINDOW_MS returns the
   * first result instead of running again.
   */
  idempotencyKey?: string | null;
}

/** How long a completed write stays de-duplicable. */
export const IDEMPOTENCY_WINDOW_MS = 60_000;

/** Metadata the agent and the UI use to decide how to present an action. */
export function toolMetadata(name: ToolName): {
  name: ToolName;
  mutates: boolean;
  requiresConfirmation: boolean;
  level: ToolLevel;
  risk: ToolRisk;
  requiresAuth: boolean;
} {
  const descriptor = TOOLS[name] as ToolDescriptor;
  return {
    name,
    mutates: descriptor.mutates,
    requiresConfirmation: descriptor.requiresConfirmation,
    level: descriptor.level,
    risk: descriptor.risk,
    requiresAuth: descriptor.requiresAuth,
  };
}

/** Tools that can start a charge. Exactly one, and it is worth being able to assert that. */
export const MONEY_TOOL_NAMES = TOOL_NAMES.filter(
  (name) => (TOOLS[name] as ToolDescriptor).level === 4 && (TOOLS[name] as ToolDescriptor).mutates,
);

export const WRITE_TOOL_NAMES = TOOL_NAMES.filter(
  (name) => (TOOLS[name] as ToolDescriptor).mutates,
);

/** Caps how many tool calls one chat turn may make. */
export class ToolBudget {
  private used = 0;
  private readonly max: number;

  constructor(max = 8) {
    this.max = max;
  }

  consume(): boolean {
    if (this.used >= this.max) return false;
    this.used += 1;
    return true;
  }
  get remaining(): number {
    return Math.max(this.max - this.used, 0);
  }
  get spent(): number {
    return this.used;
  }
}

/**
 * Execute a tool by name. This is the ONLY way the AI reaches commerce data.
 *
 * Never throws for a bad tool name or bad arguments — those are normal model
 * behaviour and come back as a structured error the agent can recover from.
 */
export async function runTool(
  name: string,
  rawInput: unknown,
  context: ToolCallContext = {},
): Promise<ToolResult> {
  const startedAt = Date.now();

  if (!isToolName(name)) {
    const result: ToolResult = {
      ok: false,
      tool: name,
      code: 'UNKNOWN_TOOL',
      error: `Unknown tool "${String(name).slice(0, 60)}". Allowed tools: ${TOOL_NAMES.join(', ')}.`,
      durationMs: Date.now() - startedAt,
    };
    await logToolCall(context, name, rawInput, null, 'rejected', result.error, result.durationMs);
    return result;
  }

  if (context.budget && !context.budget.consume()) {
    const result: ToolResult = {
      ok: false,
      tool: name,
      code: 'FAILED',
      error: 'Tool call budget for this turn is exhausted.',
      durationMs: Date.now() - startedAt,
    };
    await logToolCall(context, name, rawInput, null, 'rejected', result.error, result.durationMs);
    return result;
  }

  const descriptor = TOOLS[name] as ToolDescriptor;
  const parsed = descriptor.schema.safeParse(rawInput);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    const result: ToolResult = {
      ok: false,
      tool: name,
      code: 'INVALID_ARGUMENTS',
      error: `Invalid arguments for ${name} — ${detail}`,
      durationMs: Date.now() - startedAt,
    };
    await logToolCall(context, name, rawInput, null, 'rejected', result.error, result.durationMs);
    return result;
  }

  // A destructive tool does not run on the model's say-so. `confirmed` is set
  // by the agent only after the shopper has answered yes in their own turn, and
  // it is not part of any tool's argument schema — so a model cannot forge it.
  if (descriptor.requiresConfirmation && !context.confirmed) {
    const result: ToolResult = {
      ok: false,
      tool: name,
      code: 'NEEDS_CONFIRMATION',
      error: `${name} needs the customer's explicit confirmation before it can run. Ask them first, then call it again once they agree.`,
      durationMs: Date.now() - startedAt,
    };
    await logToolCall(context, name, parsed.data, null, 'rejected', result.error, result.durationMs);
    return result;
  }

  // Idempotency: an accidental retry of the same write returns the first
  // result rather than adding the same laptop twice.
  const idempotencyKey =
    descriptor.idempotent && context.idempotencyKey ? context.idempotencyKey : null;

  if (idempotencyKey) {
    const replayed = await replayIdempotent(idempotencyKey);
    if (replayed !== null) {
      return {
        ok: true,
        tool: name,
        output: replayed,
        durationMs: Date.now() - startedAt,
        deduped: true,
      };
    }
  }

  try {
    const output = await descriptor.run(parsed.data, {
      conversationId: context.conversationId ?? null,
    });
    const durationMs = Date.now() - startedAt;

    if (idempotencyKey) await recordIdempotent(idempotencyKey, context, name, output);

    await logToolCall(context, name, parsed.data, output, 'success', null, durationMs);
    return { ok: true, tool: name, output, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const apiError = error instanceof ApiError ? error : null;
    const notFound = apiError?.code === 'NOT_FOUND';
    const conflictLike =
      apiError?.code === 'CONFLICT' ||
      apiError?.code === 'INVENTORY_CONFLICT' ||
      apiError?.code === 'BAD_REQUEST';

    // A stock or availability problem is the shopper's business — its message
    // is written for them and is safe to pass through. Anything else gets a
    // generic line, because Postgres errors name tables and constraints.
    const message = conflictLike
      ? apiError!.message
      : notFound
        ? 'No such product in the ShopiQ catalogue.'
        : 'The catalogue could not be reached.';

    // The raw error is logged server-side; the model only sees the safe text.
    await logToolCall(
      context,
      name,
      parsed.data,
      null,
      'error',
      error instanceof Error ? error.message : String(error),
      durationMs,
    );

    return {
      ok: false,
      tool: name,
      code: notFound ? 'NOT_FOUND' : conflictLike ? 'CONFLICT' : 'FAILED',
      error: message,
      durationMs,
    };
  }
}

// --------------------------------------------------------------- idempotency

/**
 * Return a previous result for this key when it is still inside the window.
 * Best-effort: if the lookup fails we simply run the tool again, which is the
 * behaviour we had before idempotency existed.
 */
async function replayIdempotent(key: string): Promise<unknown | null> {
  try {
    const { data } = await adminClient()
      .from('ai_action_keys')
      .select('result, created_at')
      .eq('key', key)
      .maybeSingle();

    if (!data) return null;

    const age = Date.now() - new Date(data.created_at as string).getTime();
    if (age > IDEMPOTENCY_WINDOW_MS) return null;

    return data.result ?? null;
  } catch {
    return null;
  }
}

async function recordIdempotent(
  key: string,
  context: ToolCallContext,
  toolName: string,
  output: unknown,
): Promise<void> {
  try {
    await adminClient()
      .from('ai_action_keys')
      .upsert(
        {
          key,
          conversation_id: context.conversationId ?? null,
          tool_name: toolName,
          result: truncateForLog(output),
          created_at: new Date().toISOString(),
        },
        { onConflict: 'key' },
      );
  } catch {
    // Losing the dedupe record only costs us a duplicate-protection window.
  }
}

/**
 * Deterministic key for one write: same conversation, same tool, same
 * arguments. A model that emits the identical call twice in a turn gets the
 * first result back the second time.
 */
export function idempotencyKeyFor(
  conversationId: string | null | undefined,
  toolName: string,
  input: unknown,
): string | null {
  if (!conversationId) return null;
  try {
    const canonical = JSON.stringify(input, Object.keys(input as object).sort());
    return `${conversationId}:${toolName}:${canonical}`.slice(0, 400);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- logging

const MAX_LOGGED_BYTES = 12_000;

/**
 * Append to public.ai_tool_logs. Best-effort: an observability failure must
 * never break a shopper's conversation.
 */
async function logToolCall(
  context: ToolCallContext,
  toolName: string,
  input: unknown,
  output: unknown,
  status: 'success' | 'error' | 'rejected',
  error: string | null,
  durationMs: number,
): Promise<void> {
  if (!context.conversationId) return;

  try {
    await adminClient()
      .from('ai_tool_logs')
      .insert({
        conversation_id: context.conversationId,
        message_id: context.messageId ?? null,
        tool_name: toolName.slice(0, 120),
        input: truncateForLog(input),
        output: output === null ? null : truncateForLog(output),
        status,
        error: error ? error.slice(0, 1000) : null,
        execution_time_ms: durationMs,
      });
  } catch {
    // Swallow: logging is diagnostic, not part of the request contract.
  }
}

/** Keeps a 20-product result from bloating the log table. */
function truncateForLog(value: unknown): unknown {
  try {
    const json = JSON.stringify(value ?? null);
    if (json.length <= MAX_LOGGED_BYTES) return value ?? null;
    return {
      truncated: true,
      bytes: json.length,
      preview: json.slice(0, 2000),
    };
  } catch {
    return { unserialisable: true };
  }
}

// ------------------------------------------------------- provider tool schemas

/**
 * JSON Schema for each tool, for providers that do native tool calling.
 * Generated from the same Zod schemas that validate execution, so the model's
 * view and the enforcement can never drift apart.
 */
export function providerToolDefinitions(only?: ToolName[]): ProviderToolDefinition[] {
  const names = only ?? TOOL_NAMES;
  return names.map((name) => {
    const descriptor = TOOLS[name] as ToolDescriptor;
    return {
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: z.toJSONSchema(descriptor.schema as z.ZodType, {
        io: 'input',
        unrepresentable: 'any',
      }) as Record<string, unknown>,
    };
  });
}
