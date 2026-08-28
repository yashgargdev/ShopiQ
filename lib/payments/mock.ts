import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderOrder,
  type ProviderPayment,
  type WebhookEnvelope,
} from './provider';

/**
 * A deterministic stand-in for Razorpay, used when no Razorpay keys are set.
 *
 * It exists for the same reason the deterministic AI provider does: the
 * interesting logic in this phase is the authorization chain — confirmation,
 * cart hash, price and stock re-validation, signature verification, webhook
 * idempotency, order finalization — and none of that should be untestable
 * because a third-party account is missing.
 *
 * It implements the SAME HMAC-SHA256 scheme Razorpay documents, so the real
 * verification code paths run unchanged against it. What it does not do is
 * move money, so it must never be mistaken for a gateway in production.
 */

const MOCK_SECRET = 'shopiq_mock_secret_not_a_real_key';
const MOCK_KEY_ID = 'rzp_test_mockshopiq';

/** In-memory payments, so fetchPayment() can answer during a test run. */
const payments = new Map<string, ProviderPayment>();

/**
 * Orders this provider handed out, so a synthesized payment can quote the
 * right amount back.
 */
const orders = new Map<string, { amountMinor: number; currency: string }>();

/**
 * Test affordance: a payment id of the form
 *
 *   pay_ok_<providerOrderId>     → the provider reports it captured
 *   pay_fail_<providerOrderId>   → the provider reports it failed
 *
 * An integration test runs in a different process from the server, so it
 * cannot register a payment in this map directly. Encoding the intended
 * outcome in the id lets a test drive the provider's answer without any
 * cross-process plumbing, while still exercising the real verification code.
 *
 * This lives in the mock only, and the mock can never be selected in
 * production (see lib/payments/index.ts).
 */
const SYNTHETIC = /^pay_(ok|fail)_(order_mock_[0-9a-f]+)$/;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Produce a valid checkout signature for a mock order/payment pair. Exported
 * so the test suite can simulate a browser callback without reimplementing —
 * and reimplementing the HMAC in a test would test the test, not the code.
 */
export function mockSignature(orderId: string, paymentId: string): string {
  return createHmac('sha256', MOCK_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

/** Produce a valid webhook signature for a raw body. */
export function mockWebhookSignature(rawBody: string): string {
  return createHmac('sha256', MOCK_SECRET).update(rawBody).digest('hex');
}

/**
 * Register a mock payment so verification can look it up. `status` drives the
 * failure-path tests.
 */
export function registerMockPayment(payment: {
  id: string;
  orderId: string;
  amountMinor: number;
  currency?: string;
  status?: string;
  failureReason?: string | null;
}): ProviderPayment {
  const record: ProviderPayment = {
    id: payment.id,
    orderId: payment.orderId,
    amountMinor: payment.amountMinor,
    currency: payment.currency ?? 'INR',
    status: payment.status ?? 'captured',
    method: 'mock',
    failureReason: payment.failureReason ?? null,
  };
  payments.set(record.id, record);
  return record;
}

export const mockProvider: PaymentProvider = {
  name: 'mock',

  publicKey() {
    return MOCK_KEY_ID;
  },

  isLive() {
    return false;
  },

  async createOrder({ amountMinor, currency, receipt }): Promise<ProviderOrder> {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new PaymentProviderError('BAD_AMOUNT', 'Amount must be positive integer paise.', 400);
    }
    const id = `order_mock_${randomBytes(9).toString('hex')}`;
    orders.set(id, { amountMinor, currency });
    return { id, amountMinor, currency, receipt, status: 'created' };
  },

  verifyPaymentSignature({ orderId, paymentId, signature }): boolean {
    if (!orderId || !paymentId || !signature) return false;
    return safeEqual(mockSignature(orderId, paymentId), signature);
  },

  verifyWebhookSignature(rawBody, signature): boolean {
    if (!signature) return false;
    return safeEqual(mockWebhookSignature(rawBody), signature);
  },

  async fetchPayment(paymentId): Promise<ProviderPayment> {
    const found = payments.get(paymentId);
    if (found) return found;

    const synthetic = SYNTHETIC.exec(paymentId);
    if (synthetic) {
      const [, outcome, orderId] = synthetic;
      const order = orders.get(orderId);
      if (!order) {
        throw new PaymentProviderError('PAYMENT_NOT_FOUND', 'No such mock order.', 404);
      }
      return {
        id: paymentId,
        orderId,
        amountMinor: order.amountMinor,
        currency: order.currency,
        status: outcome === 'ok' ? 'captured' : 'failed',
        method: 'mock',
        failureReason: outcome === 'fail' ? 'Test card declined.' : null,
      };
    }

    throw new PaymentProviderError('PAYMENT_NOT_FOUND', 'No such mock payment.', 404);
  },

  parseWebhook(rawBody): WebhookEnvelope | null {
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!body?.event) return null;
    const entity = body?.payload?.payment?.entity ?? null;
    return {
      eventId: String(body.id ?? entity?.id ?? body.event),
      eventType: String(body.event),
      paymentId: entity?.id ? String(entity.id) : null,
      orderId: entity?.order_id ? String(entity.order_id) : null,
      amountMinor: entity?.amount != null ? Number(entity.amount) : null,
      status: entity?.status ? String(entity.status) : null,
      failureReason: entity?.error_description ? String(entity.error_description) : null,
    };
  },
};
