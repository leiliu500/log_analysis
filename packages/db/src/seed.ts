/**
 * Seeds a demo session + a couple of findings so the dashboard has content
 * before any real ingestion runs. Run with: npm run db:seed
 */
import { randomUUID } from 'node:crypto';
import { closeDb } from './client.js';
import { ensureSession, insertFinding, insertAlert } from './queries.js';
import type { Finding } from '@log/shared';

async function main(): Promise<void> {
  const now = Date.now();
  const demo: Finding = {
    id: randomUUID(),
    kind: 'anomaly',
    severity: 'high',
    title: 'Error-rate spike on checkout-service',
    summary:
      '5xx rate on checkout-service rose to 12% (baseline 0.4%) between 10:02 and 10:07 UTC, correlated with a downstream payment-gateway timeout.',
    confidence: 0.86,
    sources: ['cloudwatch', 'splunk'],
    fingerprint: 'checkout-5xx-burst',
    evidence: [],
    reasoning: [
      'Observed 214 HTTP 503 responses in a 5-minute window vs. ~3 expected.',
      'Correlated with 198 "payment gateway timeout" errors in Splunk over the same window.',
      'No deploy events in the window → likely upstream dependency degradation.',
    ],
    recommendations: [
      'Check payment-gateway health / circuit-breaker state.',
      'Confirm retry budget is not amplifying load.',
    ],
    metadata: { errorRate: 0.12, baseline: 0.004 },
    windowStart: now - 5 * 60_000,
    windowEnd: now,
    createdAt: now,
  };
  await insertFinding(demo);
  await insertAlert({
    id: randomUUID(),
    findingId: demo.id,
    severity: demo.severity,
    channel: 'dashboard',
    status: 'sent',
    createdAt: now,
  });
  await ensureSession('00000000-0000-0000-0000-000000000001');
  console.log('seeded demo finding + alert');
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
