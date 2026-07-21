import Link from 'next/link';
import { SignOut } from '@/components/SignOut';

/**
 * Layout for the authenticated app pages (route group "(app)" — no URL segment).
 * Everything under here is gated by the auth middleware; the bare /login page uses
 * the root layout instead, so it renders without this sidebar.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-panel p-4">
        <div className="mb-6 text-lg font-semibold text-white">🛰️ Agentic Log</div>
        <nav className="space-y-1 text-sm">
          <Link className="block rounded-lg px-3 py-2 hover:bg-edge" href="/">
            Dashboard
          </Link>
          <Link className="block rounded-lg px-3 py-2 hover:bg-edge" href="/validation">
            Validation
          </Link>
          <Link className="block rounded-lg px-3 py-2 hover:bg-edge" href="/chat">
            Chatbot
          </Link>
        </nav>
        <p className="mt-8 text-xs text-slate-500">
          Bedrock agents · CloudWatch · Splunk · Grafana · Email
        </p>
        <div className="mt-auto pt-6">
          <SignOut />
        </div>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
