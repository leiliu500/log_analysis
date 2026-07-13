'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full rounded-lg border border-edge px-3 py-2 text-left text-sm text-slate-400 hover:bg-edge hover:text-white disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
