import 'server-only';

import { conflict, notFound } from '@/lib/api/response';
import { adminClient } from '@/lib/supabase/admin';
import { slugify } from '@/lib/format';
import type { DashboardStats, InventoryRow, ProductSummary } from '@/types';
import type { z } from 'zod';
import type { merchantProductSchema } from '@/lib/validation/schemas';

/**
 * Merchant write paths.
 *
 * Everything here uses the service-role client, so every caller MUST have gone
 * through requireMerchant() first. The routes in app/api/merchant/** do that.
 */

type ProductInput = z.infer<typeof merchantProductSchema>;

export async function getDashboardStats(): Promise<DashboardStats> {
  const { data, error } = await adminClient().rpc('merchant_dashboard_stats');
  if (error) throw error;

  const stats = data as Record<string, unknown>;
  return {
    ...(stats as unknown as DashboardStats),
    totalRevenue: Number(stats.totalRevenue ?? 0),
    averageOrderValue: Number(stats.averageOrderValue ?? 0),
  };
}

export interface MerchantProductRow extends ProductSummary {
  isActive: boolean;
  quantity: number;
  reservedQuantity: number;
  updatedAt: string;
}

export async function listMerchantProducts(options: {
  search?: string;
  categoryId?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ products: MerchantProductRow[]; total: number }> {
  const db = adminClient();
  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;

  let query = db
    .from('products')
    .select(
      `id, name, slug, brand, sku, short_description, price, compare_at_price, currency,
       rating, review_count, is_featured, is_active, tags, specs, updated_at,
       category:categories!inner ( id, name, slug ),
       images:product_images ( public_url, alt_text, is_primary, sort_order ),
       inventory ( quantity, reserved_quantity, low_stock_threshold )`,
      { count: 'exact' },
    )
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (!options.includeInactive) query = query.eq('is_active', true);
  if (options.categoryId) query = query.eq('category_id', options.categoryId);
  if (options.search) {
    const term = options.search.replace(/[%,()]/g, ' ').trim();
    if (term) query = query.or(`name.ilike.%${term}%,brand.ilike.%${term}%,sku.ilike.%${term}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const products = (data ?? []).map((row: Record<string, any>) => {
    const inventory = Array.isArray(row.inventory) ? row.inventory[0] : row.inventory;
    const quantity = inventory?.quantity ?? 0;
    const reserved = inventory?.reserved_quantity ?? 0;
    const threshold = inventory?.low_stock_threshold ?? 5;
    const available = Math.max(quantity - reserved, 0);

    const image = (row.images ?? [])
      .slice()
      .sort(
        (a: Record<string, any>, b: Record<string, any>) =>
          Number(b.is_primary) - Number(a.is_primary) || (a.sort_order ?? 0) - (b.sort_order ?? 0),
      )[0];

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      brand: row.brand,
      sku: row.sku,
      shortDescription: row.short_description ?? null,
      price: Number(row.price),
      compareAtPrice: row.compare_at_price === null ? null : Number(row.compare_at_price),
      currency: row.currency,
      rating: Number(row.rating),
      reviewCount: Number(row.review_count),
      isFeatured: Boolean(row.is_featured),
      isActive: Boolean(row.is_active),
      tags: row.tags ?? [],
      specs: row.specs ?? {},
      category: row.category,
      image: image?.public_url ?? null,
      imageAlt: image?.alt_text ?? null,
      availability: {
        available,
        inStock: available > 0,
        lowStock: available > 0 && available <= threshold,
      },
      quantity,
      reservedQuantity: reserved,
      updatedAt: row.updated_at,
    } as MerchantProductRow;
  });

  return { products, total: count ?? 0 };
}

async function assertSkuAndSlugFree(
  sku: string | undefined,
  slug: string | undefined,
  excludeId?: string,
): Promise<void> {
  const db = adminClient();

  if (sku) {
    let query = db.from('products').select('id').eq('sku', sku);
    if (excludeId) query = query.neq('id', excludeId);
    const { data } = await query.maybeSingle();
    if (data) throw conflict(`SKU "${sku}" is already used by another product.`);
  }

  if (slug) {
    let query = db.from('products').select('id').eq('slug', slug);
    if (excludeId) query = query.neq('id', excludeId);
    const { data } = await query.maybeSingle();
    if (data) throw conflict(`The URL slug "${slug}" is already taken.`);
  }
}

export async function createProduct(input: ProductInput): Promise<{ id: string }> {
  const db = adminClient();
  const slug = input.slug ?? slugify(input.name);

  await assertSkuAndSlugFree(input.sku, slug);

  const { data, error } = await db
    .from('products')
    .insert({
      category_id: input.categoryId,
      name: input.name,
      slug,
      brand: input.brand,
      sku: input.sku,
      description: input.description || null,
      short_description: input.shortDescription || null,
      price: input.price,
      compare_at_price: input.compareAtPrice ?? null,
      currency: input.currency,
      tags: input.tags,
      rating: input.rating,
      review_count: input.reviewCount,
      is_featured: input.isFeatured,
      is_active: input.isActive,
    })
    .select('id')
    .single();

  if (error) throw error;
  const productId = data.id as string;

  await replaceSpecs(productId, input.specs);
  await setInventory(productId, input.quantity, input.lowStockThreshold);

  return { id: productId };
}

export async function updateProduct(
  productId: string,
  input: Partial<ProductInput>,
): Promise<void> {
  const db = adminClient();

  const { data: existing } = await db
    .from('products')
    .select('id')
    .eq('id', productId)
    .maybeSingle();
  if (!existing) throw notFound('Product not found.');

  const slug = input.slug ?? (input.name ? slugify(input.name) : undefined);
  await assertSkuAndSlugFree(input.sku, slug, productId);

  const patch: Record<string, unknown> = {};
  if (input.categoryId !== undefined) patch.category_id = input.categoryId;
  if (input.name !== undefined) patch.name = input.name;
  if (slug !== undefined) patch.slug = slug;
  if (input.brand !== undefined) patch.brand = input.brand;
  if (input.sku !== undefined) patch.sku = input.sku;
  if (input.description !== undefined) patch.description = input.description || null;
  if (input.shortDescription !== undefined) patch.short_description = input.shortDescription || null;
  if (input.price !== undefined) patch.price = input.price;
  if (input.compareAtPrice !== undefined) patch.compare_at_price = input.compareAtPrice ?? null;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.rating !== undefined) patch.rating = input.rating;
  if (input.reviewCount !== undefined) patch.review_count = input.reviewCount;
  if (input.isFeatured !== undefined) patch.is_featured = input.isFeatured;
  if (input.isActive !== undefined) patch.is_active = input.isActive;

  if (Object.keys(patch).length > 0) {
    const { error } = await db.from('products').update(patch).eq('id', productId);
    if (error) throw error;
  }

  if (input.specs !== undefined) {
    await replaceSpecs(productId, input.specs);
  }
  if (input.quantity !== undefined) {
    await setInventory(productId, input.quantity, input.lowStockThreshold);
  }
}

/** Deactivate rather than delete: order history references the product row. */
export async function setProductActive(productId: string, isActive: boolean): Promise<void> {
  const { error } = await adminClient()
    .from('products')
    .update({ is_active: isActive })
    .eq('id', productId);
  if (error) throw error;
}

async function replaceSpecs(productId: string, specs: ProductInput['specs']): Promise<void> {
  const db = adminClient();
  await db.from('product_specs').delete().eq('product_id', productId);

  if (!specs || specs.length === 0) {
    // The sync trigger only fires per row, so an emptied spec set needs the
    // cached jsonb cleared explicitly.
    await db.from('products').update({ specs: {} }).eq('id', productId);
    return;
  }

  const rows = specs.map((spec, index) => ({
    product_id: productId,
    spec_key: spec.key,
    spec_value: String(spec.value),
    spec_value_num: typeof spec.value === 'number' ? spec.value : null,
    unit: spec.unit || null,
    display_label: spec.label,
    sort_order: index,
  }));

  const { error } = await db.from('product_specs').insert(rows);
  if (error) throw error;
}

export async function setInventory(
  productId: string,
  quantity: number,
  lowStockThreshold?: number,
): Promise<void> {
  const db = adminClient();

  const { data: current } = await db
    .from('inventory')
    .select('reserved_quantity')
    .eq('product_id', productId)
    .maybeSingle();

  const reserved = (current?.reserved_quantity as number) ?? 0;
  if (quantity < reserved) {
    throw conflict(
      `${reserved} units are reserved against open orders — stock cannot be set below that.`,
    );
  }

  const patch: Record<string, unknown> = { product_id: productId, quantity };
  if (lowStockThreshold !== undefined) patch.low_stock_threshold = lowStockThreshold;

  const { error } = await db.from('inventory').upsert(patch, { onConflict: 'product_id' });
  if (error) throw error;
}

export async function listInventory(options: {
  search?: string;
  status?: 'all' | 'low_stock' | 'out_of_stock';
  limit?: number;
  offset?: number;
}): Promise<{ rows: InventoryRow[]; total: number }> {
  const db = adminClient();
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  let query = db
    .from('inventory')
    .select(
      `product_id, quantity, reserved_quantity, available, low_stock_threshold, updated_at,
       product:products!inner ( id, name, slug, brand, sku, price, is_active,
                                images:product_images ( public_url, is_primary, sort_order ) )`,
      { count: 'exact' },
    )
    .order('available', { ascending: true })
    .range(offset, offset + limit - 1);

  if (options.status === 'out_of_stock') query = query.lte('available', 0);
  if (options.status === 'low_stock') query = query.gt('available', 0).lte('available', 10);

  const { data, error, count } = await query;
  if (error) throw error;

  let rows = (data ?? []).map((row: Record<string, any>) => {
    const product = row.product as Record<string, any>;
    const available = row.available as number;
    const threshold = (row.low_stock_threshold as number) ?? 5;

    const image = (product.images ?? [])
      .slice()
      .sort(
        (a: Record<string, any>, b: Record<string, any>) =>
          Number(b.is_primary) - Number(a.is_primary) || (a.sort_order ?? 0) - (b.sort_order ?? 0),
      )[0];

    return {
      productId: product.id,
      name: product.name,
      slug: product.slug,
      brand: product.brand,
      sku: product.sku,
      image: image?.public_url ?? null,
      price: Number(product.price),
      isActive: Boolean(product.is_active),
      quantity: row.quantity as number,
      reservedQuantity: row.reserved_quantity as number,
      available,
      lowStockThreshold: threshold,
      status:
        available <= 0 ? 'out_of_stock' : available <= threshold ? 'low_stock' : 'healthy',
      updatedAt: row.updated_at as string,
    } as InventoryRow;
  });

  // The low-stock threshold is per product, so the precise filter has to run
  // after the rows are joined. The SQL filter above narrows the page first.
  if (options.status === 'low_stock') {
    rows = rows.filter((row) => row.status === 'low_stock');
  }
  if (options.search) {
    const term = options.search.toLowerCase();
    rows = rows.filter(
      (row) =>
        row.name.toLowerCase().includes(term) ||
        row.brand.toLowerCase().includes(term) ||
        row.sku.toLowerCase().includes(term),
    );
  }

  return { rows, total: count ?? 0 };
}

export async function getProductForEditing(productId: string) {
  const { data, error } = await adminClient()
    .from('products')
    .select(
      `id, category_id, name, slug, brand, sku, description, short_description, price,
       compare_at_price, currency, tags, rating, review_count, is_featured, is_active,
       images:product_images ( id, r2_key, public_url, alt_text, is_primary, sort_order ),
       specifications:product_specs ( spec_key, display_label, spec_value, spec_value_num, unit, sort_order ),
       inventory ( quantity, reserved_quantity, low_stock_threshold )`,
    )
    .eq('id', productId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Product not found.');
  return data as Record<string, any>;
}
