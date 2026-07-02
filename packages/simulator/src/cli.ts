/**
 * CLI entrypoint: `npm run simulate -- --app scp --sinks cloudwatch,splunk`
 * Reads a sample request/response from --file (JSON) or uses a default demo.
 */
import { readFileSync } from 'node:fs';
import { SimulateRequest } from '@log/shared';
import { simulate } from './simulator.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const file = arg('file');
  const fromFile = file ? JSON.parse(readFileSync(file, 'utf8')) : {};

  const req = SimulateRequest.parse({
    application: arg('app', fromFile.application ?? 'demo-service'),
    sampleRequest: fromFile.sampleRequest ?? { method: 'POST', path: '/checkout', body: { itemId: 42 } },
    sampleResponse: fromFile.sampleResponse ?? { status: 200, body: { ok: true } },
    sinks: (arg('sinks', 'cloudwatch') ?? 'cloudwatch').split(','),
    count: Number(arg('count', '25')),
    injectAnomalies: arg('anomalies', 'false') === 'true',
    spreadMinutes: Number(arg('spread', '5')),
  });

  console.log(`Simulating ${req.count} logs for "${req.application}" -> ${req.sinks.join(', ')}`);
  const result = await simulate(req);
  console.log('Done:', JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
