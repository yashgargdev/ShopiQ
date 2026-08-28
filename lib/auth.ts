import 'server-only';

import { adminClient } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import type { MerchantRole, SessionUser } from '@/types';

/**
 * Resolve the current session into a ShopiQ user, including whether they are a
 * merchant. Returns null for anonymous visitors.
 *
 * Uses getUser() rather than getSession(): getUser() re-validates the JWT with
 * the auth server, so a tampered cookie cannot forge a session.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: merchant } = await supabase
    .from('merchant_users')
    .select('role, is_active')
    .eq('id', user.id)
    .maybeSingle();

  const isMerchant = Boolean(merchant?.is_active);

  return {
    id: user.id,
    email: user.email ?? '',
    fullName:
      (user.user_metadata?.full_name as string | undefined) ??
      (user.user_metadata?.name as string | undefined) ??
      null,
    isMerchant,
    merchantRole: isMerchant ? ((merchant!.role as MerchantRole) ?? 'staff') : null,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new AuthError('UNAUTHORIZED', 'You must be signed in to do that.');
  }
  return user;
}

export async function requireMerchant(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isMerchant) {
    throw new AuthError('FORBIDDEN', 'This area is restricted to ShopiQ merchants.');
  }
  return user;
}

export class AuthError extends Error {
  readonly code: 'UNAUTHORIZED' | 'FORBIDDEN';

  constructor(code: 'UNAUTHORIZED' | 'FORBIDDEN', message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * A customer row is created by the on_auth_user_created trigger, but a user
 * created before that trigger existed (or through the admin API) may not have
 * one. Orders reference customers, so make sure the row is there.
 */
export async function ensureCustomerRecord(user: SessionUser): Promise<void> {
  const db = adminClient();
  await db
    .from('customers')
    .upsert(
      { id: user.id, email: user.email, full_name: user.fullName },
      { onConflict: 'id', ignoreDuplicates: true },
    );
}
