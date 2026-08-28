import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonOk, withErrorHandling, badRequest } from '@/lib/api/response';
import { supabaseServer } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import { checkRateLimit } from '@/lib/ai/rate-limit';
import { looksLikeEmail, normalisePhone } from '@/lib/checkout/guest';
import { recordMoneyEvent } from '@/lib/payments/audit';

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

/**
 * Deliberately tight. Sending a code costs an email and lets an attacker
 * pester a mailbox; verifying is a guessing oracle against a six-digit space.
 */
const OTP_LIMITS = {
  send: { limit: 4, windowMs: 10 * 60_000 },
  verify: { limit: 8, windowMs: 10 * 60_000 },
  /**
   * `check` answers whether an address already has an account, which is an
   * account-enumeration oracle — someone can ask it repeatedly to learn who
   * shops here. The two-step sign-in this product wants cannot be built
   * without it, so it is instead throttled hard per IP: enough for a person
   * mistyping their address, useless for harvesting a list.
   */
  check: { limit: 12, windowMs: 10 * 60_000 },
} as const;

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

    const { data: existing } = await adminClient()
      .from('customers')
      .select('id')
      .ilike('email', normalised)
      .maybeSingle();

    return jsonOk(
      {
        // Nothing but the boolean. No name, no phone, no order history —
        // knowing an account exists must not reveal anything about it.
        exists: Boolean(existing),
        email: normalised,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ---------------------------------------------------------------- send
  if (action === 'send') {
    for (const key of [`otp:send:${normalised}`, `otp:send:ip:${ip}`]) {
      const verdict = checkRateLimit(key, OTP_LIMITS.send);
      if (!verdict.allowed) {
        return NextResponse.json(
          {
            error: {
              code: 'RATE_LIMITED',
              message: `Too many codes requested. Try again in ${verdict.retryAfter} seconds.`,
            },
          },
          { status: 429, headers: { 'Retry-After': String(verdict.retryAfter) } },
        );
      }
    }

    // Whether an account already exists is looked up so the SERVER can decide
    // what to do next — but it is never told to the caller. "This email has no
    // account" is an account-enumeration oracle, and the flow is identical
    // either way, so there is nothing to gain by disclosing it.
    const { data: existing } = await adminClient()
      .from('customers')
      .select('id')
      .ilike('email', normalised)
      .maybeSingle();

    // Details supplied for a NEW account ride along in user_metadata and are
    // written to `customers` only after the code is verified. Until the
    // mailbox is proven, an unverified name and phone are just a claim.
    const firstName = parsed.data.firstName?.trim() ?? '';
    const lastName = parsed.data.lastName?.trim() ?? '';
    const fullName = [firstName, lastName].filter(Boolean).join(' ').slice(0, 120);
    const phone = parsed.data.phone ? normalisePhone(parsed.data.phone) : null;

    if (!existing && parsed.data.phone && !phone) {
      throw badRequest("That phone number doesn't look right. Use 10 digits, like +91 98765 43210.");
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: normalised,
      options: {
        shouldCreateUser: true,
        data: fullName || phone ? { full_name: fullName || null, phone } : undefined,
      },
    });

    if (error) {
      // Rate limits from the auth provider are surfaced as such; anything else
      // is reported generically rather than echoing provider internals.
      const rateLimited = /rate|limit|too many/i.test(error.message);
      return NextResponse.json(
        {
          error: {
            code: rateLimited ? 'RATE_LIMITED' : 'INTERNAL_ERROR',
            message: rateLimited
              ? 'Too many codes requested. Please wait a minute and try again.'
              : "I couldn't send the code just now. Please try again.",
          },
        },
        { status: rateLimited ? 429 : 502 },
      );
    }

    await recordMoneyEvent({
      event: 'confirmation_requested',
      customerId: existing?.id ?? null,
      // The address is not written to the audit trail; only that a code went out.
      detail: { step: 'otp_sent', returning: Boolean(existing) },
    });

    return jsonOk(
      {
        sent: true,
        // Same shape and same wording regardless of whether the account exists.
        message: `I've emailed a 6-digit code to ${normalised}. Enter it to continue.`,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // -------------------------------------------------------------- verify
  if (!token) throw badRequest('Enter the code from your email.');

  for (const key of [`otp:verify:${normalised}`, `otp:verify:ip:${ip}`]) {
    const verdict = checkRateLimit(key, OTP_LIMITS.verify);
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
  }

  const { data, error } = await supabase.auth.verifyOtp({
    email: normalised,
    token,
    type: 'email',
  });

  if (error || !data.user) {
    return NextResponse.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'That code is wrong or has expired. Ask for a new one.',
        },
      },
      { status: 401 },
    );
  }

  // Mirror the auth user into `customers`, which everything else keys off.
  // Upsert rather than insert: a returning customer already has a row, and
  // their existing name and phone must not be wiped by a sign-in.
  const db = adminClient();
  const { data: existingCustomer } = await db
    .from('customers')
    .select('id, full_name, phone')
    .eq('id', data.user.id)
    .maybeSingle();

  if (!existingCustomer) {
    // The mailbox is now proven, so the details captured at sign-up become
    // real rather than a claim.
    await db.from('customers').insert({
      id: data.user.id,
      email: normalised,
      full_name: (data.user.user_metadata?.full_name as string | undefined) ?? null,
      phone: (data.user.user_metadata?.phone as string | undefined) ?? null,
    });
  }

  // A guest cart in this browser becomes theirs on sign-in, so a conversation
  // that started anonymously does not lose its basket.
  const { claimGuestConversations } = await import('@/lib/ai/conversation/store');
  await claimGuestConversations(data.user.id).catch(() => {});

  return jsonOk(
    {
      signedIn: true,
      customer: {
        id: data.user.id,
        email: normalised,
        fullName: existingCustomer?.full_name ?? null,
        isNew: !existingCustomer,
      },
      message: existingCustomer
        ? 'Signed in. What can I help you with?'
        : "You're all set. What can I help you with?",
    },
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
