import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

/**
 * Loader for the externalized LLM system prompts under the repo's top-level
 * `prompts/` folder. Each prompt lives in its own `.md` file (e.g.
 * `prompts/bedrock/supervisor.md`) so the instructions are editable and
 * reviewable as prose, separate from the code that sends them.
 *
 * The same `prompts/` tree is shipped to every runtime that reads it:
 *   - dev (tsx) + prod API (`node dist`): resolved by walking up from this
 *     module to the repo root (Dockerfile.api copies `prompts/` into the image).
 *   - the Bedrock action-group / ingest Lambda: `scripts/bundle-lambda.mjs`
 *     copies `prompts/` next to the esbuild bundle, so it sits beside index.js.
 * Set PROMPTS_DIR to override the location explicitly.
 */
/**
 * Candidate `prompts/` roots, most specific first. A `prompts/` dir sits either
 * beside the bundle (Lambda) or at the repo root some levels above this module
 * (packages/shared/{src,dist} -> repo). We keep every candidate and let
 * {@link loadPrompt} pick the first one that actually contains the requested
 * file, so a stray/empty `prompts/` dir higher or lower in the tree can't shadow
 * the real one.
 */
function candidateRoots(): string[] {
  const roots: string[] = [];
  if (process.env.PROMPTS_DIR) roots.push(process.env.PROMPTS_DIR);

  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  let d = here;
  for (let i = 0; i < 8; i++) {
    roots.push(join(d, 'prompts'));
    d = dirname(d);
  }
  roots.push(join(process.cwd(), 'prompts'));
  return roots;
}

const cache = new Map<string, string>();

/**
 * Read a prompt by its path relative to the `prompts/` folder (e.g.
 * "bedrock/supervisor.md"). Cached after first read; CRLF-normalized and
 * trailing-whitespace-trimmed so the string matches the original inline
 * constant byte-for-byte regardless of the checkout's line endings.
 */
export function loadPrompt(relPath: string): string {
  const cached = cache.get(relPath);
  if (cached !== undefined) return cached;

  const tried = isAbsolute(relPath)
    ? [relPath]
    : candidateRoots().map((root) => join(root, relPath));
  const full = tried.find((p) => existsSync(p));
  if (!full) {
    throw new Error(
      `Could not load prompt "${relPath}". Set PROMPTS_DIR or ensure the ` +
        `prompts/ folder ships with this runtime. Tried:\n  ${tried.join('\n  ')}`,
    );
  }
  // CRLF-normalize + trim trailing whitespace so the string matches the original
  // inline constant byte-for-byte regardless of the checkout's line endings.
  const normalized = readFileSync(full, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  cache.set(relPath, normalized);
  return normalized;
}
