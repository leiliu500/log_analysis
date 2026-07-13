import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Log Analysis — Bedrock Agentic Platform',
  description: 'Findings, anomalies, reasoning & a scoped log chatbot.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="w-56 shrink-0 border-r border-edge bg-panel p-4">
            <div className="mb-6 text-lg font-semibold text-white">🛰️ Agentic Log</div>
            <nav className="space-y-1 text-sm">
              <Link className="block rounded-lg px-3 py-2 hover:bg-edge" href="/">
                Dashboard
              </Link>
              <Link className="block rounded-lg px-3 py-2 hover:bg-edge" href="/chat">
                Chatbot
              </Link>
            </nav>
            <p className="mt-8 text-xs text-slate-500">
              Bedrock agents · CloudWatch · Splunk · Grafana · Email
            </p>
          </aside>
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
