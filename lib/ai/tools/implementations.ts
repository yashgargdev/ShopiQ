import 'server-only';

import { ApiError } from '@/lib/api/response';
import {
  getProductDetail,
  getStockFor,
  listCategories,
  listProducts,
  type SpecFilter,
} from '@/lib/products/queries';
import { aspectLabel, summariseProductReviews } from '@/lib/reviews/queries';
import type { ProductDetail, ProductSummary } from '@/types';
import {
  toDbSpecFilters,
  type CheckInventoryInput,
  type CompareProductsInput,
  type GetCategoriesInput,
  type GetProductInput,
  type GetProductReviewsInput,
  type GetRelatedProductsInput,
  type SearchProductsInput,
} from './schemas';

/**
 * The six read-only commerce tools.
 *
 * Every one goes through the Phase 1 query layer, which goes through Supabase
 * RPCs and RLS. There is no SQL here and no service-role client — the AI's
 * reach is exactly the reach of the public storefront, minus the write paths.
 *
 * Return shapes are deliberately narrow: the model gets what it needs to
 * reason and nothing else (no internal ids beyond the product id, no
 * reserved-stock figures, no timestamps).
 */

// --------------------------------------------------------------- shared shapes

export interface ToolProductCard {
  id: string;
  name: string;
  slug: string;
  brand: string;
  price: number;
  currency: string;
  compare_at_price: number | null;
  rating: number;
  review_count: number;
  category: string;
  available: boolean;
  available_quantity: number;
  key_specs: Record<string, string | number>;
}

/**
 * The specs most useful for reasoning, per category family. Keeping this list
 * short matters: dumping all 10+ specs per product into the model's context
 * for a 20-product search is both noisy and expensive.
 */
const KEY_SPEC_ORDER = [
  'processor',
  'gpu',
  'ram_gb',
  'storage_gb',
  // Weight sits above display specs deliberately: "is it light enough" is a
  // question shoppers actually ask, and the engine scores portability on it.
  'weight_kg',
  'display_size',
  'refresh_rate_hz',
  'battery_hours',
  'battery_wh',
  'battery_mah',
  'type',
  'noise_cancellation',
  'connection',
  'switch_type',
  'sensor_dpi',
  'panel_type',
  'material',
  'capacity_l',
  'water_resistance',
  'os',
];

export function pickKeySpecs(
  specs: Record<string, unknown>,
  limit = 6,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};

  for (const key of KEY_SPEC_ORDER) {
    if (Object.keys(out).length >= limit) break;
    const value = specs?.[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }

  // Top up with whatever else the product has, so sparse categories still show
  // something useful.
  if (Object.keys(out).length < limit) {
    for (const [key, value] of Object.entries(specs ?? {})) {
      if (Object.keys(out).length >= limit) break;
      if (key in out) continue;
      if (typeof value === 'string' || typeof value === 'number') out[key] = value;
    }
  }
  return out;
}

export function toToolProductCard(product: ProductSummary): ToolProductCard {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    brand: product.brand,
    price: product.price,
    currency: product.currency,
    compare_at_price: product.compareAtPrice,
    rating: product.rating,
    review_count: product.reviewCount,
    category: product.category.name,
    available: product.availability.inStock,
    available_quantity: product.availability.available,
    key_specs: pickKeySpecs(product.specs as Record<string, unknown>),
  };
}

// ------------------------------------------------------------- search_products

export interface SearchProductsResult {
  products: ToolProductCard[];
  total: number;
  /** Echoed back so the agent can tell the shopper what was actually applied. */
  applied_filters: Record<string, unknown>;
}

