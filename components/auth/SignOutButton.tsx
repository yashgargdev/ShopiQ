'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { LogOutIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/primitives';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * Signs out and forces a server re-render so the header, cart badge and any
 * protected page pick up the cleared session immediately.
 */
export function SignOutButton({ label = 'Sign out' }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    await supabaseBrowser().auth.signOut();
    router.replace('/');
    router.refresh();
  };

  return (
    <Button variant="ghost" onClick={signOut} loading={busy}>
      {!busy ? <LogOutIcon size={14} /> : null}
      {label}
    </Button>
  );
}
