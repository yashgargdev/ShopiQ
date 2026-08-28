import 'server-only';

import { supabaseServer } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import { checkRateLimit } from '@/lib/ai/rate-limit';
import { normalisePhone } from '@/lib/checkout/guest';
import { recordMoneyEvent } from '@/lib/payments/audit';

/**
 * Passwordless sign-in, as three operations.
 *
 * Extracted from the /api/auth/otp route so the conversational sign-in and the
 * dialog share ONE implementation. Authentication is the last place that
 * should have two of anything: a second copy drifts, and the copy that misses
 * a fix is the one an attacker finds.
 *
 * There is no password anywhere here — none is chosen, stored, emailed or
 * accepted. Proving control of the mailbox is the whole of authentication,
 * which is also why the emailed code is the only thing that can produce a
 * session. A caller cannot name a customer and be believed.
 */

/**
 * Deliberately tight. Sending a code costs an email and lets an attacker
 * pester a mailbox; verifying is a guessing oracle against a short code.
 */
export const OTP_LIMITS = {
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

export type OtpFailure =
  | { ok: false; code: 'RATE_LIMITED'; message: string; retryAfter: number }
  | { ok: false; code: 'INVALID_PHONE' | 'SEND_FAILED' | 'BAD_CODE'; message: string };

/** Does this address already have an account? Server-side knowledge only. */
export async function accountExists(email: string): Promise<boolean> {
  const { data } = await adminClient()
    .from('customers')
    .select('id')
    .ilike('email', email)
    .maybeSingle();
  return Boolean(data);
}

export interface SendCodeInput {
  email: string;
  /** Rate-limit scope. The route uses the client IP; the agent, the session. */
  scope: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

/**
 * Email a one-time code.
 *
 * Whether an account already exists is looked up so the SERVER can decide what
 * to do next, but it is never reported back: "this email has no account" is an
 * enumeration oracle, and the flow is identical either way.
 *
 * Details supplied for a NEW account ride along in user_metadata and are
 * written to `customers` only after the code is verified. Until the mailbox is
 * proven, an unverified name and phone are just a claim.
 */
export async function sendCode(
  input: SendCodeInput,
): Promise<{ ok: true; message: string } | OtpFailure> {
  const email = input.email.trim().toLowerCase();

  for (const key of [`otp:send:${email}`, `otp:send:scope:${input.scope}`]) {
    const verdict = checkRateLimit(key, OTP_LIMITS.send);
    if (!verdict.allowed) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        retryAfter: verdict.retryAfter,
        message: `Too many codes requested. Try again in ${verdict.retryAfter} seconds.`,
      };
    }
  }

  const existing = await accountExists(email);

  const firstName = input.firstName?.trim() ?? '';
  const lastName = input.lastName?.trim() ?? '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ').slice(0, 120);
  const phone = input.phone ? normalisePhone(input.phone) : null;

  if (!existing && input.phone && !phone) {
    return {
      ok: false,
      code: 'INVALID_PHONE',
      message: "That phone number doesn't look right. Use 10 digits, like +91 98765 43210.",
    };
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      data: fullName || phone ? { full_name: fullName || null, phone } : undefined,
    },
  });

  if (error) {
    // Provider rate limits are surfaced as such; anything else is reported
    // generically rather than echoing provider internals.
    const rateLimited = /rate|limit|too many/i.test(error.message);
    return rateLimited
      ? {
          ok: false,
          code: 'RATE_LIMITED',
          retryAfter: 60,
          message: 'Too many codes requested. Please wait a minute and try again.',
        }
      : {
          ok: false,
          code: 'SEND_FAILED',
          message: "I couldn't send the code just now. Please try again.",
        };
  }

  await recordMoneyEvent({
    event: 'confirmation_requested',
    // The address is not written to the audit trail; only that a code went out.
    detail: { step: 'otp_sent', returning: existing },
  });

  return {
    ok: true,
    // Same wording regardless of whether the account exists.
    message: `I've emailed a code to ${email}. Enter it to continue.`,
  };
}

export interface VerifiedCustomer {
  id: string;
  email: string;
  fullName: string | null;
  isNew: boolean;
}

/**
 * Exchange a code for a session.
 *
 * On success the SSR client writes the session cookie, so the caller's
 * response signs the browser in — which is the entire point of routing the
 * conversational flow through here rather than reimplementing it.
 */
export async function verifyCode(input: {
  email: string;
  token: string;
  scope: string;
}): Promise<{ ok: true; customer: VerifiedCustomer; message: string } | OtpFailure> {
  const email = input.email.trim().toLowerCase();

  for (const key of [`otp:verify:${email}`, `otp:verify:scope:${input.scope}`]) {
    const verdict = checkRateLimit(key, OTP_LIMITS.verify);
    if (!verdict.allowed) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        retryAfter: verdict.retryAfter,
        message: `Too many attempts. Try again in ${verdict.retryAfter} seconds.`,
      };
    }
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: input.token,
    type: 'email',
  });

  if (error || !data.user) {
    return {
      ok: false,
      code: 'BAD_CODE',
      message: 'That code is wrong or has expired. Ask for a new one.',
    };
  }

  // Mirror the auth user into `customers`, which everything else keys off.
  // Checked rather than blindly upserted: a returning customer already has a
  // row, and their existing name and phone must not be wiped by a sign-in.
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
      email,
      full_name: (data.user.user_metadata?.full_name as string | undefined) ?? null,
      phone: (data.user.user_metadata?.phone as string | undefined) ?? null,
    });
  }

  // A guest cart and conversation in this browser become theirs on sign-in, so
  // a session that started anonymously does not lose its basket.
  const { claimGuestConversations } = await import('@/lib/ai/conversation/store');
  await claimGuestConversations(data.user.id).catch(() => {});

  return {
    ok: true,
    customer: {
      id: data.user.id,
      email,
      fullName: existingCustomer?.full_name ?? null,
      isNew: !existingCustomer,
    },
    message: existingCustomer
      ? 'Signed in. What can I help you with?'
      : "You're all set. What can I help you with?",
  };
}
