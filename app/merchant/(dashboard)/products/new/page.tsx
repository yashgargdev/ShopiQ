import Link from 'next/link';

import { EMPTY_PRODUCT, ProductForm } from '@/components/merchant/ProductForm';
import { listLeafCategories } from '@/lib/products/queries';

export const metadata = { title: 'New product' };

export default async function NewProductPage() {
  const categories = await listLeafCategories();

  return (
    <main className="px-5 pb-16 pt-7 md:px-8 md:pt-9">
      <nav aria-label="Breadcrumb" className="mb-5 flex items-center gap-2 text-[13px] text-[#6E6E76]">
        <Link href="/merchant/products" className="text-[#6E6E76] hover:text-white">
          Products
        </Link>
        <span>/</span>
        <span className="text-[#B9B9C0]">New</span>
      </nav>

      <h1 className="m-0 mb-7 text-[28px] font-semibold leading-none tracking-[-0.03em]">
        Add a product
      </h1>

      <ProductForm
        mode="create"
        categories={categories.map((category) => ({
          id: category.id,
          name: category.name,
          slug: category.slug,
        }))}
        initial={EMPTY_PRODUCT}
      />
    </main>
  );
}
