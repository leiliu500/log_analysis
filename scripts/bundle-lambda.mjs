/**
 * Bundles the Bedrock action-group + ingest-poller Lambda handlers into a
 * single infra/build/lambda/index.js that exports `actionGroupHandler` and
 * `ingestPollerHandler`. Run: node scripts/bundle-lambda.mjs
 */
import { build } from 'esbuild';
import { mkdirSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'infra', 'build', 'lambda');
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [join(root, 'packages', 'agents', 'src', 'index.ts')],
  outfile: join(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  // The Node 20 Lambda runtime ships the AWS SDK v3; keep it external.
  external: ['@aws-sdk/*'],
  logLevel: 'info',
});

// Ship the externalized LLM system prompts beside the bundle so @log/shared's
// loadPrompt() resolves them at runtime (the Lambda zip is source_dir =
// build/lambda, so prompts/ unzips next to index.js under the task root).
cpSync(join(root, 'prompts'), join(outdir, 'prompts'), { recursive: true });

console.log('Lambda bundle written to', outdir);
