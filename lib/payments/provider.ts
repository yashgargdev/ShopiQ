/**
 * The payment provider contract.
 *
 * Nothing outside `lib/payments/` knows that Razorpay exists. The rest of
 * ShopiQ asks this interface for a provider order, a signature check or a
 * payment lookup, exactly as the AI layer asks its provider interface for a
 * completion. That is what lets the whole payment path be tested without a
 * Razorpay account, and what will let a second gateway be added without
 * touching the checkout logic.
 */

export type PaymentProviderName = 'razorpay' | 'mock';

export interface ProviderOrder {
  /** The provider's own order id — `order_...` for Razorpay. */
  id: string;
  amountMinor: number;
  currency: string;
  receipt: string;
  status: string;
}

export interface ProviderPayment {
  id: string;
  orderId: string | null;
  amountMinor: number;
  currency: string;
  /** Provider-native status, e.g. created / authorized / captured / failed. */
  status: string;
  method: string | null;
  failureReason: string | null;
}

export interface WebhookEnvelope {
  /** Provider event id, used for de-duplication. */
  eventId: string;
  eventType: string;
  paymentId: string | null;
  orderId: string | null;
  amountMinor: number | null;
  status: string | null;
  failureReason: string | null;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;

  /** Safe to hand to the browser. Never the secret. */
  publicKey(): string | null;

  /** True when real credentials are configured. */
  isLive(): boolean;

  createOrder(params: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<ProviderOrder>;

  /**
   * Verify the checkout callback signature. Synchronous and constant-time —
   * this is the gate that decides whether a browser's claim of success is
   * worth anything.
   */
  verifyPaymentSignature(params: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean;

  /** Verify a webhook body against the webhook secret. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;

  /** Authoritative payment state, read from the provider rather than the client. */
  fetchPayment(paymentId: string): Promise<ProviderPayment>;

  /** Normalise a verified webhook body into a provider-neutral shape. */
  parseWebhook(rawBody: string, headers: Record<string, string>): WebhookEnvelope | null;
}

export class PaymentProviderError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
    this.status = status;
  }
}
