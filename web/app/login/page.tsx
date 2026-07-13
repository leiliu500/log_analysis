'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const from = params.get('from');
        router.replace(from && from.startsWith('/') ? from : '/');
        router.refresh();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'Login failed');
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-black p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-edge bg-panel p-8 shadow-xl"
      >
        <div className="mb-6 text-center text-xl font-semibold text-white">🛰️ Agentic Log</div>
        <p className="mb-6 text-center text-xs text-slate-500">Sign in to continue</p>

        <label className="mb-1 block text-xs text-slate-400">Username</label>
        <input
          className="mb-4 w-full rounded-lg border border-edge bg-black px-3 py-2 text-sm text-white outline-none focus:border-slate-500"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
        />

        <label className="mb-1 block text-xs text-slate-400">Password</label>
        <input
          type="password"
          className="mb-4 w-full rounded-lg border border-edge bg-black px-3 py-2 text-sm text-white outline-none focus:border-slate-500"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />

        {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-white px-3 py-2 text-sm font-semibold text-black hover:bg-slate-200 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
