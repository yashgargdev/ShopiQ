import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderOrder,
  type ProviderPayment,
  type WebhookEnvelope,
} from './provider';

/**
 * Razorpay, test mode.
 *
 * Talks to the documented REST API directly rather than pulling in the SDK —
 * three endpoints and two HMACs do not warrant a dependency, and it keeps the
 * exact wire behaviour visible at the call site.
 *
 * The secret and the webhook secret are read here and nowhere else. This file
 * imports `server-only`, so any accidental import from a client component
 * fails the build rather than shipping a key to the browser.
 */

const API = 'https://api.razorpay.com/v1';

function keyId(): string | null {
  return process.env.RAZORPAY_KEY_ID?.trim() || null;
}
function keySecret(): string | null {
  return process.env.RAZORPAY_KEY_SECRET?.trim() || null;
}
function webhookSecret(): string | null {
  return process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || null;
}

/**
 * Constant-time comparison. A plain `===` on a signature leaks how many
 * leading bytes were right through timing, which is enough to forge one.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function authHeader(): string {
  const id = keyId();
  const secret = keySecret();
  if (!id || !secret) {
    throw new PaymentProviderError('PROVIDER_NOT_CONFIGURED', 'Razorpay keys are not set.', 503);
  }
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });
  } catch (cause) {
    throw new PaymentProviderError('PROVIDER_UNREACHABLE', 'Could not reach Razorpay.', 502);
  }

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* handled below */
  }

  if (!response.ok) {
    const description = body?.error?.description ?? `Razorpay returned ${response.status}.`;
    throw new PaymentProviderError(
      body?.error?.code ?? 'PROVIDER_ERROR',
      String(description).slice(0, 300),
      response.status === 400 ? 400 : 502,
    );
  }
  return body as T;
}

export const razorpayProvider: PaymentProvider = {
  name: 'razorpay',

  publicKey() {
    return keyId();
  },

  isLive() {
    return Boolean(keyId() && keySecret());
  },

  async createOrder({ amountMinor, currency, receipt, notes }): Promise<ProviderOrder> {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new PaymentProviderError('BAD_AMOUNT', 'Amount must be positive integer paise.', 400);
    }

    const order = await call<any>('/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: amountMinor,
        currency,
        receipt,
        // Razorpay captures automatically; we still verify server-side before
        // an order exists in ShopiQ.
        payment_capture: 1,
        notes: notes ?? {},
      }),
    });

    return {
      id: String(order.id),
      amountMinor: Number(order.amount),
      currency: String(order.currency),
      receipt: String(order.receipt ?? receipt),
      status: String(order.status ?? 'created'),
    };
  },

  verifyPaymentSignature({ orderId, paymentId, signature }): boolean {
    const secret = keySecret();
    if (!secret || !orderId || !paymentId || !signature) return false;
    // Razorpay's documented checkout signature: HMAC-SHA256 of
    // "<order_id>|<payment_id>" keyed with the API secret.
    const expected = createHmac('sha256', secret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    return safeEqual(expected, signature);
  },

  verifyWebhookSignature(rawBody, signature): boolean {
    const secret = webhookSecret();
    if (!secret || !signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  },

  async fetchPayment(paymentId): Promise<ProviderPayment> {
    const payment = await call<any>(`/payments/${encodeURIComponent(paymentId)}`);
    return {
      id: String(payment.id),
      orderId: payment.order_id ? String(payment.order_id) : null,
      amountMinor: Number(payment.amount),
      currency: String(payment.currency),
      status: String(payment.status),
      method: payment.method ? String(payment.method) : null,
      failureReason: payment.error_description ? String(payment.error_description) : null,
    };
  },

  parseWebhook(rawBody): WebhookEnvelope | null {
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const entity = body?.payload?.payment?.entity ?? body?.payload?.order?.entity ?? null;
    if (!body?.event) return null;

    return {
      // Razorpay sends x-razorpay-event-id as a header; the body id is the
      // fallback so a replay is still detectable either way.
      eventId: String(body.id ?? entity?.id ?? body.event),
      eventType: String(body.event),
      paymentId: body?.payload?.payment?.entity?.id
        ? String(body.payload.payment.entity.id)
        : null,
      orderId: entity?.order_id ? String(entity.order_id) : entity?.id ? String(entity.id) : null,
      amountMinor: entity?.amount != null ? Number(entity.amount) : null,
      status: entity?.status ? String(entity.status) : null,
      failureReason: entity?.error_description ? String(entity.error_description) : null,
    };
  },
};
