/**
 * Phase 4 unit tests — no database, no network, no Razorpay account.
 *
 *   node scripts/test-payment-unit.mjs
 *
 * Covers the parts of the money path that are pure functions: minor-unit
 * conversion, the cart hash, and the payment state machine. These are the
 * pieces where a quiet bug is most expensive, and the easiest to test hard.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-loader.mjs', pathToFileURL(`${import.meta.dirname}/`));

const { toMinorUnits, fromMinorUnits, formatMinorUnits, sumMinorUnits, MoneyError } = await import(
  '@/lib/payments/money'
);
const { hashSnapshot, snapshotCart } = await import('@/lib/checkout/confirmation');
const { canTransition } = await import('@/lib/payments/service');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// ============================================================ minor units
section('Minor units');

check('₹80,898 becomes 8089800 paise', toMinorUnits(80898) === 8089800, String(toMinorUnits(80898)));
check('a numeric string works', toMinorUnits('80898.00') === 8089800);
check('two decimals are kept', toMinorUnits('79.99') === 7999, String(toMinorUnits('79.99')));
check('one decimal is padded', toMinorUnits('79.9') === 7990, String(toMinorUnits('79.9')));
check('zero paise', toMinorUnits('0.00') === 0);

// The float trap: 79.99 * 100 is 7998.9999999999991 in IEEE-754.
check(
  'no float drift on the classic case',
  toMinorUnits(79.99) === 7999,
  `got ${toMinorUnits(79.99)}`,
);
check('rounds half up on the third decimal', toMinorUnits('1.005') === 101, String(toMinorUnits('1.005')));
check('truncates below half', toMinorUnits('1.004') === 100, String(toMinorUnits('1.004')));

check('NaN is refused', throws(() => toMinorUnits(NaN)));
check('Infinity is refused', throws(() => toMinorUnits(Infinity)));
check('exponent notation is refused', throws(() => toMinorUnits('1e5')));
check('a currency symbol is refused', throws(() => toMinorUnits('₹500')));
check('an empty string is refused', throws(() => toMinorUnits('')));
check('an absurd amount is refused', throws(() => toMinorUnits('99999999999')));

check('round trips back to rupees', fromMinorUnits(8089800) === 80898);
check('formats for a shopper', formatMinorUnits(8089800).includes('80,898'), formatMinorUnits(8089800));
check('sums as integers', sumMinorUnits([7999, 89900, 100]) === 97999);
check('a non-integer minor unit is refused', throws(() => sumMinorUnits([10.5])));

// Adding many lines must not drift, which is the whole reason for integers.
const manyLines = Array.from({ length: 1000 }, () => toMinorUnits('0.07'));
check('1000 × ₹0.07 is exactly ₹70', sumMinorUnits(manyLines) === 7000, String(sumMinorUnits(manyLines)));

// ============================================================== cart hash
section('Cart hash');

const cartOf = (items, total) => ({
  id: 'cart',
  isGuest: false,
  issues: [],
  items: items.map((item, index) => ({
    id: `line-${index}`,
    productId: item.id,
    name: item.name ?? `Product ${item.id}`,
    slug: 'p',
    brand: 'B',
    image: null,
    quantity: item.qty,
    unitPrice: item.price,
    lineTotal: item.price * item.qty,
    availability: { inStock: true, available: 10, lowStock: false },
  })),
  totals: { subtotal: total, shipping: 0, savings: 0, total, itemCount: items.length },
});

const base = cartOf([{ id: 'a', qty: 1, price: 79999 }], 79999);
const hashA = hashSnapshot(snapshotCart(base));

check('the same cart hashes the same', hashSnapshot(snapshotCart(cartOf([{ id: 'a', qty: 1, price: 79999 }], 79999))) === hashA);

check(
  'a price change changes the hash',
  hashSnapshot(snapshotCart(cartOf([{ id: 'a', qty: 1, price: 82999 }], 82999))) !== hashA,
);
check(
  'a quantity change changes the hash',
  hashSnapshot(snapshotCart(cartOf([{ id: 'a', qty: 2, price: 79999 }], 159998))) !== hashA,
);
check(
  'an added line changes the hash',
  hashSnapshot(
    snapshotCart(cartOf([{ id: 'a', qty: 1, price: 79999 }, { id: 'b', qty: 1, price: 899 }], 80898)),
  ) !== hashA,
);

// Row order is a database detail, not a change to what is being bought.
const twoLines = cartOf([{ id: 'a', qty: 1, price: 79999 }, { id: 'b', qty: 1, price: 899 }], 80898);
const reversed = cartOf([{ id: 'b', qty: 1, price: 899 }, { id: 'a', qty: 1, price: 79999 }], 80898);
check(
  'line order does not change the hash',
  hashSnapshot(snapshotCart(twoLines)) === hashSnapshot(snapshotCart(reversed)),
);

// A renamed product is not a repriced product.
const renamed = cartOf([{ id: 'a', qty: 1, price: 79999, name: 'ASUS TUF Gaming A15 (2025)' }], 79999);
check('a product rename does not change the hash', hashSnapshot(snapshotCart(renamed)) === hashA);

const snap = snapshotCart(twoLines);
check('the snapshot stores minor units', snap.total_minor === 8089800, String(snap.total_minor));
check('the snapshot keeps every line', snap.items.length === 2);
check('the hash is a sha256 hex digest', /^[0-9a-f]{64}$/.test(hashA));

// ======================================================= state machine
section('Payment state machine');

check('created → pending', canTransition('created', 'pending'));
check('pending → captured', canTransition('pending', 'captured'));
check('pending → failed', canTransition('pending', 'failed'));
check('pending → verification_pending', canTransition('pending', 'verification_pending'));
check('verification_pending → captured', canTransition('verification_pending', 'captured'));
check('captured → refunded', canTransition('captured', 'refunded'));

// The ones that must never happen.
check('failed cannot become captured', !canTransition('failed', 'captured'));
check('cancelled cannot become captured', !canTransition('cancelled', 'captured'));
check('captured cannot go back to pending', !canTransition('captured', 'pending'));
check('captured cannot become failed', !canTransition('captured', 'failed'));
check('refunded is terminal', !canTransition('refunded', 'captured'));
check('a repeat of the same state is allowed', canTransition('captured', 'captured'));

console.log(`\n${'='.repeat(56)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
