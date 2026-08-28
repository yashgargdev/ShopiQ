import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { CheckoutForm } from '@/components/checkout/CheckoutForm';
import { CartIcon } from '@/components/ui/icons';
import { EmptyState, LinkButton } from '@/components/ui/primitives';
import { getSessionUser } from '@/lib/auth';
import { getCart } from '@/lib/cart/queries';
import { getDefaultAddress } from '@/lib/orders/queries';

export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
};

export default async function CheckoutPage() {
  const user = await getSessionUser();
  // middleware already redirects anonymous visitors; this is the belt-and-braces
  // check for any path that bypasses it.
  if (!user) redirect('/login?next=%2Fcheckout');

  const [cart, savedAddress] = await Promise.all([getCart(), getDefaultAddress(user.id)]);

  return (
    <main className="mx-auto max-w-[1080px] px-5 pb-[110px] pt-8 md:px-8 md:pt-11">
      <h1 className="m-0 mb-8 text-[28px] font-semibold leading-none tracking-[-0.03em] md:text-[36px]">
        Checkout
      </h1>

      {cart.items.length === 0 ? (
        <EmptyState
          icon={<CartIcon size={18} />}
          title="There is nothing to check out"
          description="Add something to your cart first."
          action={
            <LinkButton href="/products" variant="primary">
              Explore Products
            </LinkButton>
          }
        />
      ) : (
        <CheckoutForm cart={cart} user={user} savedAddress={savedAddress} />
      )}
    </main>
  );
}
