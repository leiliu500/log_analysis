import { writeFileSync } from 'node:fs';
import { corpus } from './corpus.js';
import { runBacktest } from './runner.js';
import { formatReport, reportToJson } from './report.js';

/**
 * Backtest CLI — `npm run backtest` (optionally `-- --json <path>`). Replays the full
 * gold-set corpus through the real validation engine, prints the report, optionally
 * writes a JSON artifact, and exits non-zero on any false positive / false negative /
 * delta miss so it gates CI.
 */
const report = runBacktest(corpus);
console.log(formatReport(report));

const jsonFlag = process.argv.indexOf('--json');
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  const path = process.argv[jsonFlag + 1]!;
  writeFileSync(path, reportToJson(report));
  console.log(`\nJSON report written to ${path}`);
}

process.exit(report.passed ? 0 : 1);
