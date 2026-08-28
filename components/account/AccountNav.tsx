'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/lib/format';

/**
 * Account navigation — a pill group that lives in the header.
 *
 * One component used at both breakpoints (centred on desktop, its own row on
 * mobile) so the destinations cannot drift apart between them.
 */

const TABS = [
  {
    href: '/account',
    label: 'Profile',
    icon: (
      <>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </>
    ),
  },
  {
    href: '/account/orders',
    label: 'My orders',
    icon: (
      <>
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
        <path d="M3 6h18M16 10a4 4 0 0 1-8 0" />
      </>
    ),
  },
  {
    href: '/account/addresses',
    label: 'Addresses',
    icon: (
      <>
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
        <circle cx="12" cy="10" r="3" />
      </>
    ),
  },
];

export function AccountNav() {
  const pathname = usePathname();
  // `/account` is a prefix of the others, so it only matches exactly.
  const isActive = (href: string) =>
    href === '/account' ? pathname === href : pathname.startsWith(href);

  return (
    <nav aria-label="Account">
      {/* A single inset track, so the active pill reads as selected within a
          group rather than as three loose buttons. */}
      <ul className="flex gap-1 overflow-x-auto rounded-full border border-white/8 bg-[#0B0B0E] p-1">
        {TABS.map((tab) => {
          const active = isActive(tab.href);
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-2 text-[13px] font-medium transition-colors',
                  active
                    ? 'bg-[rgba(247,147,30,.13)] text-[#F7931E]'
                    : 'text-[#9A9AA2] hover:bg-white/5 hover:text-white',
                )}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className="shrink-0"
                >
                  {tab.icon}
                </svg>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ------------------------------------------------------------- shared UI */

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'rounded-[18px] border border-white/7 bg-[#080809] p-5 sm:p-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string | null }) {
  return (
    <div className="mb-5">
      <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em] text-white sm:text-[26px]">
        {title}
      </h1>
      {subtitle ? (
        <p className="m-0 mt-1.5 text-[13.5px] text-[#8A8A93]">{subtitle}</p>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | null;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-[#9A9AA2]">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-[11.5px] text-[#FF8B8B]">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[11.5px] text-[#6E6E76]">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  'h-11 w-full rounded-[11px] border border-white/9 bg-[#0D0D10] px-3.5 text-[14px] text-white outline-none transition-colors placeholder:text-[#5E5E66] focus:border-[rgba(247,147,30,.55)] disabled:opacity-55';

/** A quiet skeleton, so a slow network does not look like a broken page. */
export function LoadingCard({ label }: { label: string }) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/15 border-t-[#F7931E]" />
        <p className="m-0 text-[14px] text-[#8A8A93]">{label}</p>
      </div>
    </Card>
  );
}

/**
 * Shown when the page is opened signed-out.
 *
 * Points back to the agent rather than to a login page: sign-in lives in the
 * header dialog, and there is no password screen to send anyone to.
 */
export function SignedOutNotice({ what }: { what: string }) {
  return (
    <Card className="mx-auto max-w-md text-center">
      <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-full border border-[rgba(247,147,30,.3)] bg-[rgba(247,147,30,.07)]">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#F7931E" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
      <p className="m-0 text-[16px] font-medium text-white">Sign in to see {what}</p>
      <p className="mx-auto mt-2 mb-0 max-w-sm text-[13.5px] leading-relaxed text-[#8A8A93]">
        ShopiQ emails you a code — there is no password. Use the Sign in button on
        the main screen.
      </p>
      <Link
        href="/"
        className="mt-5 inline-flex h-10 items-center rounded-full brand-gradient px-5 text-[13.5px] font-semibold text-[#1A0D02]"
      >
        Go to ShopiQ
      </Link>
    </Card>
  );
}
