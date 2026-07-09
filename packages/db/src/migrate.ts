/**
 * Minimal forward-only migration runner: executes every *.sql file in
 * ./migrations (sorted) that hasn't been applied yet. Tracks state in a
 * `_migrations` table. Run standalone with `npm run db:migrate`, or call
 * `runMigrations()` at service boot (the API does this so deploys self-migrate).
 *
 * NOTE: path resolution is done lazily INSIDE runMigrations. This module is
 * pulled into every bundle that imports `@log/db` (including the esbuilt,
 * CommonJS Lambda bundle where `import.meta.url` is undefined) — doing
 * fileURLToPath at module top-level would crash those bundles at load time even
 * though they never migrate.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSql, closeDb } from './client.js';

// A fixed key so concurrent bootstrappers (e.g. two API tasks) serialize and
// don't race on applying the same migration.
const ADVISORY_LOCK_KEY = 776_2011;

/**
 * Apply pending migrations. Safe to call from multiple processes concurrently
 * (guarded by a Postgres advisory lock) and idempotent (each file runs once).
 * Does NOT close the pool — callers that own the process lifecycle do that.
 */
export async function runMigrations(): Promise<string[]> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const sql = getSql();
  const applied: string[] = [];
  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

    const done = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name),
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const ddl = readFileSync(join(migrationsDir, file), 'utf8');
      console.log(`+ apply migration ${file}`);
      await sql.unsafe(ddl);
      await sql`INSERT INTO _migrations (name) VALUES (${file}) ON CONFLICT DO NOTHING`;
      applied.push(file);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
  return applied;
}

// CLI entry point (`npm run db:migrate` → `tsx src/migrate.ts`): run and close
// the pool. Detected via argv only (no import.meta at module scope) so bundled
// consumers never trip this.
if (/migrate\.(ts|js)$/.test(process.argv[1] ?? '')) {
  runMigrations()
    .then((applied) => {
      console.log(applied.length ? `migrations complete (${applied.join(', ')})` : 'migrations up to date');
      return closeDb();
    })
    .catch(async (err) => {
      console.error(err);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
