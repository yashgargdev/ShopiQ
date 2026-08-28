'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { ShopiQMark } from '@/components/layout/SiteHeader';
import { SignOutButton } from '@/components/auth/SignOutButton';
import {
  BoxIcon,
  ChartIcon,
  SparkIcon,
  ClipboardIcon,
  HomeIcon,
  LayersIcon,
} from '@/components/ui/icons';
import { cx } from '@/lib/format';
import type { SessionUser } from '@/types';

/**
 * Merchant navigation. Same palette, type and hairlines as the storefront —
 * this is meant to read as one product, not a bolted-on admin theme.
 */

const LINKS = [
  { href: '/merchant', label: 'Overview', Icon: HomeIcon, exact: true },
  { href: '/merchant/products', label: 'Products', Icon: BoxIcon },
  { href: '/merchant/inventory', label: 'Inventory', Icon: LayersIcon },
  { href: '/merchant/orders', label: 'Orders', Icon: ClipboardIcon },
  { href: '/merchant/analytics', label: 'Analytics', Icon: ChartIcon },
  { href: '/merchant/ai-insights', label: 'AI Insights', Icon: SparkIcon },
  { href: '/merchant/audit', label: 'Audit', Icon: ClipboardIcon },
];

export function MerchantNav({ user }: { user: SessionUser }) {
  const pathname = usePathname();

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-white/7 bg-[#07070A] px-4 py-5 lg:flex">
        <Link href="/" className="mb-1 flex items-center gap-2.5 px-2 py-2">
          <ShopiQMark size={28} />
          <span className="brand-text text-[17px] font-semibold leading-none">ShopiQ</span>
        </Link>
        <div className="mb-5 px-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#6E6E76]">
          Merchant
        </div>

        <nav className="flex flex-col gap-1">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cx(
                'flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[14px] transition-colors',
                isActive(link.href, link.exact)
                  ? 'bg-[rgba(247,147,30,.1)] font-medium text-[#FFC07A]'
                  : 'text-[#9A9AA2] hover:bg-[#0C0C0E] hover:text-white',
              )}
            >
              <link.Icon size={17} />
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="mt-auto border-t border-white/7 pt-4">
          <div className="mb-3 px-2">
            <div className="truncate text-[13.5px] font-medium">
              {user.fullName ?? user.email}
            </div>
            <div className="mt-1 text-[12px] capitalize text-[#6E6E76]">{user.merchantRole}</div>
          </div>
          <Link
            href="/"
            className="mb-2 block rounded-[10px] px-3 py-2 text-[13.5px] text-[#9A9AA2] transition-colors hover:bg-[#0C0C0E] hover:text-white"
          >
            ← Back to storefront
          </Link>
          <SignOutButton />
        </div>
      </aside>

      {/* Mobile bar */}
      <div className="sticky top-0 z-70 border-b border-white/7 bg-black/85 backdrop-blur-[14px] lg:hidden">
        <div className="flex items-center gap-3 px-5 py-3">
          <Link href="/" className="flex items-center gap-2">
            <ShopiQMark size={24} />
            <span className="brand-text text-[15px] font-semibold leading-none">ShopiQ</span>
          </Link>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#6E6E76]">
            Merchant
          </span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-5 pb-2.5">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cx(
                'shrink-0 whitespace-nowrap rounded-[9px] px-3 py-2 text-[13px] transition-colors',
                isActive(link.href, link.exact)
                  ? 'bg-[rgba(247,147,30,.12)] font-medium text-[#FFC07A]'
                  : 'text-[#9A9AA2]',
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}