export async function searchProducts(
  input: SearchProductsInput,
): Promise<SearchProductsResult> {
  const brands = input.brand
    ? Array.isArray(input.brand)
      ? input.brand
      : [input.brand]
    : undefined;

  const specFilters: SpecFilter[] = toDbSpecFilters(input.filters ?? undefined);
  const limit = input.limit ?? 10;

  const { products, pagination } = await listProducts(
    {
      page: 1,
      limit,
      q: input.query ?? undefined,
      category: input.category ?? undefined,
      brand: brands,
      minPrice: input.min_price ?? undefined,
      maxPrice: input.max_price ?? undefined,
      rating: input.min_rating ?? undefined,
      inStock: input.in_stock_only ?? undefined,
      sort: input.sort ?? 'relevance',
    } as Parameters<typeof listProducts>[0],
    specFilters,
  );

  return {
    products: products.map(toToolProductCard),
    total: pagination.total,
    applied_filters: {
      query: input.query ?? null,
      category: input.category ?? null,
      brand: brands ?? null,
      min_price: input.min_price ?? null,
      max_price: input.max_price ?? null,
      min_rating: input.min_rating ?? null,
      in_stock_only: input.in_stock_only ?? false,
      spec_filters: specFilters.length ? specFilters : null,
      sort: input.sort ?? 'relevance',
    },
  };
}

/** Used by the recommendation engine, which needs the full product objects. */
export async function searchProductSummaries(
  input: SearchProductsInput,
): Promise<{ products: ProductSummary[]; total: number }> {
  const brands = input.brand
    ? Array.isArray(input.brand)
      ? input.brand
      : [input.brand]
    : undefined;

  const { products, pagination } = await listProducts(
    {
      page: 1,
      limit: input.limit ?? 20,
      q: input.query ?? undefined,
      category: input.category ?? undefined,
      brand: brands,
      minPrice: input.min_price ?? undefined,
      maxPrice: input.max_price ?? undefined,
      rating: input.min_rating ?? undefined,
      inStock: input.in_stock_only ?? undefined,
      sort: input.sort ?? 'relevance',
    } as Parameters<typeof listProducts>[0],
    toDbSpecFilters(input.filters ?? undefined),
  );

  return { products, total: pagination.total };
}

// ----------------------------------------------------------------- get_product

export interface GetProductResult {
  id: string;
  name: string;
  slug: string;
  brand: string;
  description: string | null;
  short_description: string | null;
  price: number;
  compare_at_price: number | null;
  currency: string;
  rating: number;
  review_count: number;
  category: string;
  images: string[];
  specifications: Record<string, string | number>;
  available: boolean;
  available_quantity: number;
  low_stock: boolean;
  related_products: Array<{ id: string; name: string; brand: string; price: number }>;
}

export async function getProduct(input: GetProductInput): Promise<GetProductResult> {
  const product = await getProductDetail(input.product_id);
  return shapeProductDetail(product);
}

function shapeProductDetail(product: ProductDetail): GetProductResult {
  const specifications: Record<string, string | number> = {};
  for (const spec of product.specifications) {
    specifications[spec.key] = spec.unit ? `${spec.value} ${spec.unit}` : spec.value;
  }

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    brand: product.brand,
    description: product.description,
    short_description: product.shortDescription,
    price: product.price,
    compare_at_price: product.compareAtPrice,
    currency: product.currency,
    rating: product.rating,
    review_count: product.reviewCount,
    category: product.category.name,
    images: product.images.map((image) => image.url),
    specifications,
    available: product.availability.inStock,
    available_quantity: product.availability.available,
    low_stock: product.availability.lowStock,
    related_products: product.related.map((related) => ({
      id: related.id,
      name: related.name,
      brand: related.brand,
      price: related.price,
    })),
  };
}

// ------------------------------------------------------------ compare_products

export interface CompareProductsResult {
  products: Array<{
    id: string;
    name: string;
    brand: string;
    price: number;
    currency: string;
    rating: number;
    available: boolean;
    specifications: Record<string, string | number>;
  }>;
  comparison: Record<
    string,
    {
      label: string;
      values: Array<string | number | null>;
      winner: number | null;
      higher_is_better: boolean | null;
    }
  >;
}

/**
 * Numeric specs where a bigger number is better, and where a smaller one is.
 * Anything not listed is compared for difference only — the tool never guesses
 * which of two strings is "better".
 */
