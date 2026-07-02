import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export type Sql = ReturnType<typeof postgres>;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

let _sql: Sql | undefined;
let _db: Db | undefined;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

/** Lazily-initialised singleton postgres.js client + drizzle instance. */
export function getSql(): Sql {
  if (!_sql) {
    const url = connectionString();
    // RDS enforces TLS (rds.force_ssl); local docker Postgres does not support
    // it. Enable SSL for any non-local host. rejectUnauthorized:false avoids
    // bundling the RDS CA bundle (traffic is still encrypted).
    const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
    _sql = postgres(url, {
      max: 10,
      prepare: false,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    });
  }
  return _sql;
}

export function getDb(): Db {
  if (!_db) _db = drizzle(getSql(), { schema });
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = undefined;
    _db = undefined;
  }
}

export { schema };
