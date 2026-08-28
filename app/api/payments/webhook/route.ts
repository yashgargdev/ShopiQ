import { NextResponse } from 'next/server';
import { paymentProvider } from '@/lib/payments';
import { processWebhook } from '@/lib/payments/service';
import { recordMoneyEvent } from '@/lib/payments/audit';

/**
 * POST /api/payments/webhook
 *
 * Razorpay's server-to-server notification. This is the path that must keep
 * working when the customer closes the tab mid-payment.
 *
 * Three things matter here:
 *
 *   1. The RAW body is read before anything parses it. Signature verification
 *      is over exact bytes — re-serialising parsed JSON changes them and the
 *      HMAC stops matching.
 *   2. Nothing is processed until the signature verifies. An unverified body
 *      is an anonymous stranger claiming a payment succeeded.
 *   3. It is idempotent, because the same event will arrive more than once.
 *
 * There is no authentication here by design — Razorpay cannot hold a session —
 * so the signature IS the authentication.
 */

/**
 * Pinned to the Node runtime and never cached.
 *
 * The signature is an HMAC over the exact request bytes, and this route must
 * behave identically on every deployment target. Leaving the runtime implicit
 * invites a future edge migration to change body handling underneath the one
 * check standing between a stranger and a "payment succeeded" record.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request) {
  const rawBody = await request.text();

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const signature = headers['x-razorpay-signature'] ?? '';
  const provider = paymentProvider();

  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    await recordMoneyEvent({
      event: 'webhook_rejected',
      detail: {
        reason: 'signature_invalid',
        // The signature itself is never recorded — a stored signature beside a
        // stored body is a verification oracle.
        event_type: headers['x-razorpay-event-id'] ? 'present' : 'absent',
      },
    });
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Invalid signature.' } },
      { status: 403 },
    );
  }

  try {
    const result = await processWebhook(rawBody, headers);
    // 200 even for an event we chose not to act on: a non-2xx tells Razorpay
    // to retry, and retrying an event we deliberately ignored is pointless.
    return NextResponse.json(
      { received: true, handled: result.handled, duplicate: result.duplicate },
      { status: 200 },
    );
  } catch (error) {
    // A real processing failure SHOULD be retried, so this one is a 500.
    await recordMoneyEvent({
      event: 'webhook_rejected',
      detail: { reason: 'processing_error', message: String(error).slice(0, 200) },
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Could not process webhook.' } },
      { status: 500 },
    );
  }
}

/** Razorpay only ever POSTs here. */
export function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED', message: 'Webhook accepts POST only.' } },
    { status: 405 },
  );
}
