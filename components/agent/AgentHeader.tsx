'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SignInDialog, type SignedInCustomer } from './SignInDialog';
import { cx } from '@/lib/format';

/**
 * The agent's header: branding on the left, account on the right.
 *
 * The menu navigates to real pages. Managing an address or cancelling an order
 * is a task with a form and a list, not a conversation — the assistant can do
 * all of it too, but making someone dictate a PIN code is worse than letting
 * them type it.
 */

const LOGO_URL = 'https://cdn.shopiq.yashgarg.co.in/Logo/ShopiQ.png';

/** First name only — a full name overflows the button on a phone. */
function shortName(customer: SignedInCustomer | null): string {
  if (!customer) return '';
  const name = customer.fullName?.trim();
  if (name) return name.split(/\s+/)[0].slice(0, 14);
  return customer.email?.split('@')[0].slice(0, 14) ?? 'Account';
}

export function AgentHeader({
  onSignedInChange,
  transcriptOpen,
  onToggleTranscript,
}: {
  onSignedInChange?: (customer: SignedInCustomer | null) => void;
  transcriptOpen: boolean;
  onToggleTranscript: () => void;
}) {
  const [customer, setCustomer] = useState<SignedInCustomer | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Who is signed in, asked once on mount. A 401 is a normal answer here.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/otp', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled || !payload?.signedIn) return;
        setCustomer(payload.customer);
        onSignedInChange?.(payload.customer);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const signOut = useCallback(async () => {
    setMenuOpen(false);
    await fetch('/api/auth/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'signout' }),
    }).catch(() => {});
    setCustomer(null);
    onSignedInChange?.(null);
  }, [onSignedInChange]);

  return (
    <>
      <header className="flex shrink-0 items-center justify-between px-5 pt-[max(0.9rem,env(safe-area-inset-top))]">
        {/* Branding — the lockup, not a back button. This is the front door. */}
        <div className="flex items-center gap-2.5">
          <img
            src={LOGO_URL}
            width={28}
            height={28}
            alt=""
            className="h-7 w-7 rounded-[8px]"
          />
          <span className="text-[17px] font-semibold tracking-[-0.02em] text-white">
            Shopi<span className="text-[#F7931E]">Q</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleTranscript}
            aria-expanded={transcriptOpen}
            className={cx(
              'h-9 rounded-full border px-3.5 text-[13px] font-medium transition-colors',
              transcriptOpen
                ? 'border-[rgba(247,147,30,.45)] text-white'
                : 'border-white/12 text-[#8A8A93] hover:border-white/28 hover:text-white',
            )}
          >
            Transcript
          </button>

        {customer ? (
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={cx(
                'flex h-9 items-center gap-2 rounded-full border px-2.5 pr-3 text-[13px] font-medium transition-colors',
                menuOpen
                  ? 'border-[rgba(247,147,30,.45)] text-white'
                  : 'border-white/12 text-[#EDEDF0] hover:border-white/28',
              )}
            >
              <span className="grid h-6 w-6 place-items-center rounded-full brand-gradient text-[11px] font-bold text-[#1A0D02]">
                {shortName(customer).charAt(0).toUpperCase()}
              </span>
              {shortName(customer)}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>

            {menuOpen ? (
              <div
                role="menu"
                className="absolute right-0 z-40 mt-2 w-[210px] overflow-hidden rounded-[14px] border border-white/10 bg-[#0F0F13] py-1.5 shadow-2xl"
              >
                <p className="truncate px-3.5 pb-2 pt-1 text-[11.5px] text-[#6E6E76]">
                  {customer.email}
                </p>
                <MenuLink href="/account" onNavigate={() => setMenuOpen(false)}>
                  Profile
                </MenuLink>
                <MenuLink href="/account/orders" onNavigate={() => setMenuOpen(false)}>
                  My orders
                </MenuLink>
                <MenuLink href="/account/addresses" onNavigate={() => setMenuOpen(false)}>
                  Addresses
                </MenuLink>
                <div className="my-1.5 h-px bg-white/8" />
                <MenuItem onClick={signOut} tone="danger">
                  Sign out
                </MenuItem>
              </div>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="h-9 rounded-full border border-white/12 px-4 text-[13px] font-medium text-[#EDEDF0] transition-colors hover:border-[rgba(247,147,30,.5)] hover:text-white"
          >
            Sign in
          </button>
        )}
        </div>
      </header>

      <SignInDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSignedIn={(signedIn) => {
          setCustomer(signedIn);
          onSignedInChange?.(signedIn);
        }}
      />
    </>
  );
}

function MenuLink({
  href,
  children,
  onNavigate,
}: {
  href: string;
  children: React.ReactNode;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onNavigate}
      className="block w-full px-3.5 py-2 text-left text-[13.5px] text-[#EDEDF0] transition-colors hover:bg-white/6"
    >
      {children}
    </Link>
  );
}

function MenuItem({
  children,
  onClick,
  tone = 'default',
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cx(
        'block w-full px-3.5 py-2 text-left text-[13.5px] transition-colors',
        tone === 'danger'
          ? 'text-[#FF8B8B] hover:bg-[rgba(255,107,107,.08)]'
          : 'text-[#EDEDF0] hover:bg-white/6',
      )}
    >
      {children}
    </button>
  );
}
