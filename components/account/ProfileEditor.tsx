'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Field, LoadingCard, PageTitle, SignedOutNotice, inputClass } from './AccountNav';

/**
 * Profile editing.
 *
 * Name and phone only. The email address is shown but not editable: it is the
 * sign-in credential — the one thing a code is sent to — so allowing it to be
 * changed here would turn "edit profile" into account takeover.
 */

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^91/, '').slice(0, 10);
  if (!digits) return '';
  if (digits.length <= 5) return `+91 ${digits}`;
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

export function ProfileEditor() {
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/account/profile', { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 401) {
          setSignedOut(true);
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!payload?.profile) return;
        setEmail(payload.profile.email);
        setFullName(payload.profile.full_name ?? '');
        setPhone(payload.profile.phone ? formatPhone(payload.profile.phone) : '');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setSaving(true);
      setError(null);
      setSaved(false);

      const response = await fetch('/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, phone }),
      });
      const payload = await response.json().catch(() => null);
      setSaving(false);

      if (response.status === 401) {
        setSignedOut(true);
        return;
      }
      if (!response.ok) {
        setError(payload?.error?.message ?? "That didn't save. Please try again.");
        return;
      }
      // The server reports what it refused, so a mistyped number is named
      // rather than silently dropped.
      if (payload?.rejected?.length) {
        setError(
          payload.rejected.includes('phone')
            ? 'That phone number needs to be 10 digits.'
            : 'Please check the highlighted details.',
        );
        return;
      }
      setSaved(true);
    },
    [fullName, phone],
  );

  if (loading) return <LoadingCard label="Loading your profile…" />;

  if (signedOut) return <SignedOutNotice what="your profile" />;

  return (
    <form onSubmit={save}>
      <PageTitle title="Profile" subtitle="Used on your orders and for delivery updates." />

      <Card className="max-w-2xl">
        {/* Two columns from sm up: name and phone belong side by side. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name">
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Yash Garg"
              maxLength={120}
              className={inputClass}
            />
          </Field>

          <Field label="Mobile number" hint="Delivery partners use this to reach you.">
            <input
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(event) => setPhone(formatPhone(event.target.value))}
              placeholder="+91 98765 43210"
              className={inputClass}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Email address"
              hint="This is how you sign in, so it cannot be changed here."
            >
              <input value={email ?? ''} readOnly disabled className={inputClass} />
            </Field>
          </div>
        </div>
      </Card>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="h-11 rounded-full brand-gradient px-6 text-[14px] font-semibold text-[#1A0D02] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {saved ? <span className="text-[13px] text-[#4ADE80]">Saved</span> : null}
        {error ? <span className="text-[13px] text-[#FF8B8B]">{error}</span> : null}
      </div>
    </form>
  );
}
