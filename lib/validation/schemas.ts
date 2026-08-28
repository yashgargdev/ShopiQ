import { z } from 'zod';

/**
 * Every value that crosses the API boundary is parsed here first.
 *
 * Note what is deliberately absent: prices. A client never supplies a price for
 * a cart line or an order — the server reads it from public.products at the
 * moment of the write. See public.create_order_from_cart().
 */

export const uuidSchema = z.string().uuid('Must be a valid id.');

export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Must be a lowercase hyphenated slug.');

/** Product routes accept either a UUID or a slug in the [id] position. */
export const productRefSchema = z.union([uuidSchema, slugSchema]);

export const SORT_OPTIONS = [
  'relevance',
  'price_asc',
  'price_desc',
  'rating',
  'newest',
  'discount',
] as const;

export type SortOption = (typeof SORT_OPTIONS)[number];

/** Comma-separated list in a query string → string[]. */
const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1).max(80)).max(20));

const boolish = z
  .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
  .transform((value) => value === 'true' || value === '1');

const positiveMoney = z.coerce
  .number()
  .min(0, 'Cannot be negative.')
  .max(100_000_000, 'Unreasonably large.');

export const productQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(20),
  category: slugSchema.optional(),
  brand: csv.optional(),
  minPrice: positiveMoney.optional(),
  maxPrice: positiveMoney.optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  inStock: boolish.optional(),
  featured: boolish.optional(),
  sort: z.enum(SORT_OPTIONS).default('relevance'),
  q: z.string().trim().max(120).optional(),
});

export type ProductQuery = z.infer<typeof productQuerySchema>;

export const searchQuerySchema = productQuerySchema.extend({
  q: z.string().trim().min(1, 'Enter something to search for.').max(120),
});

// ---------------------------------------------------------------------- cart

export const quantitySchema = z.coerce
  .number()
  .int('Quantity must be a whole number.')
  .min(1, 'Quantity must be at least 1.')
  .max(20, 'You can order at most 20 of one item.');

/**
 * `.strict()` is load-bearing here. Without it, a body carrying `price`,
 * `total` or `currency` would have those fields quietly stripped and the
 * request would succeed — which looks, to a caller, like the price was
 * accepted. Rejecting outright makes the boundary visible: the client never
 * gets a say in what anything costs.
 */
export const addToCartSchema = z
  .object({
    productId: uuidSchema,
    quantity: quantitySchema.default(1),
  })
  .strict();

export const updateCartItemSchema = z
  .object({
    quantity: z.coerce.number().int().min(0).max(20),
  })
  .strict();

// ------------------------------------------------------------------- orders

export const shippingAddressSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter a name.').max(120),
  phone: z
    .string()
    .trim()
    .regex(/^[+0-9][0-9 \-]{7,17}$/, 'Enter a valid phone number.'),
  line1: z.string().trim().min(4, 'Enter a street address.').max(200),
  line2: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().min(2, 'Enter a city.').max(80),
  state: z.string().trim().min(2, 'Enter a state.').max(80),
  postalCode: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Enter a 6-digit PIN code.'),
  country: z.string().trim().length(2).default('IN'),
});

export const createOrderSchema = z.object({
  contactEmail: z.string().trim().email('Enter a valid email address.').max(200),
  contactPhone: z
    .string()
    .trim()
    .regex(/^[+0-9][0-9 \-]{7,17}$/, 'Enter a valid phone number.')
    .optional()
    .or(z.literal('')),
  shippingAddress: shippingAddressSchema,
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  saveAddress: z.boolean().optional().default(false),
});

export const ORDER_STATUS_VALUES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;

export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUS_VALUES),
});

// ----------------------------------------------------------------- merchant

const specEntrySchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, 'Use lower_snake_case for spec keys.')
    .max(60),
  label: z.string().trim().min(1).max(80),
  /** Numbers stay numbers so the AI can filter on ranges later. */
  value: z.union([z.string().trim().min(1).max(300), z.number()]),
  unit: z.string().trim().max(20).optional().or(z.literal('')),
});

/**
 * The base shape, kept free of refinements so both the create and the partial
 * update schema can derive from it — Zod refuses .partial() on a refined
 * object.
 */
const merchantProductBase = z.object({
  name: z.string().trim().min(2, 'Enter a product name.').max(200),
  slug: slugSchema.optional(),
  brand: z.string().trim().min(1, 'Enter a brand.').max(80),
  categoryId: uuidSchema,
  sku: z
    .string()
    .trim()
    .min(1, 'Enter a SKU.')
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'SKU may only use letters, numbers, dot, dash and underscore.'),
  price: positiveMoney,
  compareAtPrice: positiveMoney.optional().nullable(),
  currency: z.literal('INR').default('INR'),
  shortDescription: z.string().trim().max(300).optional().or(z.literal('')),
  description: z.string().trim().max(5000).optional().or(z.literal('')),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  rating: z.coerce.number().min(0).max(5).default(0),
  reviewCount: z.coerce.number().int().min(0).max(10_000_000).default(0),
  isFeatured: z.boolean().default(false),
  isActive: z.boolean().default(true),
  specs: z.array(specEntrySchema).max(60).default([]),
  quantity: z.coerce.number().int().min(0).max(1_000_000).default(0),
  lowStockThreshold: z.coerce.number().int().min(0).max(10_000).default(5),
});

/** A discount must be a real discount. */
const compareAtNotBelowPrice = {
  path: ['compareAtPrice'],
  message: 'Compare-at price must be at least the selling price.',
};

export const merchantProductSchema = merchantProductBase.refine(
  (value) => value.compareAtPrice == null || value.compareAtPrice >= value.price,
  compareAtNotBelowPrice,
);

/**
 * Partial update. The cross-field check only applies when the request actually
 * carries both fields — a PATCH that changes only the name must not be
 * rejected for a price it never mentioned.
 */
export const merchantProductUpdateSchema = merchantProductBase
  .partial()
  .refine(
    (value) =>
      value.compareAtPrice == null ||
      value.price === undefined ||
      value.compareAtPrice >= value.price,
    compareAtNotBelowPrice,
  );

export const inventoryUpdateSchema = z.object({
  productId: uuidSchema,
  quantity: z.coerce.number().int().min(0).max(1_000_000),
  lowStockThreshold: z.coerce.number().int().min(0).max(10_000).optional(),
});

// --------------------------------------------------------------------- auth

export const signUpSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(200),
  password: z
    .string()
    .min(8, 'Use at least 8 characters.')
    .max(72, 'Passwords are limited to 72 characters.'),
  fullName: z.string().trim().min(2, 'Enter your name.').max(120),
});

export const signInSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(200),
  password: z.string().min(1, 'Enter your password.').max(72),
});

/** Parse URLSearchParams with a schema, collapsing repeats to the last value. */
export function parseSearchParams<T extends z.ZodTypeAny>(
  schema: T,
  params: URLSearchParams,
): z.infer<T> {
  const raw: Record<string, string> = {};
  params.forEach((value, key) => {
    if (value !== '') raw[key] = value;
  });
  return schema.parse(raw);
}
