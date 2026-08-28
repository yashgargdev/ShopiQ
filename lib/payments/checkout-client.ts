/**
 * Browser-side payment launch.
 *
 * This file runs in the browser, so it must never import anything from
 * lib/payments/* that reads a secret — it deals only in the publishable key
 * and identifiers the server chose to hand over.
 *
 * The result of the provider checkout is a CLAIM. Every path here ends by
 * posting identifiers to the server for verification; none of them treats the
 * modal closing successfully as proof that anything was paid.
 */

export interface LaunchPaymentInput {
  provider: string;
  publicKey: string | null;
  providerOrderId: string;
  amountMinor: number;
  currency: string;
  customerName?: string | null;
  customerEmail?: string | null;
  conversationId?: string | null;
}

export type LaunchOutcome =
  | { status: 'succeeded'; orderId: string; orderNumber: string; totalDisplay: string | null; message: string }
  | { status: 'failed'; message: string; reason?: string }
  | { status: 'cancelled'; message: string }
  | { status: 'verification_pending'; message: string };

const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

let scriptPromise: Promise<boolean> | null = null;

function loadRazorpay(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if ((window as any).Razorpay) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<boolean>((resolve) => {
    const script = document.createElement('script');
    script.src = RAZORPAY_SCRIPT;
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return scriptPromise;
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

/** Ask the server to judge what the provider reported. */
async function verify(claim: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
  conversationId?: string | null;
}): Promise<LaunchOutcome> {
  const { status, payload } = await postJson('/api/payments/verify', claim);

  if (status === 200 && payload?.payment?.order) {
    return {
      status: 'succeeded',
      orderId: payload.payment.order.id,
      orderNumber: payload.payment.order.order_number,
      totalDisplay: payload.payment.order.total_display ?? null,
      message: payload.payment.message,
    };
  }

  const details = payload?.error?.details;
  if (details?.status === 'verification_pending') {
    return {
      status: 'verification_pending',
      message:
        payload?.error?.message ??
        "I couldn't verify the payment yet, so I haven't marked the order as confirmed.",
    };
  }

  return {
    status: 'failed',
    reason: details?.reason ?? undefined,
    message:
      payload?.error?.message ??
      "The payment wasn't completed. Your cart is still safe, and you can try again.",
  };
}

/**
 * Open the provider checkout and resolve once the server has ruled on the
 * outcome.
 */
export async function launchPayment(input: LaunchPaymentInput): Promise<LaunchOutcome> {
  // Deterministic mock: there is no real modal to open, so ask the server to
  // originate the callback. Gated server-side to the mock provider.
  if (input.provider === 'mock') {
    const { status, payload } = await postJson('/api/payments/mock-complete', {
      razorpay_order_id: input.providerOrderId,
      outcome: 'success',
      conversationId: input.conversationId ?? null,
    });

    if (status === 200 && payload?.payment?.order) {
      return {
        status: 'succeeded',
        orderId: payload.payment.order.id,
        orderNumber: payload.payment.order.order_number,
        totalDisplay: payload.payment.order.total_display ?? null,
        message: payload.payment.message,
      };
    }
    const details = payload?.error?.details;
    return details?.status === 'verification_pending'
      ? { status: 'verification_pending', message: payload?.error?.message ?? 'Still verifying.' }
      : {
          status: 'failed',
          reason: details?.reason,
          message: payload?.error?.message ?? 'The payment could not be completed.',
        };
  }

  const ready = await loadRazorpay();
  if (!ready || !input.publicKey) {
    return {
      status: 'failed',
      message: "I couldn't open the payment window. Nothing has been charged — please try again.",
    };
  }

  return new Promise<LaunchOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: LaunchOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const razorpay = new (window as any).Razorpay({
      key: input.publicKey,
      order_id: input.providerOrderId,
      // Razorpay re-reads the authoritative amount from the order it was given;
      // these are for display only and cannot change what is charged.
      amount: input.amountMinor,
      currency: input.currency,
      name: 'ShopiQ',
      description: 'ShopiQ order',
      prefill: {
        name: input.customerName ?? undefined,
        email: input.customerEmail ?? undefined,
      },
      theme: { color: '#F7931E' },
      handler: (response: any) => {
        void verify({
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
          conversationId: input.conversationId ?? null,
        }).then(settle);
      },
      modal: {
        ondismiss: () => {
          void postJson('/api/payments/verify', {
            razorpay_order_id: input.providerOrderId,
            reason: 'dismissed_by_customer',
            cancelled: true,
          }).then(() =>
            settle({
              status: 'cancelled',
              message: 'No problem — nothing has been charged and your cart is untouched.',
            }),
          );
        },
      },
    });

    razorpay.on('payment.failed', (event: any) => {
      void postJson('/api/payments/verify', {
        razorpay_order_id: input.providerOrderId,
        reason: String(event?.error?.description ?? 'payment_failed').slice(0, 200),
        cancelled: false,
      }).then(() =>
        settle({
          status: 'failed',
          message: "The payment wasn't completed. Your cart is still safe, and you can try again.",
        }),
      );
    });

    razorpay.open();
  });
}
