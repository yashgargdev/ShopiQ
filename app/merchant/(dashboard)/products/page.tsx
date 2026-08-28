import Image from 'next/image';
import Link from 'next/link';

import { EmptyState, LinkButton, Price } from '@/components/ui/primitives';
import { formatNumber } from '@/lib/format';
import { listMerchantProducts } from '@/lib/merchant/queries';

export const metadata = { title: 'Products' };

export default async function MerchantProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const search = typeof params.q === 'string' ? params.q : undefined;
  const page = Math.max(Number(typeof params.page === 'string' ? params.page : 1) || 1, 1);
  const limit = 25;

  const { products, total } = await listMerchantProducts({
    search,
    includeInactive: true,
    limit,
    offset: (page - 1) * limit,
  });

  const totalPages = Math.max(Math.ceil(total / limit), 1);

  return (
    <main className="px-5 pb-16 pt-7 md:px-8 md:pt-9">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-[28px] font-semibold leading-none tracking-[-0.03em]">
            Products
          </h1>
          <p className="mb-0 mt-3 text-[14px] text-[#7E7E88]">
            {formatNumber(total)} {total === 1 ? 'product' : 'products'} in the catalogue
          </p>
        </div>
        <LinkButton href="/merchant/products/new" variant="primary">
          Add product
        </LinkButton>
      </div>

      <form className="mb-5" action="/merchant/products">
        <input
          name="q"
          defaultValue={search}
          placeholder="Search by name, brand or SKU"
          aria-label="Search products"
          className="h-11 w-full max-w-[420px] rounded-[10px] border border-white/10 bg-[#0C0C0E] px-4 text-[14px] text-[#EDEDF0] outline-none transition-colors focus:border-[rgba(247,147,30,.5)]"
        />
      </form>

      {products.length === 0 ? (
        <EmptyState
          title={search ? `Nothing matched “${search}”` : 'No products yet'}
          description={
            search
              ? 'Try a different name, brand or SKU.'
              : 'Add your first product to start building the catalogue.'
          }
          action={
            search ? (
              <LinkButton href="/merchant/products" variant="ghost">
                Clear search
              </LinkButton>
            ) : (
              <LinkButton href="/merchant/products/new" variant="primary">
                Add product
              </LinkButton>
            )
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[16px] border border-white/8">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="border-b border-white/8 bg-[#0A0A0C]">
                <Th>Product</Th>
                <Th>Category</Th>
                <Th className="text-right">Price</Th>
                <Th className="text-right">Available</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr
                  key={product.id}
                  className="border-b border-white/6 transition-colors last:border-b-0 hover:bg-[#0A0A0C]"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-[9px] bg-[#121216]">
                        {product.image ? (
                          <Image
                            src={product.image}
                            alt=""
                            fill
                            sizes="44px"
                            className="object-cover"
                          />
                        ) : null}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[14px] font-medium">{product.name}</div>
                        <div className="mt-1 font-mono text-[11.5px] text-[#6E6E76]">
                          {product.brand} · {product.sku}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[13.5px] text-[#9A9AA2]">
                    {product.category.name}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Price
                      amount={product.price}
                      compareAt={product.compareAtPrice}
                      size="sm"
                      className="justify-end"
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={
                        product.availability.available <= 0
                          ? 'text-[14px] font-medium text-[#FF8B8B]'
                          : product.availability.lowStock
                            ? 'text-[14px] font-medium text-[#FFB65C]'
                            : 'text-[14px] font-medium text-[#EDEDF0]'
                      }
                    >
                      {product.availability.available}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        product.isActive
                          ? 'inline-flex items-center rounded-full bg-[rgba(78,209,126,.14)] px-2.5 py-1 text-[11.5px] font-medium text-[#4ED17E]'
                          : 'inline-flex items-center rounded-full bg-white/9 px-2.5 py-1 text-[11.5px] font-medium text-[#9A9AA2]'
                      }
                    >
                      {product.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/merchant/products/${product.id}`}
                      className="inline-flex h-8 items-center rounded-[8px] border border-white/12 px-3 text-[12.5px] text-[#C6C6CC] transition-colors hover:border-white/28 hover:text-white"
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="mt-6 flex items-center justify-center gap-2">
          {Array.from({ length: totalPages }, (_, index) => index + 1).map((entry) => (
            <Link
              key={entry}
              href={`/merchant/products?${new URLSearchParams({
                ...(search ? { q: search } : {}),
                ...(entry > 1 ? { page: String(entry) } : {}),
              }).toString()}`}
              className={
                entry === page
                  ? 'grid h-9 min-w-9 place-items-center rounded-[9px] brand-gradient px-2.5 text-[13.5px] font-semibold text-[#1A0D02]'
                  : 'grid h-9 min-w-9 place-items-center rounded-[9px] border border-white/12 px-2.5 text-[13.5px] text-[#C6C6CC] hover:border-white/28'
              }
            >
              {entry}
            </Link>
          ))}
        </div>
      ) : null}
    </main>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-3 text-[11.5px] font-medium uppercase tracking-[0.08em] text-[#6E6E76] ${className ?? ''}`}
    >
      {children}
    </th>
  );
}
