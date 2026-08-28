'use client';

import { useEffect } from 'react';

import { Button, ErrorState } from '@/components/ui/primitives';

/**
 * Route-level error boundary. Shows a recovery affordance rather than a blank
 * screen, and never surfaces the underlying error text — that can carry
 * database or infrastructure detail.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[shopiq] route error:', error);
  }, [error]);

  return (
    <main className="flex min-h-[70vh] items-center px-5 py-16 md:px-8">
      <div className="mx-auto w-full max-w-[560px]">
        <ErrorState
          title="Something went wrong"
          description="We hit an unexpected problem loading this page. Trying again usually clears it."
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Button variant="primary" onClick={reset}>
                Try again
              </Button>
              <Button variant="ghost" onClick={() => window.location.assign('/')}>
                Back to home
              </Button>
            </div>
          }
        />
        {error.digest ? (
          <p className="mt-4 text-center font-mono text-[11.5px] text-[#4E4E56]">
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
    </main>
  );
}
