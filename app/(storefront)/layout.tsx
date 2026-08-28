import { AiPanelProvider, AskShopiQFab } from '@/components/ai/AskShopiQ';
import { CartProvider } from '@/components/cart/CartProvider';
import { MobileNav } from '@/components/layout/MobileNav';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { getSessionUser } from '@/lib/auth';
import { getCart } from '@/lib/cart/queries';

/**
 * The shopper-facing shell: header, footer, cart state and the AI panel.
 *
 * Scoped to the (storefront) route group so the merchant panel does not
 * inherit it — an admin screen has no business carrying a cart badge or the
 * Ask ShopiQ floating button.
 */
export default async function StorefrontLayout({ children }: { children: React.ReactNode }) {
  // Fetched once here so the header badge and the cart page agree on first
  // paint. Per-request, so nothing is cached across visitors.
  const [user, cart] = await Promise.all([getSessionUser(), getCart()]);

  return (
    <CartProvider initialCart={cart} initialCount={cart.totals.itemCount}>
      <AiPanelProvider>
        <div className="flex min-h-screen flex-col">
          <SiteHeader user={user} />
          <div className="flex-1 pb-20 md:pb-0">{children}</div>
          <SiteFooter />
        </div>
        <AskShopiQFab />
        <MobileNav />
      </AiPanelProvider>
    </CartProvider>
  );
}
