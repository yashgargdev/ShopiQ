/**
 * Money handling for the payment layer.
 *
 * Every amount that reaches a payment provider is an integer in the smallest
 * currency unit — paise for INR. ₹80,898.00 is 8089800, never 80898.0.
 *
 * The conversion works on the decimal STRING rather than multiplying a float
 * by 100. `79.99 * 100` is `7998.9999999999991` in IEEE-754, and rounding that
 * happens to give the right answer today only because the error is small; it
 * is not a property to rely on when the number is a charge.
 */

/** Amounts above this are refused outright as a typo or an attack. */
const MAX_MINOR_UNITS = 100_000_000_00; // ₹100 crore

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Convert a rupee amount to integer paise.
 *
 * Accepts the string form Postgres `numeric` arrives as, as well as a number.
 * Anything that is not a plain decimal — NaN, Infinity, exponent notation, a
 * currency symbol — is an error rather than a silent zero.
 */
export function toMinorUnits(amount: number | string): number {
  const text = (typeof amount === 'string' ? amount : String(amount)).trim();

  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new MoneyError(`Not a plain decimal amount: ${JSON.stringify(amount)}`);
  }

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');

  // Two digits of paise, rounded half-up on the third.
  const paiseDigits = (fraction + '000').slice(0, 3);
  const base = Number(`${whole}${paiseDigits.slice(0, 2)}`);
  const rounded = Number(paiseDigits[2]) >= 5 ? base + 1 : base;

  if (!Number.isSafeInteger(rounded)) {
    throw new MoneyError(`Amount is out of safe integer range: ${text}`);
  }
  if (rounded > MAX_MINOR_UNITS) {
    throw new MoneyError(`Amount exceeds the maximum permitted charge: ${text}`);
  }

  return negative ? -rounded : rounded;
}

/** Convert integer paise back to a rupee number, for display and comparison. */
export function fromMinorUnits(minor: number): number {
  if (!Number.isInteger(minor)) {
    throw new MoneyError(`Minor units must be an integer, got ${minor}`);
  }
  return minor / 100;
}

/** Format paise as the shopper sees it: ₹80,898. */
export function formatMinorUnits(minor: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(fromMinorUnits(minor));
}

/**
 * Sum minor-unit amounts. Integer addition, so no rounding drift can creep in
 * across a cart with many lines.
 */
export function sumMinorUnits(values: number[]): number {
  return values.reduce((total, value) => {
    if (!Number.isInteger(value)) throw new MoneyError(`Non-integer minor unit: ${value}`);
    return total + value;
  }, 0);
}
