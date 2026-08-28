import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { ShopiQMark } from '@/components/layout/SiteHeader';
import { LinkButton } from '@/components/ui/primitives';
import { getSessionUser } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Merchant access',
  robots: { index: false, follow: false },
};

/**
 * Shown when a signed-in customer reaches a merchant route. Deliberately
 * outside the (dashboard) route group, so its own guard cannot redirect here
 * in a loop.
 */
export default async function MerchantAccessPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=%2Fmerchant');
  if (user.isMerchant) redirect('/merchant');

  return (
    <main className="flex min-h-[70vh] items-center px-5 py-16 md:px-8">
      <div className="mx-auto w-full max-w-[520px] text-center">
        <div className="mb-6 flex justify-center">
          <ShopiQMark size={44} />
        </div>

        <h1 className="m-0 text-[26px] font-semibold leading-tight tracking-[-0.03em]">
          Merchant access required
        </h1>

        <p className="mx-auto mb-0 mt-4 max-w-[440px] text-[15px] leading-relaxed text-[#9A9AA2]">
          You&apos;re signed in as{' '}
          <span className="text-[#EDEDF0]">{user.email}</span>, which is a customer account. The
          merchant panel is limited to ShopiQ merchant users.
        </p>

        <div className="mt-8 rounded-[16px] border border-white/8 bg-[#08080A] p-5 text-left">
          <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.12em] text-[#6E6E76]">
            Granting access
          </div>
          <p className="m-0 text-[13.5px] leading-relaxed text-[#9A9AA2]">
            Merchant rights are granted by adding a row to{' '}
            <code className="rounded bg-[#141418] px-1.5 py-0.5 font-mono text-[12.5px] text-[#FFC07A]">
              public.merchant_users
            </code>{' '}
            for this account. The project README covers the exact command.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <LinkButton href="/" variant="primary">
            Back to ShopiQ
          </LinkButton>
          <LinkButton href="/account" variant="ghost">
            Your account
          </LinkButton>
        </div>
      </div>
    </main>
  );
}
