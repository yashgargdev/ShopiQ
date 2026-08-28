import 'server-only';
import { mockProvider } from './mock';
import { razorpayProvider } from './razorpay';
import type { PaymentProvider } from './provider';

export * from './provider';
export * from './money';

/**
 * Select the payment provider.
 *
 * Razorpay whenever its keys are present. Otherwise the deterministic mock, so
 * the checkout chain remains exercisable — but only outside production. A
 * production deployment with no gateway configured must fail loudly at the
 * point of payment rather than quietly accept a fake one; a mock provider that
 * silently stands in for a real gateway is how a store starts shipping goods
 * nobody paid for.
 */
export function paymentProvider(): PaymentProvider {
  /**
   * Explicit override, for deterministic tests.
   *
   * Once real Razorpay keys are configured they win by default — which is
   * correct, and which also means the flow suites can no longer fabricate a
   * valid signature or a payment the provider has never heard of. Those suites
   * exercise idempotency, price changes, stock changes and webhook
   * de-duplication, none of which need a real gateway; the real gateway is
   * verified separately by actually creating an order against it.
   *
   * Refused in production regardless, by the same guard as the fallback below.
   */
  const forced = process.env.PAYMENTS_PROVIDER?.trim();
  if (forced === 'mock') {
    if (process.env.NODE_ENV === 'production' && process.env.PAYMENTS_ALLOW_MOCK !== 'true') {
      throw new Error('PAYMENTS_PROVIDER=mock is not permitted in production.');
    }
    return mockProvider;
  }

  if (razorpayProvider.isLive()) return razorpayProvider;

  if (process.env.NODE_ENV === 'production' && process.env.PAYMENTS_ALLOW_MOCK !== 'true') {
    throw new Error(
      'No payment provider is configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
    );
  }
  return mockProvider;
}

/** Provider status for /api/ai/status and the payment UI. Never a secret. */
export function paymentStatus(): {
  provider: 'razorpay' | 'mock' | 'none';
  live: boolean;
  testMode: boolean;
  publicKey: string | null;
} {
  // Must agree with paymentProvider(). Reporting "razorpay" while the mock is
  // the thing actually running would put a false claim in the UI and in the
  // status endpoint, which is precisely where it would be believed.
  if (process.env.PAYMENTS_PROVIDER?.trim() === 'mock') {
    return { provider: 'mock', live: false, testMode: true, publicKey: mockProvider.publicKey() };
  }

  const live = razorpayProvider.isLive();
  if (live) {
    const key = razorpayProvider.publicKey();
    return {
      provider: 'razorpay',
      live: true,
      // Razorpay test keys are prefixed rzp_test_. Anything else is live money.
      testMode: Boolean(key?.startsWith('rzp_test_')),
      publicKey: key,
    };
  }

  if (process.env.NODE_ENV === 'production' && process.env.PAYMENTS_ALLOW_MOCK !== 'true') {
    return { provider: 'none', live: false, testMode: false, publicKey: null };
  }
  return { provider: 'mock', live: false, testMode: true, publicKey: mockProvider.publicKey() };
}
