'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '@/lib/format';

/**
 * Passwordless sign-in.
 *
 *   email → (new account? name + phone) → emailed code → signed in
 *
 * No password is chosen, stored, emailed or accepted anywhere in this flow.
 * Proving control of the mailbox is the whole of authentication.
 *
 * The first step asks the server whether the address already has an account so
 * a returning customer is not made to re-enter their name. That answer is an
 * account-enumeration signal, which is why the endpoint behind it is throttled
 * hard and returns nothing but the boolean.
 */

type Step = 'email' | 'details' | 'code';

/**
 * Supabase's OTP length is a project setting (6–10 digits), not a constant.
 * The field accepts the whole range rather than assuming six, so changing that
 * setting does not silently break sign-in.
 */
const MIN_CODE = 6;
const MAX_CODE = 10;

export interface SignedInCustomer {
  id: string;
  email: string | null;
  fullName: string | null;
  phone?: string | null;
}

/** Display as the customer types: +91 98765 43210 */
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^91/, '').slice(0, 10);
  if (!digits) return '';
  if (digits.length <= 5) return `+91 ${digits}`;
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

export function SignInDialog({
  open,
  onClose,
  onSignedIn,
}: {
  open: boolean;
  onClose: () => void;
  onSignedIn: (customer: SignedInCustomer) => void;
}) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Reset on close so a reopened dialog never shows a stale half-finished
  // attempt — including a code the customer already used.
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => {
      setStep('email');
      setCode('');
      setError(null);
      setNotice(null);
      setPending(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (open) firstFieldRef.current?.focus();
  }, [open, step]);

  // Escape closes, and focus is trapped while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href]',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const call = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch('/api/auth/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  }, []);

  const sendCode = useCallback(
    async (details?: { firstName: string; lastName: string; phone: string }) => {
      setPending(true);
      setError(null);
      const { status, payload } = await call({
        action: 'send',
        email,
        ...(details
          ? { firstName: details.firstName, lastName: details.lastName, phone: details.phone }
          : {}),
      });
      setPending(false);

      if (status !== 200) {
        setError(payload?.error?.message ?? "I couldn't send the code. Please try again.");
        return false;
      }
      setNotice(payload?.message ?? `Code sent to ${email}.`);
      setStep('code');
      return true;
    },
    [call, email],
  );

  const submitEmail = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!email.trim()) return;
      setPending(true);
      setError(null);

      const { status, payload } = await call({ action: 'check', email });
      setPending(false);

      if (status !== 200) {
        setError(payload?.error?.message ?? "That doesn't look like an email address.");
        return;
      }

      // A returning customer goes straight to the code; a new one is asked for
      // the details an order will need before the code is spent.
      if (payload.exists) await sendCode();
      else setStep('details');
    },
    [call, email, sendCode],
  );

  const submitDetails = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!firstName.trim()) {
        setError('Please enter your first name.');
        return;
      }
      if (phone.replace(/\D/g, '').replace(/^91/, '').length !== 10) {
        setError('Please enter a 10-digit mobile number.');
        return;
      }
      await sendCode({ firstName, lastName, phone });
    },
    [firstName, lastName, phone, sendCode],
  );

  const submitCode = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (code.length < MIN_CODE) return;
      setPending(true);
      setError(null);

      const { status, payload } = await call({ action: 'verify', email, token: code });
      setPending(false);

      if (status !== 200 || !payload?.signedIn) {
        setError(payload?.error?.message ?? 'That code is wrong or has expired.');
        setCode('');
        return;
      }
      onSignedIn(payload.customer);
      onClose();
    },
    [call, code, email, onClose, onSignedIn],
  );

  if (!open) return null;

  const field =
    'h-11 w-full rounded-[11px] border border-white/10 bg-[#0C0C0F] px-3.5 text-[14px] text-white outline-none transition-colors placeholder:text-[#6E6E76] focus:border-[rgba(247,147,30,.55)] disabled:opacity-60';
  const label = 'mb-1.5 block text-[12px] font-medium text-[#9A9AA2]';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-title"
        className="w-full max-w-[380px] rounded-[20px] border border-white/10 bg-[#0F0F13] p-6 shadow-2xl"
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 id="signin-title" className="m-0 text-[18px] font-semibold text-white">
              {step === 'email'
                ? 'Sign in to ShopiQ'
                : step === 'details'
                  ? 'Create your account'
                  : 'Enter your code'}
            </h2>
            <p className="mt-1 text-[12.5px] leading-snug text-[#8A8A93]">
              {step === 'email'
                ? 'No password — we email you a code.'
                : step === 'details'
                  ? 'We just need these for delivery.'
                  : notice ?? `Sent to ${email}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sign in"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 text-[#8A8A93] transition-colors hover:border-white/25 hover:text-white"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {step === 'email' ? (
          <form onSubmit={submitEmail} className="flex flex-col gap-3">
            <div>
              <label htmlFor="signin-email" className={label}>
                Email address
              </label>
              <input
                ref={firstFieldRef}
                id="signin-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                disabled={pending}
                className={field}
              />
            </div>
            <SubmitButton pending={pending} disabled={!email.trim()}>
              Continue
            </SubmitButton>
          </form>
        ) : null}

        {step === 'details' ? (
          <form onSubmit={submitDetails} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label htmlFor="signin-first" className={label}>
                  First name
                </label>
                <input
                  ref={firstFieldRef}
                  id="signin-first"
                  autoComplete="given-name"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  placeholder="Yash"
                  disabled={pending}
                  className={field}
                />
              </div>
              <div>
                <label htmlFor="signin-last" className={label}>
                  Last name
                </label>
                <input
                  id="signin-last"
                  autoComplete="family-name"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  placeholder="Garg"
                  disabled={pending}
                  className={field}
                />
              </div>
            </div>
            <div>
              <label htmlFor="signin-phone" className={label}>
                Mobile number
              </label>
              <input
                id="signin-phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={phone}
                onChange={(event) => setPhone(formatPhone(event.target.value))}
                placeholder="+91 98765 43210"
                disabled={pending}
                className={field}
              />
              <p className="mt-1.5 text-[11.5px] text-[#6E6E76]">
                For delivery updates only.
              </p>
            </div>
            <SubmitButton pending={pending} disabled={!firstName.trim() || !phone}>
              Send code
            </SubmitButton>
            <button
              type="button"
              onClick={() => setStep('email')}
              className="text-[12.5px] text-[#8A8A93] underline-offset-4 hover:underline"
            >
              Use a different email
            </button>
          </form>
        ) : null}

        {step === 'code' ? (
          <form onSubmit={submitCode} className="flex flex-col gap-3">
            <div>
              <label htmlFor="signin-code" className={label}>
                Code from your email
              </label>
              <input
                ref={firstFieldRef}
                id="signin-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={MAX_CODE}
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, '').slice(0, MAX_CODE))
                }
                placeholder="••••••"
                disabled={pending}
                className={cx(field, 'text-center font-mono text-[20px] tracking-[0.35em]')}
              />
            </div>
            <SubmitButton pending={pending} disabled={code.length < MIN_CODE}>
              Sign in
            </SubmitButton>
            <button
              type="button"
              onClick={() => void sendCode()}
              disabled={pending}
              className="text-[12.5px] text-[#8A8A93] underline-offset-4 hover:underline disabled:opacity-50"
            >
              Send a new code
            </button>
          </form>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 text-[12.5px] leading-snug text-[#FF8B8B]">
            {error}
          </p>
        ) : null}

        <p className="mt-5 border-t border-white/7 pt-4 text-[11.5px] leading-snug text-[#6E6E76]">
          ShopiQ never asks for a password. You can shop and check out without an
          account — signing in just lets you track orders.
        </p>
      </div>
    </div>
  );
}

function SubmitButton({
  pending,
  disabled,
  children,
}: {
  pending: boolean;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="mt-1 h-11 w-full rounded-[11px] brand-gradient text-[14px] font-semibold text-[#1A0D02] transition-opacity disabled:opacity-45"
    >
      {pending ? 'Just a moment…' : children}
    </button>
  );
}
