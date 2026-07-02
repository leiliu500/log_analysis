/**
 * Minimal forward-only migration runner: executes every *.sql file in
 * ./migrations (sorted) that hasn't been applied yet. Tracks state in a
 * `_migrations` table. Run with: npm run db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSql, closeDb } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

async function main(): Promise<void> {
  const sql = getSql();
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= skip ${file}`);
      continue;
    }
    const ddl = readFileSync(join(migrationsDir, file), 'utf8');
    console.log(`+ apply ${file}`);
    await sql.unsafe(ddl);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
  }

  console.log('migrations complete');
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
