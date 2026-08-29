import { z } from 'zod';

/**
 * Argument schemas for every AI tool.
 *
 * Nothing reaches the catalogue without passing through here first. The agent
 * proposes arguments; these schemas decide what is actually run — the security
 * principle from Phase 2 §39 ("the AI can request an action, the backend
 * decides whether it is allowed").
 */

export const uuidSchema = z.string().uuid('Must be a product id.');

/** Tools accept a UUID or a slug, matching the public product API. */
export const productRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^([0-9a-fA-F-]{36}|[a-z0-9]+(-[a-z0-9]+)*)$/,
    'Must be a product id or slug.',
  );

const money = z.number().min(0).max(100_000_000);

/**
 * Specification filters, e.g. { ram_gb_min: 16, gpu: "RTX 4060" }.
 *
 * Keys are constrained to the catalogue's snake_case spec vocabulary so a
 * model cannot smuggle arbitrary text into the JSONB path.
 */
const specKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, 'Spec keys are lower_snake_case.')
  .max(60);

export const specFiltersSchema = z
  .record(specKey, z.union([z.string().trim().min(1).max(120), z.number(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 12, {
    message: 'At most 12 specification filters.',
  });

export const SORT_VALUES = [
  'relevance',
  'price_asc',
  'price_desc',
  'rating',
  'newest',
  'discount',
] as const;

export const searchProductsInput = z
  .object({
    query: z.string().trim().max(200).nullish(),
    category: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Category must be a slug.')
      .max(80)
      .nullish(),
    brand: z
      .union([z.string().trim().max(80), z.array(z.string().trim().min(1).max(80)).max(10)])
      .nullish(),
    min_price: money.nullish(),
    max_price: money.nullish(),
    min_rating: z.number().min(0).max(5).nullish(),
    filters: specFiltersSchema.nullish(),
    in_stock_only: z.boolean().nullish(),
    sort: z.enum(SORT_VALUES).nullish(),
    limit: z.number().int().min(1).max(20).nullish(),
  })
  .strict()
  .refine(
    (value) =>
      value.min_price == null || value.max_price == null || value.min_price <= value.max_price,
    { path: ['min_price'], message: 'min_price cannot exceed max_price.' },
  );

export const getProductInput = z
  .object({ product_id: productRefSchema })
  .strict();

export const compareProductsInput = z
  .object({
    product_ids: z
      .array(productRefSchema)
      .min(2, 'Comparison needs at least two products.')
      .max(4, 'Compare at most four products at a time.'),
  })
  .strict();

export const checkInventoryInput = z
  .object({ product_id: productRefSchema })
  .strict();

export const getCategoriesInput = z
  .object({
    /** When true, include the top-level departments as well as leaf categories. */
    include_parents: z.boolean().nullish(),
  })
  .strict();

/**
 * Recommendations for a product the shopper is looking at.
 *
 * The tool takes a product and a KIND of relationship — never a list of
 * products to suggest. What comes back is decided by the rules and the live
 * catalogue, so the model cannot nominate the answer it wants.
 */
export const findRecommendationsInput = z
  .object({
    product_id: productRefSchema,
    type: z
      .enum([
        'cross_sell',
        'upsell',
        'alternative',
        'accessory',
        'compatible',
        'frequently_bought_together',
        'ecosystem',
        'replacement',
        'upgrade',
      ])
      .nullish(),
    /** Narrow to one category, for "what TV goes with this?". */
    category: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Category must be a slug.')
      .max(80)
      .nullish(),
    limit: z.number().int().min(1).max(5).nullish(),
    /** Brands the shopper has ruled out. Applied as a filter, not a penalty. */
    exclude_brands: z.array(z.string().trim().min(1).max(80)).max(10).nullish(),
  })
  .strict();

/**
 * Products in a category that actually work with another product.
 *
 * Separate from find_recommendations because the question is different: not
 * "what else might they like" but "what will physically work with this".
 */
export const findCompatibleProductsInput = z
  .object({
    product_id: productRefSchema,
    category: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Category must be a slug.')
      .max(80),
    limit: z.number().int().min(1).max(5).nullish(),
  })
  .strict();

export const getRelatedProductsInput = z
  .object({
    product_id: productRefSchema,
    relationship: z
      .enum(['same_category', 'same_brand', 'accessories', 'auto'])
      .nullish(),
    limit: z.number().int().min(1).max(10).nullish(),
  })
  .strict();

// ---------------------------------------------------------------------- cart
//
// Every one of these is `.strict()`, which is the point. There is no
// `price`, `total`, `currency`, `customer_id` or `cart_id` field for the model
// to fill in — an attempt to send one is a validation error, not a silently
// ignored extra. Identity and money come from the server, always.

/** The highest quantity a single tool call may add or set. */
export const MAX_TOOL_QUANTITY = 20;

const quantity = z
  .number()
  .int('Quantity must be a whole number.')
  .min(1, 'Quantity must be at least 1.')
  .max(MAX_TOOL_QUANTITY, `Quantity cannot exceed ${MAX_TOOL_QUANTITY} per item.`);

export const getCartInput = z.object({}).strict();

export const addToCartInput = z
  .object({
    product_id: productRefSchema,
    quantity: quantity.nullish(),
    /**
     * Shopper-chosen options, currently just colour. Accepted as a request:
     * the implementation checks the value against the colours the product
     * actually has images for and drops anything else, so a hallucinated
     * "Midnight Green" cannot reach a cart line or an order.
     */
    colour: z.string().trim().min(1).max(40).nullish(),
  })
  .strict();

export const removeFromCartInput = z
  .object({ cart_item_id: uuidSchema })
  .strict();

export const updateCartQuantityInput = z
  .object({
    cart_item_id: uuidSchema,
    // 0 is allowed here and means "remove the line".
    quantity: z.number().int().min(0).max(MAX_TOOL_QUANTITY),
  })
  .strict();

export const clearCartInput = z.object({}).strict();

export const prepareCheckoutInput = z.object({}).strict();

// ------------------------------------------------------------------- payment
//
// The money tools. `create_payment` takes NO arguments at all — not an amount,
// not a currency, not a cart id, not a confirmation id. Everything is derived
// server-side from the session and the live cart, so there is no field for a
// model to fill in with a number it invented, and no argument it can vary to
// get a different answer out of the authorization check.

export const createPaymentInput = z.object({}).strict();

export const getPaymentStatusInput = z
  .object({
    /** Omit for the customer's most recent payment. */
    payment_id: uuidSchema.nullish(),
  })
  .strict();

export const getOrderStatusInput = z
  .object({
    /** Omit for the customer's most recent order. */
    order_id: uuidSchema.nullish(),
  })
  .strict();

export const getCheckoutConfirmationInput = z.object({}).strict();

export type GetCartInput = z.infer<typeof getCartInput>;
export type AddToCartInput = z.infer<typeof addToCartInput>;
export type RemoveFromCartInput = z.infer<typeof removeFromCartInput>;
export type UpdateCartQuantityInput = z.infer<typeof updateCartQuantityInput>;
export type ClearCartInput = z.infer<typeof clearCartInput>;
export type PrepareCheckoutInput = z.infer<typeof prepareCheckoutInput>;
export type CreatePaymentInput = z.infer<typeof createPaymentInput>;
export type GetPaymentStatusInput = z.infer<typeof getPaymentStatusInput>;
export type GetOrderStatusInput = z.infer<typeof getOrderStatusInput>;
export type GetCheckoutConfirmationInput = z.infer<typeof getCheckoutConfirmationInput>;

export type SearchProductsInput = z.infer<typeof searchProductsInput>;
export type GetProductInput = z.infer<typeof getProductInput>;
export type CompareProductsInput = z.infer<typeof compareProductsInput>;
export type CheckInventoryInput = z.infer<typeof checkInventoryInput>;
export type GetCategoriesInput = z.infer<typeof getCategoriesInput>;
export type GetRelatedProductsInput = z.infer<typeof getRelatedProductsInput>;
export type FindRecommendationsInput = z.infer<typeof findRecommendationsInput>;
export type FindCompatibleProductsInput = z.infer<typeof findCompatibleProductsInput>;

/**
 * Translate the tool-facing `filters` object into the database's filter
 * language. `*_min` / `*_max` suffixes become range comparisons; everything
 * else is an equality or substring match depending on its type.
 */
export interface DbSpecFilter {
  key: string;
  op: 'gte' | 'lte' | 'eq' | 'contains';
  value: string;
}

export function toDbSpecFilters(
  filters: Record<string, string | number | boolean> | null | undefined,
): DbSpecFilter[] {
  if (!filters) return [];

  const out: DbSpecFilter[] = [];
  for (const [rawKey, rawValue] of Object.entries(filters)) {
    if (rawValue === null || rawValue === undefined || rawValue === '') continue;

    if (rawKey.endsWith('_min') && typeof rawValue === 'number') {
      out.push({ key: rawKey.slice(0, -4), op: 'gte', value: String(rawValue) });
    } else if (rawKey.endsWith('_max') && typeof rawValue === 'number') {
      out.push({ key: rawKey.slice(0, -4), op: 'lte', value: String(rawValue) });
    } else if (typeof rawValue === 'number') {
      out.push({ key: rawKey, op: 'eq', value: String(rawValue) });
    } else if (typeof rawValue === 'boolean') {
      out.push({ key: rawKey, op: 'contains', value: rawValue ? 'yes' : 'no' });
    } else {
      // Text specs are stored as prose ("NVIDIA RTX 4060 8 GB"), so a
      // substring match is the useful comparison, not equality.
      out.push({ key: rawKey, op: 'contains', value: rawValue });
    }
  }
  return out;
}

// -------------------------------------------------------- account support
//
// Like the cart schemas, every one of these is `.strict()` and NONE has a
// customer_id, email or account field. Identity comes from the session inside
// the implementation, so the model has nowhere to name a customer — a
// hallucinated id is a validation error rather than an access-control bug.

export const getProfileInput = z.object({}).strict();

export const updateProfileInput = z
  .object({
    full_name: z.string().trim().min(2).max(120).nullish(),
    phone: z.string().trim().max(30).nullish(),
    address: z
      .object({
        line1: z.string().trim().min(1).max(200),
        line2: z.string().trim().max(200).nullish(),
        city: z.string().trim().min(1).max(100),
        state: z.string().trim().max(100).nullish(),
        postal_code: z.string().trim().max(20).nullish(),
        country: z.string().trim().max(60).nullish(),
      })
      .strict()
      .nullish(),
  })
  .strict()
  // An update that changes nothing is a sign the model misread the request.
  .refine(
    (value) => value.full_name != null || value.phone != null || value.address != null,
    { message: 'Name, phone or address must be supplied.' },
  );

export const listMyOrdersInput = z
  .object({ limit: z.number().int().min(1).max(20).nullish() })
  .strict();

/** Order numbers look like SQ-2026-1000. */
const orderNumberSchema = z
  .string()
  .trim()
  .min(4)
  .max(40)
  .regex(/^[A-Za-z0-9-]+$/, 'That does not look like an order number.');

export const getOrderInput = z.object({ order_number: orderNumberSchema }).strict();

export const cancelOrderInput = z.object({ order_number: orderNumberSchema }).strict();

export const requestSupportInput = z
  .object({
    order_number: orderNumberSchema,
    kind: z.enum(['return', 'replacement']),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type GetProfileInput = z.infer<typeof getProfileInput>;
export type UpdateProfileInput = z.infer<typeof updateProfileInput>;
export type ListMyOrdersInput = z.infer<typeof listMyOrdersInput>;
export type GetOrderInput = z.infer<typeof getOrderInput>;
export type CancelOrderInput = z.infer<typeof cancelOrderInput>;
export type RequestSupportInput = z.infer<typeof requestSupportInput>;
