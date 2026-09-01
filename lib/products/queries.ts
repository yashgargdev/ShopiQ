import 'server-only';

import { cache } from 'react';

import { notFound } from '@/lib/api/response';
import { supabaseServer } from '@/lib/supabase/server';
import { buildPagination } from '@/lib/api/response';
import type { ProductQuery } from '@/lib/validation/schemas';
import type {
  Availability,
  CatalogFacets,
  Category,
  ProductDetail,
  ProductImage,
  ProductListResponse,
  ProductSpec,
  ProductSummary,
} from '@/types';

/**
 * The catalogue read layer.
 *
 * Listing and search both go through the public.search_products() function, so
 * filtering, ranking and pagination have exactly one implementation. Detail
 * reads use PostgREST with nested selects, which keeps RLS in the picture.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SearchRow {
  product: ProductSummary;
  total_count: number;
}

/** Range/equality filter over a product's typed specifications. */
export interface SpecFilter {
  key: string;
  op: 'gte' | 'lte' | 'eq' | 'contains';
  value: string;
}

export async function listProducts(
  query: ProductQuery,
  /**
   * Optional specification filters ("ram_gb >= 16"). Used by the Phase 2 AI
   * tool layer; the public storefront routes do not set it.
   */
  specFilters?: SpecFilter[],
): Promise<ProductListResponse> {
  const supabase = await supabaseServer();
  const limit = query.limit;
  const offset = (query.page - 1) * limit;

  const { data, error } = await supabase.rpc('search_products', {
    p_query: query.q ?? null,
    p_category_slug: query.category ?? null,
    p_brands: query.brand?.length ? query.brand : null,
    p_min_price: query.minPrice ?? null,
    p_max_price: query.maxPrice ?? null,
    p_min_rating: query.rating ?? null,
    p_in_stock_only: query.inStock ?? false,
    p_featured_only: query.featured ?? false,
    p_sort: query.sort,
    p_limit: limit,
    p_offset: offset,
    p_spec_filters: specFilters?.length ? specFilters : null,
  });

  if (error) throw error;

  const rows = (data ?? []) as SearchRow[];
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;

  return {
    products: rows.map((row) => row.product),
    pagination: buildPagination(query.page, limit, total),
  };
}

/** Convenience wrapper for the homepage rails. */
export async function listFeaturedProducts(limit = 8): Promise<ProductSummary[]> {
  const { products } = await listProducts({
    page: 1,
    limit,
    sort: 'rating',
    featured: true,
  } as ProductQuery);
  return products;
}

export const listCategories = cache(async (): Promise<Category[]> => {
  const supabase = await supabaseServer();

  const [{ data: categories, error }, counts] = await Promise.all([
    supabase
      .from('categories')
      .select('id, name, slug, description, image_url, parent_id, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    productCountsByCategory(),
  ]);

  if (error) throw error;

  const rows = (categories ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    description: (row.description as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    parentId: (row.parent_id as string | null) ?? null,
    sortOrder: (row.sort_order as number) ?? 0,
    productCount: counts.get(row.id as string) ?? 0,
    children: [] as Category[],
  }));

  // Roll child counts up into their parent so "Electronics · 32 products" is
  // the sum of its subcategories rather than zero.
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.parentId) {
      const parent = byId.get(row.parentId);
      if (parent) {
        parent.children!.push(row);
        parent.productCount = (parent.productCount ?? 0) + (row.productCount ?? 0);
      }
    }
  }

  return rows;
});

/** Only the leaf categories, which is what the storefront browses by. */
export async function listLeafCategories(): Promise<Category[]> {
  const all = await listCategories();
  return all.filter((category) => category.parentId !== null);
}

export async function getCategoryBySlug(slug: string): Promise<Category | null> {
  const all = await listCategories();
  return all.find((category) => category.slug === slug) ?? null;
}

async function productCountsByCategory(): Promise<Map<string, number>> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from('products')
    .select('category_id')
    .eq('is_active', true);

  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const key = row.category_id as string;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export async function getCatalogFacets(categorySlug?: string): Promise<CatalogFacets> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc('get_catalog_facets', {
    p_category_slug: categorySlug ?? null,
  });
  if (error) throw error;
  return data as CatalogFacets;
}

/**
 * Availability for a set of products. Reads through a SECURITY DEFINER
 * function so `reserved_quantity` never leaves the database.
 */