const HIGHER_IS_BETTER = new Set([
  'ram_gb',
  'storage_gb',
  'display_size',
  'refresh_rate_hz',
  'battery_hours',
  'battery_wh',
  'battery_mah',
  'brightness_nits',
  'rear_camera_mp',
  'front_camera_mp',
  'charging_w',
  'sensor_dpi',
  'buttons',
  'polling_rate_hz',
  'driver_mm',
  'capacity_l',
  'capacity_ml',
  'power_w',
  'warranty_months',
  'gsm',
]);

const LOWER_IS_BETTER = new Set(['weight_kg', 'weight_g', 'response_time_ms', 'price']);

const SPEC_LABELS: Record<string, string> = {
  price: 'Price',
  rating: 'Rating',
  processor: 'Processor',
  gpu: 'Graphics',
  ram_gb: 'Memory (GB)',
  storage_gb: 'Storage (GB)',
  storage_type: 'Storage type',
  display_size: 'Display size (in)',
  display_resolution: 'Resolution',
  display_type: 'Display type',
  refresh_rate_hz: 'Refresh rate (Hz)',
  weight_kg: 'Weight (kg)',
  weight_g: 'Weight (g)',
  battery_hours: 'Battery life (hours)',
  battery_wh: 'Battery (Wh)',
  battery_mah: 'Battery (mAh)',
  brightness_nits: 'Brightness (nits)',
  noise_cancellation: 'Noise cancellation',
  bluetooth_version: 'Bluetooth',
  water_resistance: 'Water resistance',
  os: 'Operating system',
  type: 'Type',
  connection: 'Connection',
  switch_type: 'Switches',
  sensor_dpi: 'Sensor (DPI)',
  panel_type: 'Panel',
  material: 'Material',
  capacity_l: 'Capacity (L)',
  charging_w: 'Fast charging (W)',
  rear_camera_mp: 'Rear camera (MP)',
  front_camera_mp: 'Front camera (MP)',
  warranty_months: 'Warranty (months)',
};

function labelFor(key: string): string {
  return (
    SPEC_LABELS[key] ??
    key.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase())
  );
}

export async function compareProducts(
  input: CompareProductsInput,
): Promise<CompareProductsResult> {
  const details = await Promise.all(
    input.product_ids.map((ref) => getProductDetail(ref)),
  );

  const products = details.map((product) => {
    const specifications: Record<string, string | number> = {};
    for (const spec of product.specifications) {
      specifications[spec.key] = spec.value;
    }
    return {
      id: product.id,
      name: product.name,
      brand: product.brand,
      price: product.price,
      currency: product.currency,
      rating: product.rating,
      available: product.availability.inStock,
      specifications,
    };
  });

  const comparison: CompareProductsResult['comparison'] = {};

  // Price and rating always compare; then every spec key any product has.
  addRow(
    comparison,
    'price',
    details.map((product) => product.price),
  );
  addRow(
    comparison,
    'rating',
    details.map((product) => product.rating),
  );

  const specKeys = new Set<string>();
  for (const product of details) {
    for (const spec of product.specifications) specKeys.add(spec.key);
  }

  for (const key of specKeys) {
    const values = details.map((product) => {
      const spec = product.specifications.find((entry) => entry.key === key);
      return spec ? spec.value : null;
    });
    // A row where nobody differs teaches the shopper nothing.
    const distinct = new Set(values.map((value) => String(value)));
    if (distinct.size > 1) addRow(comparison, key, values);
  }

  return { products, comparison };
}

function addRow(
  comparison: CompareProductsResult['comparison'],
  key: string,
  values: Array<string | number | null>,
): void {
  const higherIsBetter = HIGHER_IS_BETTER.has(key)
    ? true
    : LOWER_IS_BETTER.has(key)
      ? false
      : null;

  let winner: number | null = null;

  if (higherIsBetter !== null) {
    const numeric = values.map((value) => (typeof value === 'number' ? value : null));
    const present = numeric.filter((value): value is number => value !== null);

    if (present.length > 1) {
      const best = higherIsBetter ? Math.max(...present) : Math.min(...present);
      // A tie has no winner — do not invent one.
      if (present.filter((value) => value === best).length === 1) {
        winner = numeric.findIndex((value) => value === best);
      }
    }
  }

  comparison[key] = { label: labelFor(key), values, winner, higher_is_better: higherIsBetter };
}

