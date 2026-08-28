'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ShopiQMark } from '@/components/layout/SiteHeader';
import { Button, InlineAlert } from '@/components/ui/primitives';
import { cx } from '@/lib/format';
import { supabaseBrowser } from '@/lib/supabase/client';
import { signInSchema, signUpSchema } from '@/lib/validation/schemas';

/**
 * Sign in / sign up.
 *
 * Auth runs through Supabase in the browser so the session cookie is set by the
 * SSR helper; middleware then keeps it fresh. Passwords never touch a ShopiQ
 * API route.
 */
export function AuthForm({ mode, next }: { mode: 'signin' | 'signup'; next: string }) {
  const router = useRouter();
  const isSignUp = mode === 'signup';

  const [form, setForm] = useState({ fullName: '', email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof typeof form) => (value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: '' }));
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});

    const schema = isSignUp ? signUpSchema : signInSchema;
    const parsed = schema.safeParse(form);

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        next[String(issue.path[0])] = issue.message;
      }
      setFieldErrors(next);
      setSubmitting(false);
      return;
    }

    const supabase = supabaseBrowser();

    if (isSignUp) {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: form.email,
        password: form.password,
        options: { data: { full_name: form.fullName } },
      });

      if (signUpError) {
        setError(friendlyAuthError(signUpError.message));
        setSubmitting(false);
        return;
      }

      // With email confirmation enabled there is no session yet.
      if (!data.session) {
        setNotice(
          'Check your inbox — we sent a confirmation link. Once confirmed you can sign in.',
        );
        setSubmitting(false);
        return;
      }
    } else {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: form.email,
        password: form.password,
      });

      if (signInError) {
        setError(friendlyAuthError(signInError.message));
        setSubmitting(false);
        return;
      }
    }

    // A full refresh lets middleware and the server layout pick up the session.
    router.replace(next);
    router.refresh();
  };

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <div className="mb-8 flex flex-col items-center text-center">
        <ShopiQMark size={44} />
        <h1 className="mb-0 mt-5 text-[26px] font-semibold leading-tight tracking-[-0.03em]">
          {isSignUp ? 'Create your ShopiQ account' : 'Welcome back'}
        </h1>
        <p className="mb-0 mt-2.5 text-[14.5px] leading-relaxed text-[#7E7E88]">
          {isSignUp
            ? 'Your guest cart comes with you.'
            : 'Sign in to see your orders and saved cart.'}
        </p>
      </div>

      <form
        onSubmit={submit}
        className="flex flex-col gap-3.5 rounded-[18px] border border-white/8 bg-[#08080A] p-6"
      >
        {notice ? <InlineAlert tone="success">{notice}</InlineAlert> : null}
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}

        {isSignUp ? (
          <Field
            label="Full name"
            value={form.fullName}
            onChange={set('fullName')}
            error={fieldErrors.fullName}
            autoComplete="name"
            required
          />
        ) : null}

        <Field
          label="Email"
          type="email"
          value={form.email}
          onChange={set('email')}
          error={fieldErrors.email}
          autoComplete="email"
          required
        />

        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={set('password')}
          error={fieldErrors.password}
          autoComplete={isSignUp ? 'new-password' : 'current-password'}
          placeholder={isSignUp ? 'At least 8 characters' : undefined}
          required
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          loading={submitting}
          className="mt-2"
        >
          {isSignUp ? 'Create account' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-6 text-center text-[14px] text-[#7E7E88]">
        {isSignUp ? 'Already have an account? ' : "Don't have an account? "}
        <Link
          href={
            isSignUp
              ? `/login?next=${encodeURIComponent(next)}`
              : `/signup?next=${encodeURIComponent(next)}`
          }
          className="text-[#F7931E] hover:text-[#FFB65C]"
        >
          {isSignUp ? 'Sign in' : 'Create one'}
        </Link>
      </p>
    </div>
  );
}

/** Supabase auth messages are terse; map the common ones to something useful. */
function friendlyAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('invalid login credentials')) {
    return 'That email and password combination did not match. Check both and try again.';
  }
  if (lower.includes('already registered') || lower.includes('already been registered')) {
    return 'An account with that email already exists. Try signing in instead.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Confirm your email address first — check your inbox for the link.';
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  if (lower.includes('password')) return message;
  return 'We could not complete that. Please try again.';
}

function Field({
  label,
  value,
  onChange,
  error,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[12.5px] text-[#7E7E88]">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        className={cx(
          'h-11 rounded-[10px] border bg-[#0C0C0E] px-3.5 text-[14.5px] text-[#EDEDF0] outline-none transition-colors',
          error
            ? 'border-[rgba(255,107,107,.55)]'
            : 'border-white/10 focus:border-[rgba(247,147,30,.5)]',
        )}
        {...rest}
      />
      {error ? <span className="text-[12px] text-[#FF8B8B]">{error}</span> : null}
    </label>
  );
}
