import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { MerchantNav } from '@/components/merchant/MerchantNav';
import { getSessionUser } from '@/lib/auth';

export const metadata: Metadata = {
  title: { default: 'Merchant', template: '%s · ShopiQ Merchant' },
  robots: { index: false, follow: false },
};

/**
 * Merchant shell.
 *
 * This layout is scoped to the (dashboard) route group so that
 * /merchant/access — the "you're signed in but not a merchant" page — sits
 * outside it and cannot be caught by the redirect below.
 *
 * Access is checked three times over: middleware redirects, this layout
 * redirects, and each /api/merchant route calls requireMerchant(). The
 * database is the final gate: RLS only lets merchant_users write catalogue
 * rows, regardless of what any UI allows.
 */
export default async function MerchantDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();

  if (!user) redirect('/login?next=%2Fmerchant');
  if (!user.isMerchant) redirect('/merchant/access');

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <MerchantNav user={user} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
