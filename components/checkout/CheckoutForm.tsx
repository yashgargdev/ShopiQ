'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useCart } from '@/components/cart/CartProvider';
import { CheckIcon } from '@/components/ui/icons';
import { Button, InlineAlert } from '@/components/ui/primitives';
import { cx, formatPrice } from '@/lib/format';
import type { Cart, SessionUser, ShippingAddress } from '@/types';

/**
 * Checkout.
 *
 * Phase 1 deliberately does not take payment: submitting creates a real order
 * with real line-item price snapshots and reserves the stock, marked
 * payment_method 'test_order'. Razorpay slots into the payment step later
 * without changing the order shape.
 *
 * The totals rendered here are for display only — the server recomputes them
 * from the catalogue when the order is created.
 */

type FieldErrors = Partial<Record<string, string>>;

export function CheckoutForm({
  cart,
  user,
  savedAddress,
}: {
  cart: Cart;
  user: SessionUser;
  savedAddress: ShippingAddress | null;
}) {
  const router = useRouter();
  const { refresh } = useCart();

  const [form, setForm] = useState({
    fullName: savedAddress?.fullName ?? user.fullName ?? '',
    phone: savedAddress?.phone ?? '',
    line1: savedAddress?.line1 ?? '',
    line2: savedAddress?.line2 ?? '',
    city: savedAddress?.city ?? '',
    state: savedAddress?.state ?? '',
    postalCode: savedAddress?.postalCode ?? '',
    notes: '',
    saveAddress: true,
  });

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof typeof form) => (value: string | boolean) => {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
    setError(null);
  };

  const blocked = cart.items.some((item) => item.exceedsStock) || cart.items.length === 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (blocked || submitting) return;

    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactEmail: user.email,
          contactPhone: form.phone,
          shippingAddress: {
            fullName: form.fullName,
            phone: form.phone,
            line1: form.line1,
            line2: form.line2,
            city: form.city,
            state: form.state,
            postalCode: form.postalCode,
            country: 'IN',
          },
          notes: form.notes,
          saveAddress: form.saveAddress,
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        // Field-level errors come back from Zod with a dotted path.
        const details = payload?.error?.details;
        if (Array.isArray(details)) {
          const next: FieldErrors = {};
          for (const issue of details) {
            const key = String(issue.path).split('.').pop();
            if (key) next[key] = issue.message;
          }
          setFieldErrors(next);
        }
        setError(payload?.error?.message ?? 'We could not place your order. Please try again.');
        setSubmitting(false);
        return;
      }

      await refresh();
      router.push(`/orders/${payload.order.orderId}?placed=1`);
    } catch {
      setError('Could not reach ShopiQ. Check your connection and try again.');
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_340px]"
    >
      <div className="flex flex-col gap-3.5">
        <Section step={1} title="Contact information" complete>
          <div className="text-[14.5px] leading-[1.7] text-[#9A9AA2]">
            {user.fullName ? `${user.fullName} · ` : ''}
            {user.email}
          </div>
        </Section>

        <Section step={2} title="Delivery address">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              className="sm:col-span-2"
              label="Full name"
              value={form.fullName}
              onChange={set('fullName')}
              error={fieldErrors.fullName}
              autoComplete="name"
              required
            />
            <Field
              className="sm:col-span-2"
              label="Phone"
              value={form.phone}
              onChange={set('phone')}
              error={fieldErrors.phone}
              autoComplete="tel"
              inputMode="tel"
              placeholder="+91 98765 43210"
              required
            />
            <Field
              className="sm:col-span-2"
              label="Address"
              value={form.line1}
              onChange={set('line1')}
              error={fieldErrors.line1}
              autoComplete="address-line1"
              placeholder="Flat 402, Sunrise Residency, Sector 62"
              required
            />
            <Field
              className="sm:col-span-2"
              label="Apartment, landmark (optional)"
              value={form.line2}
              onChange={set('line2')}
              error={fieldErrors.line2}
              autoComplete="address-line2"
            />
            <Field
              label="City"
              value={form.city}
              onChange={set('city')}
              error={fieldErrors.city}
              autoComplete="address-level2"
              required
            />
            <Field
              label="State"
              value={form.state}
              onChange={set('state')}
              error={fieldErrors.state}
              autoComplete="address-level1"
              required
            />
            <Field
              label="PIN code"
              value={form.postalCode}
              onChange={(value) => set('postalCode')(String(value).replace(/\D/g, '').slice(0, 6))}
              error={fieldErrors.postalCode}
              autoComplete="postal-code"
              inputMode="numeric"
              placeholder="201301"
              required
            />
          </div>

          <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-[13.5px] text-[#C6C6CC]">
            <input
              type="checkbox"
              checked={form.saveAddress}
              onChange={(event) => set('saveAddress')(event.target.checked)}
              className="sr-only"
            />
            <span
              className={cx(
                'grid h-4 w-4 shrink-0 place-items-center rounded-[4px] transition-colors',
                form.saveAddress ? 'brand-gradient text-[#1A0D02]' : 'border border-white/20',
              )}
            >
              {form.saveAddress ? <CheckIcon size={10} /> : null}
            </span>
            Save this address for next time
          </label>
        </Section>

        <Section step={3} title="Payment" active>
          <div className="rounded-[12px] border border-[rgba(247,147,30,.35)] bg-[rgba(247,147,30,.06)] px-4 py-4">
            <div className="text-[14.5px] font-medium text-[#FFC07A]">Test order — no payment</div>
            <p className="mb-0 mt-2 text-[13.5px] leading-relaxed text-[#9A9AA2]">
              Phase 1 places a real order and reserves the stock, but takes no money. Razorpay —
              UPI, cards, netbanking and cash on delivery — arrives in a later phase.
            </p>
          </div>

          <div className="mt-3 flex flex-col gap-2.5 opacity-40">
            {['UPI', 'Credit / debit card', 'Netbanking', 'Cash on delivery'].map((method) => (
              <div
                key={method}
                className="flex items-center gap-3 rounded-[12px] border border-white/10 px-4 py-3.5 text-[14.5px] text-[#C6C6CC]"
              >
                <span className="h-4 w-4 shrink-0 rounded-full border border-white/25" />
                {method}
                <span className="ml-auto text-[12px] text-[#6E6E76]">Coming soon</span>
              </div>
            ))}
          </div>

          <label className="mt-4 block">
            <span className="mb-2 block text-[12.5px] text-[#7E7E88]">
              Delivery notes (optional)
            </span>
            <textarea
              value={form.notes}
              onChange={(event) => set('notes')(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Gate code, preferred delivery window…"
              className="w-full resize-y rounded-[10px] border border-white/10 bg-[#0C0C0E] px-3.5 py-3 text-[14.5px] text-[#EDEDF0] outline-none transition-colors focus:border-[rgba(247,147,30,.5)]"
            />
          </label>
        </Section>
      </div>

      <aside className="sticky top-[100px] rounded-[18px] border border-white/8 bg-[#08080A] p-6">
        <div className="mb-4.5 text-[16px] font-semibold">Order summary</div>

        <div className="flex flex-col gap-3.5">
          {cart.items.map((item) => (
            <div key={item.id} className="flex items-center gap-3">
              <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-[9px] bg-[#121216]">
                {item.image ? (
                  <Image
                    src={item.image}
                    alt={item.name}
                    fill
                    sizes="44px"
                    className="object-cover"
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 text-[13.5px] leading-[1.35] text-[#C6C6CC]">
                <div className="line-clamp-2">{item.name}</div>
                <div className="mt-1 text-[#6E6E76]">Qty {item.quantity}</div>
              </div>
              <div className="shrink-0 text-[14px] font-medium">{formatPrice(item.lineTotal)}</div>
            </div>
          ))}
        </div>

        <div className="my-5 h-px bg-white/8" />

        <div className="flex flex-col gap-3 text-[14px] text-[#9A9AA2]">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span className="text-white">{formatPrice(cart.totals.subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span>Delivery</span>
            {cart.totals.shipping === 0 ? (
              <span className="text-[#4ED17E]">Free</span>
            ) : (
              <span className="text-white">{formatPrice(cart.totals.shipping)}</span>
            )}
          </div>
        </div>

        <div className="my-5 h-px bg-white/8" />

        <div className="flex items-baseline justify-between">
          <span className="text-[15px] font-medium">Total</span>
          <span className="text-[22px] font-semibold">{formatPrice(cart.totals.total)}</span>
        </div>

        {error ? (
          <div className="mt-4">
            <InlineAlert tone="error">{error}</InlineAlert>
          </div>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          loading={submitting}
          disabled={blocked}
          className="mt-5.5"
        >
          {submitting ? 'Placing order…' : `Place test order · ${formatPrice(cart.totals.total)}`}
        </Button>

        <p className="mb-0 mt-4 text-center text-[12.5px] leading-relaxed text-[#6E6E76]">
          No card is charged. Stock is reserved against the order.
        </p>
      </aside>
    </form>
  );
}

function Section({
  step,
  title,
  children,
  complete = false,
  active = false,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
  complete?: boolean;
  active?: boolean;
}) {
  return (
    <section className="rounded-[16px] border border-white/8 bg-[#08080A] px-5 py-5.5 md:px-6">
      <div className="mb-4.5 flex items-center gap-3">
        <span
          className={cx(
            'grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12.5px] font-medium',
            active ? 'brand-gradient font-semibold text-[#1A0D02]' : 'bg-[#141418] text-[#9A9AA2]',
          )}
        >
          {step}
        </span>
        <span className="text-[16px] font-medium">{title}</span>
        {complete ? (
          <span className="ml-auto text-[13px] text-[#4ED17E]">Complete</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  error,
  className,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'>) {
  return (
    <label className={cx('flex flex-col gap-2', className)}>
      <span className="text-[12.5px] text-[#7E7E88]">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        className={cx(
          'h-11 rounded-[10px] border bg-[#0C0C0E] px-3.5 text-[14.5px] text-[#EDEDF0] outline-none transition-colors',
          error
            ? 'border-[rgba(255,107,107,.55)]'
            : 'border-white/10 focus:border-[rgba(247,147,30,.5)]',
        )}
        {...rest}
      />
      {error ? <span className="text-[12px] text-[#FF8B8B]">{error}</span> : null}
    </label>
  );
}
