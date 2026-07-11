/**
 * CLI entrypoint:
 *   npm run simulate -- --app cashMessage --sinks cloudwatch --count 5 --file sample.xml
 * `--file` is a raw sample message file (XML or text). Without it, reads the
 * sample from stdin.
 *
 * Target a specific CloudWatch log group with either:
 *   --log-group adt-d2-scp-log-group       (explicit name)
 *   --content-type scp | scp-restapp | esb  (resolved to a named log group)
 */
import { readFileSync } from 'node:fs';
import { SimulateRequest } from '@log/shared';
import { resolveLogGroup } from '@log/app-scp';
import { simulate } from './simulator.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const file = arg('file');
  const samples = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');

  // --log-group wins over --content-type; both resolve through the shared
  // registry so an explicit name or a content-type keyword works either way.
  const logGroup = resolveLogGroup(arg('log-group') ?? arg('content-type'));

  const req = SimulateRequest.parse({
    application: arg('app', 'cashMessage'),
    samples,
    sinks: (arg('sinks', 'cloudwatch') ?? 'cloudwatch').split(','),
    count: Number(arg('count', '1')),
    spreadMinutes: Number(arg('spread', '0')),
    logGroup,
  });

  const target = req.logGroup ? ` (log group ${req.logGroup})` : '';
  console.log(`Simulating ${req.count} set(s) for "${req.application}" -> ${req.sinks.join(', ')}${target}`);
  const result = await simulate(req);
  console.log('Done:', JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
