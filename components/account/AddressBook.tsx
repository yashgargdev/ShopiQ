'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Field, LoadingCard, PageTitle, SignedOutNotice, inputClass } from './AccountNav';
import { cx } from '@/lib/format';

/**
 * The address book: add, edit, delete, and choose a default.
 *
 * Validation is the server's job — this form shows what it refused, per field,
 * rather than re-implementing the rules and risking the two disagreeing.
 */

interface Address {
  id: string;
  label: string | null;
  fullName: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
}

const EMPTY = {
  label: '',
  fullName: '',
  phone: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
};

/** Where the pin landed, once the browser has given us a position. */
interface Pin {
  latitude: number;
  longitude: number;
}

/**
 * An OpenStreetMap preview centred on the pin.
 *
 * A static embed rather than an interactive map library: this is here to let
 * someone confirm the position looks right before saving, which a picture does
 * as well as a pannable canvas would, without shipping a mapping bundle to
 * every visitor of the page.
 */
function MapPreview({ pin }: { pin: Pin }) {
  const delta = 0.004;
  const bbox = [
    pin.longitude - delta,
    pin.latitude - delta,
    pin.longitude + delta,
    pin.latitude + delta,
  ].join('%2C');

  return (
    <div className="overflow-hidden rounded-[12px] border border-white/10">
      <iframe
        title="Map showing the detected location"
        aria-label="Map showing the detected location"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="block h-[180px] w-full border-0 bg-[#0D0D10]"
        src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${pin.latitude}%2C${pin.longitude}`}
      />
      <p className="m-0 border-t border-white/10 bg-[#08080A] px-3 py-2 text-[11.5px] text-[#7E7E88]">
        Detected position — {pin.latitude.toFixed(5)}, {pin.longitude.toFixed(5)}. Check the fields
        below and correct anything the map got wrong.
      </p>
    </div>
  );
}

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^91/, '').slice(0, 10);
  if (!digits) return '';
  if (digits.length <= 5) return `+91 ${digits}`;
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

export function AddressBook() {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState<string | null>(null);

  /**
   * Fill the form from the device's GPS position.
   *
   * Prefills rather than submits: reverse geocoding gets the street and PIN
   * roughly right and the flat number never, so the customer still has to look
   * at it. Every failure — permission refused, no fix, geocoder unreachable —
   * lands on the same outcome: say what happened and leave them typing, which
   * is the path that always works.
   */
  const useMyLocation = useCallback(() => {
    setLocateNote(null);

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocateNote('This browser cannot share a location. Please type the address in.');
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        setPin({ latitude, longitude });

        try {
          const response = await fetch('/api/account/locate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ latitude, longitude }),
          });
          const payload = await response.json().catch(() => null);

          if (response.status === 401) {
            setSignedOut(true);
            return;
          }
          if (!payload?.ok || !payload.address) {
            setLocateNote(payload?.message ?? "I couldn't turn that position into an address.");
            return;
          }

          const found = payload.address as {
            line1?: string; line2?: string | null; city?: string;
            state?: string; postalCode?: string;
          };

          // Never overwrite something already typed — the customer's own words
          // beat a guess from a map every time.
          setForm((previous) => ({
            ...previous,
            line1: previous.line1 || (found.line1 ?? ''),
            line2: previous.line2 || (found.line2 ?? ''),
            city: previous.city || (found.city ?? ''),
            state: previous.state || (found.state ?? ''),
            postalCode: previous.postalCode || (found.postalCode ?? ''),
          }));
          setLocateNote('Filled in from your location — check the flat or house number.');
        } catch {
          setLocateNote("I couldn't reach the map service. Please type the address in.");
        } finally {
          setLocating(false);
        }
      },
      (error) => {
        setLocating(false);
        setLocateNote(
          error.code === error.PERMISSION_DENIED
            ? 'Location permission was declined — no problem, type the address in below.'
            : "I couldn't get a position from your device. Please type the address in.",
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }, []);

  const load = useCallback(async () => {
    const response = await fetch('/api/account/addresses', { cache: 'no-store' });
    if (response.status === 401) {
      setSignedOut(true);
      setLoading(false);
      return;
    }
    const payload = await response.json().catch(() => null);
    setAddresses(payload?.addresses ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setForm({ ...EMPTY });
    setErrors({});
    setEditing('new');
  };

  const openEdit = (address: Address) => {
    setForm({
      label: address.label ?? '',
      fullName: address.fullName,
      phone: formatPhone(address.phone),
      line1: address.line1,
      line2: address.line2 ?? '',
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
    });
    setErrors({});
    setEditing(address.id);
  };

  const save = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setErrors({});

      const body =
        editing === 'new'
          ? { ...form, isDefault: addresses.length === 0 }
          : { id: editing, address: { ...form } };

      const response = await fetch('/api/account/addresses', {
        method: editing === 'new' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      setBusy(false);

      if (response.status === 401) {
        setSignedOut(true);
        return;
      }
      if (payload?.ok === false && Array.isArray(payload.errors)) {
        setErrors(
          Object.fromEntries(payload.errors.map((e: { field: string; message: string }) => [e.field, e.message])),
        );
        return;
      }
      if (!response.ok) {
        setErrors({ line1: payload?.error?.message ?? "That didn't save." });
        return;
      }

      setAddresses(payload.addresses ?? []);
      setEditing(null);
    },
    [addresses.length, editing, form],
  );

  const act = useCallback(
    async (method: 'PATCH' | 'DELETE', body: Record<string, unknown>) => {
      setBusy(true);
      const response = await fetch('/api/account/addresses', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      setBusy(false);
      if (response.status === 401) {
        setSignedOut(true);
        return;
      }
      if (payload?.addresses) setAddresses(payload.addresses);
      setConfirmDelete(null);
    },
    [],
  );

  if (loading) return <LoadingCard label="Loading your addresses…" />;

  if (signedOut) return <SignedOutNotice what="your addresses" />;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <PageTitle
          title="Addresses"
          subtitle={
            addresses.length === 0
              ? 'No addresses saved yet.'
              : `${addresses.length} saved · the default is used at checkout.`
          }
        />
        {editing === null ? (
          <button
            type="button"
            onClick={openNew}
            className="h-10 shrink-0 rounded-full brand-gradient px-4 text-[13.5px] font-semibold text-[#1A0D02]"
          >
            Add address
          </button>
        ) : null}
      </div>

      {editing !== null ? (
        <Card className="mb-4 max-w-3xl">
          <h2 className="m-0 mb-4 text-[15px] font-semibold text-white">
            {editing === 'new' ? 'New address' : 'Edit address'}
          </h2>

          {/* Location first: it is the fast path, and offering it after the
              form would be offering it after the work is already done. */}
          <div className="mb-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={useMyLocation}
                disabled={locating}
                className="inline-flex h-10 items-center gap-2 rounded-full border border-[rgba(247,147,30,.45)] bg-[rgba(247,147,30,.08)] px-4 text-[13.5px] font-medium text-[#F7931E] transition-colors hover:border-[rgba(247,147,30,.8)] disabled:opacity-55"
              >
                {locating ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[rgba(247,147,30,.35)] border-t-[#F7931E]" />
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                )}
                {locating ? 'Finding you…' : 'Use my location'}
              </button>
              <span className="text-[12.5px] text-[#7E7E88]">
                Fills the street, city, state and PIN from your GPS.
              </span>
            </div>

            {locateNote ? (
              <p className="m-0 text-[12.5px] text-[#9A9AA2]">{locateNote}</p>
            ) : null}

            {pin ? <MapPreview pin={pin} /> : null}
          </div>

          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Recipient name" error={errors.fullName}>
                <input
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  placeholder="Yash Garg"
                  className={inputClass}
                />
              </Field>
              <Field label="Mobile number" error={errors.phone}>
                <input
                  type="tel"
                  inputMode="numeric"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: formatPhone(e.target.value) })}
                  placeholder="+91 98765 43210"
                  className={inputClass}
                />
              </Field>
            </div>

            <Field label="House / flat and street" error={errors.line1}>
              <input
                value={form.line1}
                onChange={(e) => setForm({ ...form, line1: e.target.value })}
                placeholder="42 MG Road"
                className={inputClass}
              />
            </Field>

            <Field label="Area, landmark (optional)">
              <input
                value={form.line2}
                onChange={(e) => setForm({ ...form, line2: e.target.value })}
                placeholder="Near Trinity Metro"
                className={inputClass}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="City" error={errors.city}>
                <input
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  placeholder="Bengaluru"
                  className={inputClass}
                />
              </Field>
              <Field label="State" error={errors.state}>
                <input
                  value={form.state}
                  onChange={(e) => setForm({ ...form, state: e.target.value })}
                  placeholder="Karnataka"
                  className={inputClass}
                />
              </Field>
              <Field label="PIN code" error={errors.postalCode}>
                <input
                  inputMode="numeric"
                  maxLength={6}
                  value={form.postalCode}
                  onChange={(e) =>
                    setForm({ ...form, postalCode: e.target.value.replace(/\D/g, '').slice(0, 6) })
                  }
                  placeholder="560001"
                  className={inputClass}
                />
              </Field>
            </div>

            <Field label="Label (optional)" hint="Home, Office — helps you pick at checkout.">
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="Home"
                maxLength={40}
                className={inputClass}
              />
            </Field>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={busy}
                className="h-11 rounded-full brand-gradient px-6 text-[14px] font-semibold text-[#1A0D02] disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save address'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="h-11 rounded-full border border-white/12 px-5 text-[14px] font-medium text-[#C6C6CC] transition-colors hover:border-white/28 hover:text-white"
              >
                Cancel
              </button>
            </div>
          </form>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {addresses.map((address) => (
        <Card key={address.id} className="flex flex-col">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-[14.5px] font-medium text-white">{address.fullName}</span>
                {address.label ? (
                  <span className="rounded-full border border-white/12 px-2 py-0.5 text-[11px] text-[#9A9AA2]">
                    {address.label}
                  </span>
                ) : null}
                {address.isDefault ? (
                  <span className="rounded-full border border-[rgba(247,147,30,.4)] bg-[rgba(247,147,30,.08)] px-2 py-0.5 text-[11px] font-medium text-[#F7931E]">
                    Default
                  </span>
                ) : null}
              </div>
              <p className="m-0 text-[13.5px] leading-relaxed text-[#C6C6CC]">
                {[address.line1, address.line2, address.city, address.state, address.postalCode]
                  .filter(Boolean)
                  .join(', ')}
              </p>
              <p className="m-0 mt-1 text-[12.5px] text-[#7E7E88]">{address.phone}</p>
            </div>
          </div>

          <div className="mt-auto flex flex-wrap gap-2 border-t border-white/7 pt-3.5 [margin-top:1rem]">
            <SmallButton onClick={() => openEdit(address)}>Edit</SmallButton>
            {!address.isDefault ? (
              <SmallButton
                onClick={() => void act('PATCH', { id: address.id, makeDefault: true })}
                disabled={busy}
              >
                Make default
              </SmallButton>
            ) : null}

            {confirmDelete === address.id ? (
              <>
                <SmallButton
                  tone="danger"
                  disabled={busy}
                  onClick={() => void act('DELETE', { id: address.id })}
                >
                  Confirm delete
                </SmallButton>
                <SmallButton onClick={() => setConfirmDelete(null)}>Keep it</SmallButton>
              </>
            ) : (
              <SmallButton tone="danger" onClick={() => setConfirmDelete(address.id)}>
                Delete
              </SmallButton>
            )}
          </div>
        </Card>
      ))}
      </div>

      {addresses.length === 0 && editing === null ? (
        <Card className="mt-4 text-center">
          <p className="m-0 text-[14px] text-[#8A8A93]">
            Add an address and ShopiQ will use it at checkout.
          </p>
        </Card>
      ) : null}
    </div>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  tone = 'default',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'h-8 rounded-full border px-3.5 text-[12.5px] font-medium transition-colors disabled:opacity-50',
        tone === 'danger'
          ? 'border-[rgba(255,107,107,.3)] text-[#FF8B8B] hover:border-[rgba(255,107,107,.55)]'
          : 'border-white/12 text-[#C6C6CC] hover:border-white/28 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}