// ------------------------------------------------------------- check_inventory

export interface CheckInventoryResult {
  product_id: string;
  available: boolean;
  quantity: number;
}

export async function checkInventory(
  input: CheckInventoryInput,
): Promise<CheckInventoryResult> {
  // Resolve slug → id through the product API, so an inactive or unknown
  // product produces the same 404 the storefront would give.
  const product = await getProductDetail(input.product_id);
  const stock = await getStockFor([product.id]);
  const availability = stock.get(product.id);

  return {
    product_id: product.id,
    available: availability?.inStock ?? false,
    quantity: availability?.available ?? 0,
  };
}

// -------------------------------------------------------------- get_categories

export interface GetCategoriesResult {
  categories: Array<{
    id: string;
    name: string;
    slug: string;
    product_count: number;
    parent: string | null;
  }>;
}

export async function getCategories(
  input: GetCategoriesInput,
): Promise<GetCategoriesResult> {
  const all = await listCategories();
  const byId = new Map(all.map((category) => [category.id, category]));

  const scoped = input.include_parents
    ? all
    : all.filter((category) => category.parentId !== null);

  return {
    categories: scoped.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      product_count: category.productCount ?? 0,
      parent: category.parentId ? (byId.get(category.parentId)?.name ?? null) : null,
    })),
  };
}

// -------------------------------------------------------- get_related_products

export interface GetRelatedProductsResult {
  product_id: string;
  relationship: string;
  products: ToolProductCard[];
}

/**
 * Related products come from real catalogue relationships — same category,
 * same brand, or the accessory categories that pair with the product's
 * department. Nothing here is random, and nothing is model-generated.
 */
const ACCESSORY_CATEGORIES: Record<string, string[]> = {
  laptops: ['laptop-accessories', 'bags', 'mice', 'keyboards', 'monitors', 'home-accessories'],
  'gaming-laptops': ['gaming-accessories', 'mice', 'keyboards', 'gaming-headsets', 'monitors'],
  smartphones: ['headphones', 'home-accessories'],
  monitors: ['keyboards', 'mice', 'gaming-accessories'],
  keyboards: ['mice', 'gaming-accessories'],
  mice: ['keyboards', 'gaming-accessories'],
  headphones: ['smartphones', 'bags'],
  'gaming-headsets': ['controllers', 'gaming-accessories'],
  controllers: ['gaming-headsets', 'gaming-accessories'],
  shoes: ['t-shirts', 'jackets', 'bags'],
  't-shirts': ['jackets', 'shoes'],
  jackets: ['t-shirts', 'shoes', 'bags'],
  bags: ['laptops', 'home-accessories'],
};

