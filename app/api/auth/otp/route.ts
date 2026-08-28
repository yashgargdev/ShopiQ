import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonOk, withErrorHandling, badRequest } from '@/lib/api/response';
import { supabaseServer } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import { checkRateLimit } from '@/lib/ai/rate-limit';
import { looksLikeEmail } from '@/lib/checkout/guest';
import { OTP_LIMITS, accountExists, sendCode, verifyCode } from '@/lib/auth/otp';

/**
 * Passwordless sign-in by emailed code.
 *
 *   POST { action: "send",   email }         → email a one-time code
 *   POST { action: "verify", email, token }  → exchange the code for a session
 *   POST { action: "signout" }               → end the session
 *
 * There is no password anywhere in this flow: none is chosen, stored, emailed
 * or accepted. Proving control of the mailbox is the whole of authentication,
 * which is also why the code is the only thing that can produce a session — a
 * caller cannot name a customer and be believed.
 */

const bodySchema = z
  .object({
    action: z.enum(['check', 'send', 'verify', 'signout']),
    email: z.string().trim().max(200).nullish(),
    /**
     * Supabase's OTP length is a project setting (6–10 digits), so pinning it
     * to six here would reject a valid code the moment that dial moves — which
     * is exactly what happened with an 8-digit project. The range is accepted
     * and the provider remains the authority on whether the code is right.
     */
    token: z
      .string()
      .trim()
      .regex(/^\d{4,10}$/, 'Enter the code from your email.')
      .nullish(),
    /** Collected only when the address has no account yet. */
    firstName: z.string().trim().max(60).nullish(),
    lastName: z.string().trim().max(60).nullish(),
    phone: z.string().trim().max(24).nullish(),
  })
  .strict();

function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

export const POST = withErrorHandling(async (request: Request) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('Invalid sign-in request.', parsed.error.flatten());
  }
  const { action, email, token } = parsed.data;
  const supabase = await supabaseServer();

  // ------------------------------------------------------------- signout
  if (action === 'signout') {
    await supabase.auth.signOut();
    return jsonOk({ signedOut: true }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (!email || !looksLikeEmail(email)) {
    throw badRequest("That doesn't look like an email address.");
  }
  const normalised = email.trim().toLowerCase();
  const ip = clientIp(request);

  // --------------------------------------------------------------- check
  if (action === 'check') {
    const verdict = checkRateLimit(`otp:check:ip:${ip}`, OTP_LIMITS.check);
    if (!verdict.allowed) {
      return NextResponse.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: `Too many attempts. Try again in ${verdict.retryAfter} seconds.`,
          },
        },
        { status: 429, headers: { 'Retry-After': String(verdict.retryAfter) } },
      );
    }

    return jsonOk(
      {
        // Nothing but the boolean. No name, no phone, no order history —
        // knowing an account exists must not reveal anything about it.
        exists: await accountExists(normalised),
        email: normalised,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ---------------------------------------------------------------- send
  if (action === 'send') {
    const sent = await sendCode({
      email: normalised,
      scope: `ip:${ip}`,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      phone: parsed.data.phone,
    });

    if (!sent.ok) {
      const status =
        sent.code === 'RATE_LIMITED' ? 429 : sent.code === 'INVALID_PHONE' ? 400 : 502;
      return NextResponse.json(
        { error: { code: sent.code, message: sent.message } },
        {
          status,
          ...(sent.code === 'RATE_LIMITED'
            ? { headers: { 'Retry-After': String(sent.retryAfter) } }
            : {}),
        },
      );
    }

    return jsonOk(
      { sent: true, message: sent.message },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // -------------------------------------------------------------- verify
  if (!token) throw badRequest('Enter the code from your email.');

  const verified = await verifyCode({ email: normalised, token, scope: `ip:${ip}` });

  if (!verified.ok) {
    return NextResponse.json(
      {
        error: {
          code: verified.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'UNAUTHORIZED',
          message: verified.message,
        },
      },
      {
        status: verified.code === 'RATE_LIMITED' ? 429 : 401,
        ...(verified.code === 'RATE_LIMITED'
          ? { headers: { 'Retry-After': String(verified.retryAfter) } }
          : {}),
      },
    );
  }

  return jsonOk(
    { signedIn: true, customer: verified.customer, message: verified.message },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

/** Who, if anyone, is signed in. Used by the header and the agent. */
export const GET = withErrorHandling(async () => {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return jsonOk({ signedIn: false, customer: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const { data: customer } = await adminClient()
    .from('customers')
    .select('id, email, full_name, phone')
    .eq('id', user.id)
    .maybeSingle();

  return jsonOk(
    {
      signedIn: true,
      customer: {
        id: user.id,
        email: customer?.email ?? user.email ?? null,
        fullName: customer?.full_name ?? null,
        phone: customer?.phone ?? null,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
