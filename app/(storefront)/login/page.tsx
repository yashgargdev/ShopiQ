import type { Metadata } from 'next';

import { AuthForm } from '@/components/auth/AuthForm';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.next) ? params.next[0] : params.next;
  // Only same-origin relative paths, so ?next= cannot become an open redirect.
  const next = raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/account';

  return (
    <main className="flex min-h-[70vh] items-center px-5 py-16 md:px-8">
      <AuthForm mode="signin" next={next} />
    </main>
  );
}
