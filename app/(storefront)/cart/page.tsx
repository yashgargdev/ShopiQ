import type { Metadata } from 'next';

import { CartView } from '@/components/cart/CartView';
import { getCart } from '@/lib/cart/queries';

export const metadata: Metadata = {
  title: 'Your cart',
  robots: { index: false, follow: false },
};

export default async function CartPage() {
  // Server-rendered so the first paint already has the real lines and totals.
  const cart = await getCart();

  return (
    <main className="mx-auto max-w-[1120px] px-5 pb-[110px] pt-8 md:px-8 md:pt-11">
      <h1 className="m-0 mb-8 text-[30px] font-semibold leading-none tracking-[-0.03em] md:mb-9 md:text-[40px]">
        Your cart
      </h1>
      <CartView initialCart={cart} />
    </main>
  );
}
