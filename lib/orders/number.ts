/**
 * Order numbers: one place that knows both formats.
 *
 * Orders placed from September 2026 are `YYMMXXX` — year, month, and the
 * order's position within that month — shown to customers as `#2609001`.
 * Orders placed before that are `SQ-2026-1042`, and they keep those numbers:
 * the number on a customer's confirmation email has to keep working.
 *
 * Both live here rather than in a regex copied into each caller. The previous
 * pattern was written out twice, in account-actions and purchase-actions, so
 * teaching one of them the new format would have left the other quietly
 * failing to recognise the orders it was being asked about.
 */

/** Legacy: SQ-2026-1042. */
const LEGACY = /\b(SQ-\d{4}-\d+)\b/i;

/**
 * Current: 2609001, optionally written #2609001.
 *
 * Deliberately narrow. A bare run of digits in a sentence is far more often a
 * price, a pincode or a phone number than an order, so the first four digits
 * must read as a plausible year and month (20-99, then 01-12) before the rest
 * is taken as a sequence.
 */
const CURRENT = /#?\b([2-9]\d(?:0[1-9]|1[0-2])\d{3,5})\b/;

/**
 * The order number a message refers to, in the form it is stored in.
 *
 * Returns null when the message names none — which is a real answer, not a
 * failure: it is what tells the assistant to ask which order rather than to
 * guess at one.
 */
export function parseOrderNumber(message: string): string | null {
  const legacy = LEGACY.exec(message);
  if (legacy) return legacy[1].toUpperCase();

  const current = CURRENT.exec(message);
  if (current) return current[1];

  return null;
}

/** Does this message name an order at all? */
export function mentionsOrderNumber(message: string): boolean {
  return parseOrderNumber(message) !== null;
}

/**
 * How an order number is shown to a customer.
 *
 * The `#` is presentation only and is never stored, so that "2609001",
 * "#2609001" and "order #2609001" all resolve to the same row.
 */
export function formatOrderNumber(stored: string): string {
  if (!stored) return stored;
  // Legacy numbers already carry their own prefix.
  if (/^SQ-/i.test(stored)) return stored.toUpperCase();
  return stored.startsWith('#') ? stored : `#${stored}`;
}

/** Strip presentation before comparing or querying. */
export function normaliseOrderNumber(value: string): string {
  return value.trim().replace(/^#/, '').toUpperCase();
}
