'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { AskShopiQButton } from '@/components/ai/AskShopiQ';
import { CartIcon, CloseIcon, SearchIcon, UserIcon } from '@/components/ui/icons';
import { cx } from '@/lib/format';
import { useCart } from '@/components/cart/CartProvider';
import type { SessionUser } from '@/types';

/**
 * The storefront header, matching the design: sticky, translucent black with a
 * 14px backdrop blur, a 68px bar inside a 1320px container.
 */

const NAV = [
  { href: '/products', label: 'Products' },
  { href: '/categories', label: 'Categories' },
  { href: '/products?sort=discount', label: 'Deals' },
];

export function SiteHeader({ user }: { user: SessionUser | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { itemCount } = useCart();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  // Cmd/Ctrl+K opens search, Escape closes it — the design shows an "esc" hint.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === 'Escape') setSearchOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setSearchOpen(false);
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <header className="sticky top-0 z-70 border-b border-white/7 bg-black/82 backdrop-blur-[14px]">
      <div className="mx-auto flex h-[68px] max-w-[1320px] items-center gap-4 px-5 md:gap-9 md:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="ShopiQ home">
          <ShopiQMark />
          <span className="brand-text text-[19px] font-semibold leading-none tracking-[-0.02em]">
            ShopiQ
          </span>
        </Link>

        <nav className="hidden items-center gap-7 text-[14.5px] lg:flex">
          {NAV.map((item) => {
            const active = pathname === item.href.split('?')[0];
            return (
              <Link
                key={item.label}
                href={item.href}
                className={cx(
                  'transition-colors',
                  active ? 'text-white' : 'text-[#9A9AA2] hover:text-white',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        {/* Desktop: the 270px search affordance from the design. */}
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="Search products"
          className="hidden h-[38px] w-[270px] items-center gap-2.5 whitespace-nowrap rounded-[10px] border border-white/9 bg-[#0C0C0E] px-3.5 text-left text-[13.5px] text-[#8B8B92] transition-colors hover:border-white/20 hover:text-[#B9B9C0] lg:flex"
        >
          <SearchIcon size={15} />
          Search products
          <kbd className="ml-auto font-mono text-[11px] text-[#4E4E56]">⌘K</kbd>
        </button>

        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="Search products"
          className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/9 bg-[#0C0C0E] text-[#E6E6EA] transition-colors hover:border-white/22 lg:hidden"
        >
          <SearchIcon size={17} />
        </button>

        {/* Wrapped rather than given `hidden sm:inline-flex`: both are display
            utilities, and Tailwind resolves those by stylesheet order, so the
            component's own `inline-flex` would win. The bottom nav carries the
            AI entry point on small screens. */}
        <span className="hidden sm:block">
          <AskShopiQButton />
        </span>

        <Link
          href="/cart"
          aria-label={`Cart, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
          className="relative grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/9 bg-[#0C0C0E] text-[#E6E6EA] transition-colors hover:border-white/22"
        >
          <CartIcon size={17} />
          {itemCount > 0 ? (
            <span className="absolute -right-[5px] -top-[5px] grid h-[17px] min-w-[17px] place-items-center rounded-[9px] brand-gradient px-1 text-[10.5px] font-semibold leading-none text-[#180C02]">
              {itemCount > 99 ? '99+' : itemCount}
            </span>
          ) : null}
        </Link>

        {/* Hidden on small screens — the bottom nav's "You" slot covers it. */}
        <Link
          href={user ? '/account' : '/login'}
          aria-label={user ? 'Your account' : 'Sign in'}
          className="hidden h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/9 bg-[#0C0C0E] text-[#E6E6EA] transition-colors hover:border-white/22 sm:grid"
        >
          {user ? (
            <span className="grid h-[38px] w-[38px] place-items-center rounded-[10px] brand-gradient text-[14px] font-semibold text-[#1A0D02]">
              {(user.fullName ?? user.email).trim().charAt(0).toUpperCase()}
            </span>
          ) : (
            <UserIcon size={17} />
          )}
        </Link>
      </div>

      {searchOpen ? (
        <SearchOverlay
          query={query}
          setQuery={setQuery}
          onSubmit={submitSearch}
          onClose={() => setSearchOpen(false)}
          inputRef={inputRef}
        />
      ) : null}
    </header>
  );
}

function SearchOverlay({
  query,
  setQuery,
  onSubmit,
  onClose,
  inputRef,
}: {
  query: string;
  setQuery: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const popular = ['gaming laptops', 'smartphones', 'headphones', 'mechanical keyboard'];

  return (
    <>
      <div className="fixed inset-0 top-[68px] z-60 bg-black/70 backdrop-blur-[3px]" onClick={onClose} />
      <div className="absolute inset-x-0 top-full z-70 border-b border-white/7 bg-[#050507] px-5 py-8 md:px-8">
        <form onSubmit={onSubmit} className="mx-auto max-w-[820px]">
          <div className="flex h-[66px] items-center gap-3.5 rounded-[16px] border border-[rgba(247,147,30,.45)] bg-[#0A0A0C] px-5 shadow-[0_0_0_4px_rgba(247,147,30,.08)]">
            <SearchIcon size={20} className="shrink-0 text-[#F7931E]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search ShopiQ"
              aria-label="Search products"
              className="min-w-0 flex-1 border-none bg-transparent text-[19px] text-white outline-none placeholder:text-[#4E4E56]"
            />
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 font-mono text-[12px] text-[#6E6E76] hover:text-white"
            >
              esc
            </button>
          </div>
        </form>

        <div className="mx-auto mt-6 max-w-[820px]">
          <div className="mb-4 font-mono text-[12px] uppercase tracking-[0.12em] text-[#6E6E76]">
            Popular searches
          </div>
          <div className="flex flex-wrap gap-2">
            {popular.map((term) => (
              <Link
                key={term}
                href={`/search?q=${encodeURIComponent(term)}`}
                onClick={onClose}
                className="rounded-full border border-white/12 px-3.5 py-2 text-[13px] text-[#C6C6CC] transition-colors hover:border-[rgba(247,147,30,.5)] hover:text-white"
              >
                {term}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/** The ShopiQ mark: the spark inside a rounded gradient tile. */
export function ShopiQMark({ size = 30 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg brand-gradient text-[#1A0D02]"
      style={{ width: size, height: size, borderRadius: size / 3.75 }}
      aria-hidden="true"
    >
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2l2.1 6.2L20 10l-5.9 1.8L12 18l-2.1-6.2L4 10l5.9-1.8z" />
      </svg>
    </span>
  );
}
