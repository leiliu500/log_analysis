/**
 * CLI entrypoint:
 *   npm run simulate -- --app cashMessage --sinks cloudwatch --count 5 --file sample.xml
 * `--file` is a raw sample message file (XML or text). Without it, reads the
 * sample from stdin.
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
  const samples = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');

  const req = SimulateRequest.parse({
    application: arg('app', 'cashMessage'),
    samples,
    sinks: (arg('sinks', 'cloudwatch') ?? 'cloudwatch').split(','),
    count: Number(arg('count', '1')),
    spreadMinutes: Number(arg('spread', '0')),
  });

  console.log(`Simulating ${req.count} set(s) for "${req.application}" -> ${req.sinks.join(', ')}`);
  const result = await simulate(req);
  console.log('Done:', JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
