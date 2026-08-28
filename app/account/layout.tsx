import Link from 'next/link';
import type { ReactNode } from 'react';
import { AccountNav } from '@/components/account/AccountNav';

/**
 * Account shell.
 *
 * Full-bleed and pitch black, with navigation in the header.
 *
 * On desktop the header is a three-column grid — lockup, centred tabs, action —
 * so the tabs are optically centred in the window regardless of how wide the
 * lockup or the button happen to be. Centring with flex would drift as soon as
 * one side changed length. Below `md` the tabs drop to their own scrollable
 * row, which keeps them reachable by thumb instead of squeezed.
 */
export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-black text-[#EDEDF0]">
      <header className="sticky top-0 z-30 border-b border-white/6 bg-black/85 backdrop-blur-xl">
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3.5 lg:px-8">
          <Link href="/" className="flex items-center gap-2.5" aria-label="ShopiQ home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://cdn.shopiq.yashgarg.co.in/Logo/ShopiQ.png"
              width={26}
              height={26}
              alt=""
              className="h-[26px] w-[26px] rounded-[7px]"
            />
            <span className="text-[16px] font-semibold tracking-[-0.02em] text-white">
              Shopi<span className="text-[#F7931E]">Q</span>
            </span>
          </Link>

          {/* Centre column: visible from md up, its own row below that. */}
          <div className="hidden justify-center md:flex">
            <AccountNav />
          </div>
          <span className="md:hidden" />

          <Link
            href="/"
            className="inline-flex h-9 items-center gap-2 rounded-full border border-white/12 px-3.5 text-[13px] font-medium text-[#C6C6CC] transition-colors hover:border-[rgba(247,147,30,.5)] hover:text-white sm:px-4"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
            <span className="hidden sm:inline">Talk to ShopiQ</span>
            <span className="sm:hidden">Ask</span>
          </Link>
        </div>

        {/* Mobile row — full width so it can scroll rather than compress. */}
        <div className="border-t border-white/6 px-5 py-2.5 md:hidden">
          <AccountNav />
        </div>
      </header>

      {/* min-w-0 stops a long order number from stretching the layout. */}
      <main className="min-w-0 px-5 pb-16 pt-6 lg:px-8 lg:pt-8">{children}</main>
    </div>
  );
}
