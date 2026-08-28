import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role client. Bypasses every RLS policy.
 *
 * `import 'server-only'` makes it a build error to pull this into a client
 * component, so the key cannot reach a browser bundle.
 *
 * Only three things legitimately need it:
 *   1. guest carts, which are keyed by an httpOnly cookie rather than a JWT;
 *   2. the order RPCs, which must validate prices and stock outside the
 *      caller's session;
 *   3. merchant writes, after the route has verified the caller is a merchant.
 *
 * Anything user-scoped belongs on `supabaseServer()` instead.
 */
let cached: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase admin client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-shopiq-client': 'server-admin' } },
  });
  return cached;
}
