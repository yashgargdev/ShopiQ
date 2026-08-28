'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useAiPanel } from '@/components/ai/AskShopiQ';
import { useCart } from '@/components/cart/CartProvider';
import { CartIcon, HomeIcon, SearchIcon, SparkIcon, UserIcon } from '@/components/ui/icons';
import { cx } from '@/lib/format';

/**
 * The bottom navigation from the design's mobile screens: five slots with
 * ShopiQ raised in the middle as a gradient pill. Replaces the floating action
 * button below the md breakpoint.
 */

const ITEMS = [
  { href: '/', label: 'Home', Icon: HomeIcon },
  { href: '/search', label: 'Search', Icon: SearchIcon },
  { href: '/cart', label: 'Cart', Icon: CartIcon },
  { href: '/account', label: 'You', Icon: UserIcon },
] as const;

export function MobileNav() {
  const pathname = usePathname();
  const { itemCount } = useCart();
  const { open } = useAiPanel();

  // The merchant panel has its own navigation.
  if (pathname.startsWith('/merchant')) return null;

  const [home, search, cart, account] = ITEMS;

  const item = (entry: (typeof ITEMS)[number]) => {
    const active = pathname === entry.href;
    const isCart = entry.href === '/cart';
    return (
      <Link
        key={entry.href}
        href={entry.href}
        className={cx(
          'relative flex flex-1 flex-col items-center gap-1.5 py-1 text-[10px] transition-colors',
          active ? 'font-medium text-[#F7931E]' : 'text-[#6E6E76]',
        )}
      >
        <entry.Icon size={19} />
        {isCart && itemCount > 0 ? (
          <span className="absolute right-[22%] top-0 grid h-4 min-w-4 place-items-center rounded-full brand-gradient px-1 text-[9px] font-semibold leading-none text-[#180C02]">
            {itemCount > 9 ? '9+' : itemCount}
          </span>
        ) : null}
        {entry.label}
      </Link>
    );
  };

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-80 flex items-center border-t border-white/8 bg-black/90 px-2 pb-[max(10px,env(safe-area-inset-bottom))] pt-2.5 backdrop-blur-md md:hidden"
    >
      {item(home)}
      {item(search)}

      <button
        type="button"
        onClick={() => open()}
        className="flex flex-1 flex-col items-center gap-1 py-1"
        aria-label="Ask ShopiQ"
      >
        <span className="grid h-[30px] w-11 place-items-center rounded-full brand-gradient text-[#1A0D02]">
          <SparkIcon size={16} />
        </span>
        <span className="text-[10px] font-medium text-[#FFC07A]">ShopiQ</span>
      </button>

      {item(cart)}
      {item(account)}
    </nav>
  );
}
