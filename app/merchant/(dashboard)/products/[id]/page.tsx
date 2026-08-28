import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ProductForm, type ProductFormValues, type SpecRow } from '@/components/merchant/ProductForm';
import { ApiError } from '@/lib/api/response';
import { getProductForEditing } from '@/lib/merchant/queries';
import { listLeafCategories } from '@/lib/products/queries';

export const metadata = { title: 'Edit product' };

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let product: Record<string, any>;
  try {
    product = await getProductForEditing(id);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const categories = await listLeafCategories();
  const inventory = Array.isArray(product.inventory) ? product.inventory[0] : product.inventory;

  const specs: SpecRow[] = (product.specifications ?? [])
    .slice()
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((spec: any) => ({
      key: spec.spec_key,
      label: spec.display_label,
      value: String(spec.spec_value),
      unit: spec.unit ?? '',
    }));

  const initial: ProductFormValues = {
    id: product.id,
    name: product.name,
    brand: product.brand,
    categoryId: product.category_id,
    sku: product.sku,
    price: String(product.price),
    compareAtPrice: product.compare_at_price === null ? '' : String(product.compare_at_price),
    shortDescription: product.short_description ?? '',
    description: product.description ?? '',
    tags: (product.tags ?? []).join(', '),
    rating: String(product.rating ?? 0),
    reviewCount: String(product.review_count ?? 0),
    isFeatured: Boolean(product.is_featured),
    isActive: Boolean(product.is_active),
    quantity: String(inventory?.quantity ?? 0),
    lowStockThreshold: String(inventory?.low_stock_threshold ?? 5),
    specs,
  };

  const images = (product.images ?? [])
    .slice()
    .sort(
      (a: any, b: any) =>
        Number(b.is_primary) - Number(a.is_primary) || (a.sort_order ?? 0) - (b.sort_order ?? 0),
    )
    .map((image: any) => ({
      id: image.id,
      public_url: image.public_url,
      alt_text: image.alt_text,
      is_primary: Boolean(image.is_primary),
    }));

  return (
    <main className="px-5 pb-16 pt-7 md:px-8 md:pt-9">
      <nav aria-label="Breadcrumb" className="mb-5 flex items-center gap-2 text-[13px] text-[#6E6E76]">
        <Link href="/merchant/products" className="text-[#6E6E76] hover:text-white">
          Products
        </Link>
        <span>/</span>
        <span className="truncate text-[#B9B9C0]">{product.name}</span>
      </nav>

      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 truncate text-[28px] font-semibold leading-tight tracking-[-0.03em]">
            {product.name}
          </h1>
          <p className="mb-0 mt-3 font-mono text-[12.5px] text-[#6E6E76]">
            {product.brand} · {product.sku}
            {inventory ? ` · ${inventory.reserved_quantity} reserved` : ''}
          </p>
        </div>
        {product.is_active ? (
          <Link
            href={`/products/${product.slug}`}
            className="inline-flex h-[38px] items-center rounded-[10px] border border-white/14 px-4 text-[13.5px] text-[#E6E6EA] transition-colors hover:border-white/30"
          >
            View on storefront
          </Link>
        ) : null}
      </div>

      <ProductForm
        mode="edit"
        categories={categories.map((category) => ({
          id: category.id,
          name: category.name,
          slug: category.slug,
        }))}
        initial={initial}
        images={images}
      />
    </main>
  );
}