export async function getStockFor(productIds: string[]): Promise<Map<string, Availability>> {
  const map = new Map<string, Availability>();
  if (productIds.length === 0) return map;

  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc('get_products_stock', {
    p_product_ids: productIds,
  });
  if (error) throw error;

  for (const row of (data ?? []) as Array<{
    product_id: string;
    available: number;
    in_stock: boolean;
    low_stock: boolean;
  }>) {
    map.set(row.product_id, {
      available: row.available,
      inStock: row.in_stock,
      lowStock: row.low_stock,
    });
  }
  return map;
}

/** Accepts a slug or a UUID, matching the /api/products/:id contract. */
export async function getProductDetail(ref: string): Promise<ProductDetail> {
  const supabase = await supabaseServer();
  const column = UUID_RE.test(ref) ? 'id' : 'slug';

  const { data, error } = await supabase
    .from('products')
    .select(
      `id, name, slug, brand, sku, description, short_description, price, compare_at_price,
       currency, rating, review_count, is_featured, is_active, tags, specs, catalog_metadata, created_at, updated_at,
       category:categories!inner ( id, name, slug ),
       images:product_images ( id, public_url, alt_text, width, height, is_primary, sort_order,
                               attribution, license, source_url ),
       specifications:product_specs ( spec_key, display_label, spec_value, spec_value_num, unit, sort_order )`,
    )
    .eq(column, ref)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Product not found.');

  const row = data as Record<string, any>;

  const images: ProductImage[] = (row.images ?? [])
    .map((image: Record<string, any>) => ({
      id: image.id as string,
      url: image.public_url as string,
      alt: (image.alt_text as string | null) ?? null,
      width: (image.width as number | null) ?? null,
      height: (image.height as number | null) ?? null,
      isPrimary: Boolean(image.is_primary),
      sortOrder: (image.sort_order as number) ?? 0,
      attribution: (image.attribution as string | null) ?? null,
      license: (image.license as string | null) ?? null,
      sourceUrl: (image.source_url as string | null) ?? null,
    }))
    .sort(
      (a: ProductImage, b: ProductImage) =>
        Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder,
    );

  const specifications: ProductSpec[] = (row.specifications ?? [])
    .map((spec: Record<string, any>) => ({
      key: spec.spec_key as string,
      label: spec.display_label as string,
      // Preserve the numeric type where we have one.
      value: (spec.spec_value_num !== null && spec.spec_value_num !== undefined
        ? Number(spec.spec_value_num)
        : (spec.spec_value as string)) as string | number,
      unit: (spec.unit as string | null) ?? null,
      sortOrder: (spec.sort_order as number) ?? 0,
    }))
    .sort((a: ProductSpec & { sortOrder: number }, b: ProductSpec & { sortOrder: number }) =>
      a.sortOrder - b.sortOrder,
    )
    .map(({ sortOrder: _sortOrder, ...spec }: ProductSpec & { sortOrder: number }) => spec);

  const stock = await getStockFor([row.id as string]);
  const availability: Availability = stock.get(row.id as string) ?? {
    available: 0,
    inStock: false,
    lowStock: false,
  };

  const related = await getRelatedProducts(row.category.id as string, row.id as string);

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    brand: row.brand,
    sku: row.sku,
    shortDescription: row.short_description ?? null,
    description: row.description ?? null,
    price: Number(row.price),
    compareAtPrice: row.compare_at_price === null ? null : Number(row.compare_at_price),
    currency: row.currency,
    rating: Number(row.rating),
    reviewCount: Number(row.review_count),
    isFeatured: Boolean(row.is_featured),
    isActive: Boolean(row.is_active),
    tags: row.tags ?? [],
    specs: row.specs ?? {},
    catalogMetadata: row.catalog_metadata ?? {},
    category: row.category,
    image: images[0]?.url ?? null,
    imageAlt: images[0]?.alt ?? null,
    images,
    specifications,
    availability,
    related,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getRelatedProducts(
  categoryId: string,
  excludeProductId: string,
): Promise<ProductSummary[]> {
  const supabase = await supabaseServer();

  const { data: category } = await supabase
    .from('categories')
    .select('slug')
    .eq('id', categoryId)
    .maybeSingle();

  if (!category) return [];

  const { products } = await listProducts({
    page: 1,
    limit: 5,
    category: category.slug as string,
    sort: 'rating',
  } as ProductQuery);

  return products.filter((product) => product.id !== excludeProductId).slice(0, 4);
}