export async function getRelatedProducts(
  input: GetRelatedProductsInput,
): Promise<GetRelatedProductsResult> {
  const product = await getProductDetail(input.product_id);
  const limit = input.limit ?? 4;
  const relationship = input.relationship ?? 'auto';

  const exclude = (candidates: ProductSummary[]) =>
    candidates.filter((candidate) => candidate.id !== product.id).slice(0, limit);

  if (relationship === 'same_brand') {
    const { products } = await listProducts({
      page: 1,
      limit: limit + 1,
      brand: [product.brand],
      sort: 'rating',
    } as Parameters<typeof listProducts>[0]);
    return {
      product_id: product.id,
      relationship: 'same_brand',
      products: exclude(products).map(toToolProductCard),
    };
  }

  if (relationship === 'accessories') {
    const products = await accessoriesFor(product.category.slug, limit);
    return {
      product_id: product.id,
      relationship: 'accessories',
      products: products.map(toToolProductCard),
    };
  }

  if (relationship === 'same_category') {
    return {
      product_id: product.id,
      relationship: 'same_category',
      products: exclude(product.related).map(toToolProductCard),
    };
  }

  // auto: same category first (that is what "related" usually means), topped up
  // with accessories when the category is thin.
  const sameCategory = exclude(product.related);
  if (sameCategory.length >= limit) {
    return {
      product_id: product.id,
      relationship: 'same_category',
      products: sameCategory.map(toToolProductCard),
    };
  }

  const accessories = await accessoriesFor(product.category.slug, limit - sameCategory.length);
  const seen = new Set(sameCategory.map((item) => item.id));
  const merged = [
    ...sameCategory,
    ...accessories.filter((item) => item.id !== product.id && !seen.has(item.id)),
  ].slice(0, limit);

  return {
    product_id: product.id,
    relationship: merged.length > sameCategory.length ? 'same_category+accessories' : 'same_category',
    products: merged.map(toToolProductCard),
  };
}

async function accessoriesFor(categorySlug: string, limit: number): Promise<ProductSummary[]> {
  const slugs = ACCESSORY_CATEGORIES[categorySlug];
  if (!slugs || slugs.length === 0 || limit <= 0) return [];

  const batches = await Promise.all(
    slugs.slice(0, 3).map(async (slug) => {
      const { products } = await listProducts({
        page: 1,
        limit: Math.max(2, Math.ceil(limit / 2)),
        category: slug,
        sort: 'rating',
        inStock: true,
      } as Parameters<typeof listProducts>[0]);
      return products;
    }),
  );

  // Round-robin across accessory categories so one category cannot dominate.
  const merged: ProductSummary[] = [];
  const longest = Math.max(0, ...batches.map((batch) => batch.length));
  for (let index = 0; index < longest && merged.length < limit; index++) {
    for (const batch of batches) {
      if (merged.length >= limit) break;
      if (batch[index]) merged.push(batch[index]);
    }
  }
  return merged;
}

/** Re-exported so the registry can map thrown API errors onto tool errors. */
export { ApiError };

// ------------------------------------------------------ get_product_reviews

export interface GetProductReviewsResult {
  product_id: string;
  product_name: string;
  /** Null when nothing has been reviewed — say so rather than filling it in. */
  summary: {
    count: number;
    average: number;
    distribution: Record<string, number>;
    praised: Array<{ aspect: string; positive: number; negative: number }>;
    criticised: Array<{ aspect: string; positive: number; negative: number }>;
    quotes: Array<{ rating: number; body: string }>;
    verified_share: number;
    demo_data: true;
  } | null;
}

/**
 * What buyers said about a product, already counted.
 *
 * The tallies are computed in code so the assistant reports numbers it was
 * given rather than an impression formed by reading twenty reviews — and so a
 * complaint mentioned twice is never reported as "buyers complain about it".
 */
export async function getProductReviews(
  input: GetProductReviewsInput,
): Promise<GetProductReviewsResult> {
  const product = await getProductDetail(input.product_id);
  const summary = await summariseProductReviews(product.id);

  return {
    product_id: product.id,
    product_name: product.name,
    summary: summary
      ? {
          count: summary.count,
          average: summary.average,
          distribution: {
            '5': summary.distribution[5],
            '4': summary.distribution[4],
            '3': summary.distribution[3],
            '2': summary.distribution[2],
            '1': summary.distribution[1],
          },
          praised: summary.praised.map((entry) => ({
            aspect: aspectLabel(entry.aspect),
            positive: entry.positive,
            negative: entry.negative,
          })),
          criticised: summary.criticised.map((entry) => ({
            aspect: aspectLabel(entry.aspect),
            positive: entry.positive,
            negative: entry.negative,
          })),
          quotes: summary.quotes.map((quote) => ({ rating: quote.rating, body: quote.body })),
          verified_share: summary.verifiedShare,
          demo_data: true,
        }
      : null,
  };
}
