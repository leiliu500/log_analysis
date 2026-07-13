'use client';

import { useRef, useState } from 'react';
import type { ChatResponse } from '@log/shared';
import { api } from '@/lib/api';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  context?: ChatResponse['context'];
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return '00000000-0000-0000-0000-000000000000';
}

export default function ChatPage() {
  const [sessionId] = useState(newSessionId);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setBusy(true);
    try {
      const res = await api.chat(sessionId, text);
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: res.answer, context: res.context },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: `⚠️ Error contacting API: ${String(e)}` },
      ]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }));
    }
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col p-6">
      <h1 className="mb-1 text-xl font-semibold text-white">Log Assistant</h1>
      <p className="mb-4 text-xs text-slate-400">
        Answers are scoped to logs & findings related to your question — not global stats.
        Try: “simulate 50 checkout logs with anomalies to cloudwatch” or “why did checkout 5xx spike?”
      </p>

      <div className="flex-1 space-y-4 overflow-auto rounded-xl border border-edge bg-panel p-4">
        {messages.length === 0 && (
          <p className="text-sm text-slate-500">Ask a question to get started.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
            <div
              className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                m.role === 'user' ? 'bg-sky-600 text-white' : 'bg-edge text-slate-200'
              }`}
            >
              {m.content}
            </div>
            {m.context && (m.context.findings.length > 0 || m.context.logs.length > 0) && (
              <div className="mt-2 text-left text-xs text-slate-400">
                <span className="text-slate-500">Grounded in </span>
                {m.context.findings.length} findings · {m.context.logs.length} logs
                {m.context.route && <> · intent: {m.context.route.intent}</>}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="text-sm text-slate-500">Thinking…</div>}
        <div ref={endRef} />
      </div>

      <div className="mt-3 flex gap-2">
        <textarea
          rows={2}
          className="flex-1 resize-y rounded-xl border border-edge bg-panel px-4 py-3 text-sm outline-none focus:border-sky-500"
          placeholder="Ask about your logs and findings… (Shift+Enter for a new line)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="self-end rounded-xl bg-sky-600 px-5 py-3 text-sm font-medium text-white disabled:opacity-50"
          onClick={send}
          disabled={busy}
        >
          Send
        </button>
      </div>
    </div>
  );
}
