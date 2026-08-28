import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Refreshes the Supabase session cookie on every request and gates the
 * authenticated areas.
 *
 * This is a first line of defence for UX — it redirects rather than 403s. The
 * real enforcement is Row Level Security in Postgres plus requireUser() /
 * requireMerchant() inside each route handler, both of which hold even if a
 * request somehow bypasses this proxy.
 *
 * Named proxy.ts per the Next 16 convention (the old middleware.ts name is
 * deprecated).
 */

/**
 * Customer areas that still bounce a signed-out visitor.
 *
 * `/account` is deliberately NOT here. Sign-in is a dialog on the agent screen,
 * not a page, so there is nowhere sensible to redirect to — and the account
 * pages already render a "sign in to see this" state of their own, which keeps
 * the customer where they were instead of throwing them somewhere else. Their
 * APIs answer 401 regardless, so nothing is exposed by letting the page load.
 */
const CUSTOMER_PREFIXES = ['/checkout'];
const MERCHANT_PREFIX = '/merchant';
const MERCHANT_ACCESS_PATH = '/merchant/access';

export default async function proxy(request: NextRequest) {
  // Payment webhooks are server-to-server: Razorpay carries no session cookie,
  // and its authentication is the HMAC signature the route verifies over the
  // raw body. Refreshing a session here would be a pointless round trip on
  // every retry, so it short-circuits before any auth work.
  if (request.nextUrl.pathname === '/api/payments/webhook') {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Revalidates the JWT with the auth server rather than trusting the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;

  const needsCustomer = CUSTOMER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  // /merchant/access is the "you are not a merchant" landing page, so it must
  // stay reachable by non-merchants or the redirect below would loop.
  const needsMerchant =
    pathname !== MERCHANT_ACCESS_PATH &&
    (pathname === MERCHANT_PREFIX || pathname.startsWith(`${MERCHANT_PREFIX}/`));

  if ((needsCustomer || needsMerchant) && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (needsMerchant && user) {
    const { data: merchant } = await supabase
      .from('merchant_users')
      .select('id, is_active')
      .eq('id', user.id)
      .maybeSingle();

    if (!merchant?.is_active) {
      const url = request.nextUrl.clone();
      url.pathname = '/merchant/access';
      url.search = '';
      return NextResponse.redirect(url);
    }
  }

  // Signed-in users have no business on the legacy auth screens.
  if (user && (pathname === '/login' || pathname === '/signup')) {
    const url = request.nextUrl.clone();
    url.pathname = request.nextUrl.searchParams.get('next') ?? '/account';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image optimisation, both of which
     * would only pay the auth round trip for nothing.
     *
     * `.well-known` is excluded for the same reason and one more: nothing
     * under it can ever require a session. It is fetched by agents that have
     * no session to present — Google's association service checking for an
     * Android app, Apple's equivalent, and ACME certificate challenges — so
     * running auth there is a billable invocation that can only ever say yes.
     *
     * The web manifest is public by definition; a manifest that needed a
     * login would defeat its own purpose.
     */
    '/((?!_next/static|_next/image|\\.well-known|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest)$).*)',
  ],
};

