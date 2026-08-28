/**
 * Formatting helpers. These are the ONLY place a price becomes a string —
 * everything upstream (database, API, cart maths) keeps it a number.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const INR_PAISE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
});

export function formatPrice(amount: number, currency = 'INR'): string {
  if (!Number.isFinite(amount)) return '—';
  if (currency !== 'INR') {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(amount);
  }
  // Show paise only when they are actually non-zero.
  return Number.isInteger(amount) ? INR.format(amount) : INR_PAISE.format(amount);
}

/** Compact form for dashboard tiles: ₹2.4L, ₹1.2Cr. */
export function formatCompactPrice(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (amount >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(amount >= 100_000_000 ? 0 : 1)}Cr`;
  if (amount >= 100_000) return `₹${(amount / 100_000).toFixed(amount >= 1_000_000 ? 0 : 1)}L`;
  if (amount >= 1_000) return `₹${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  return formatPrice(amount);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}

export function discountPercent(price: number, compareAt: number | null | undefined): number | null {
  if (!compareAt || compareAt <= price) return null;
  const percent = Math.round(((compareAt - price) / compareAt) * 100);
  return percent >= 1 ? percent : null;
}

export function formatDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** Expected delivery date shown on the product page. */
export function deliveryEstimate(daysFromNow = 2): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

/** Renders a spec value with its unit: 32 GB, 2.2 kg, 15.6 in. */
export function formatSpecValue(value: string | number, unit?: string | null): string {
  const base = typeof value === 'number' ? formatNumber(value) : value;
  return unit ? `${base} ${unit}` : base;
}

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
