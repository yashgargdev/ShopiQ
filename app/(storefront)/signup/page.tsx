import type { Metadata } from 'next';

import { AuthForm } from '@/components/auth/AuthForm';

export const metadata: Metadata = {
  title: 'Create an account',
  robots: { index: false, follow: false },
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/account';

  return (
    <main className="flex min-h-[70vh] items-center px-5 py-16 md:px-8">
      <AuthForm mode="signup" next={next} />
    </main>
  );
}
