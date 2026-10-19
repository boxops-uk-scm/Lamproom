// The one place SQL dialects differ. SQLite (built into Node) for
// development and single-box use; the same schema and statements run on
// Postgres through the second adapter, with `?` placeholders rewritten to
// `$n`, BIGSERIAL for the global sequence, and JSONB for bodies.
//
// Everything is async so the Postgres adapter is a drop-in; the SQLite
// adapter is synchronous underneath. The store serialises writes per
// project with a mutex, so a transaction never interleaves with another.

export type Dialect = 'sqlite' | 'postgres';
export type Param = string | number | bigint | null;
export type Row = Record<string, unknown>;

export interface Db {
  readonly dialect: Dialect;
  exec(sql: string): Promise<void>;
  run(sql: string, params?: Param[]): Promise<{ changes: number; lastId?: number }>;
  get<T extends Row = Row>(sql: string, params?: Param[]): Promise<T | undefined>;
  all<T extends Row = Row>(sql: string, params?: Param[]): Promise<T[]>;
  /** Run fn inside a transaction; the caller guarantees no concurrent writer on this connection. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---- schema -------------------------------------------------------------

/** Statements in SQLite syntax; `pg()` rewrites the few differences. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     login TEXT NOT NULL,
     name TEXT,
     avatar TEXT,
     token_enc TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
     hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     label TEXT,
     created_at TEXT NOT NULL,
     last_used_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS device_grants (
     id TEXT PRIMARY KEY,
     github_device_code TEXT NOT NULL,
     label TEXT,
     created_at TEXT NOT NULL,
     token TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     name TEXT NOT NULL,
     repo_id INTEGER,
     policy TEXT NOT NULL,
     created_by TEXT,
     created_at TEXT NOT NULL,
     UNIQUE(owner, name)
   )`,
  `CREATE TABLE IF NOT EXISTS members (
     project_id TEXT NOT NULL REFERENCES projects(id),
     user_id TEXT NOT NULL REFERENCES users(id),
     role TEXT NOT NULL,
     PRIMARY KEY (project_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS streams (
     project_id TEXT NOT NULL REFERENCES projects(id),
     id TEXT NOT NULL,
     rev INTEGER NOT NULL,
     head_seq INTEGER NOT NULL,
     created_seq INTEGER NOT NULL,
     projection INTEGER NOT NULL,
     snapshot TEXT NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     done INTEGER NOT NULL,
     total INTEGER NOT NULL,
     human_queue INTEGER NOT NULL,
     PRIMARY KEY (project_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT NOT NULL REFERENCES projects(id),
     stream TEXT NOT NULL,
     rev INTEGER NOT NULL,
     id TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL,
     ts TEXT NOT NULL,
     body TEXT NOT NULL,
     UNIQUE (project_id, stream, rev)
   )`,
  `CREATE INDEX IF NOT EXISTS events_project_seq ON events (project_id, seq)`,
  `CREATE TABLE IF NOT EXISTS entities (
     project_id TEXT NOT NULL REFERENCES projects(id),
     id TEXT NOT NULL,
     stream TEXT NOT NULL,
     PRIMARY KEY (project_id, id)
   )`,
  `CREATE TABLE IF NOT EXISTS idempotency (
     project_id TEXT NOT NULL,
     key TEXT NOT NULL,
     response TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, key)
   )`,
];

export const SCHEMA_VERSION = 1;

function pg(sql: string): string {
  let n = 0;
  return sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY')
    .replace(/\?/g, () => `$${++n}`);
}

export async function migrate(db: Db): Promise<void> {
  for (const stmt of SCHEMA) await db.exec(db.dialect === 'postgres' ? pg(stmt) : stmt);
  await db.run(`INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
    String(SCHEMA_VERSION),
  ]);
}

// ---- SQLite -------------------------------------------------------------

export async function openSqlite(file: string): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  const num = (v: number | bigint) => Number(v);
  const db: Db = {
    dialect: 'sqlite',
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql, params = []) {
      const r = raw.prepare(sql).run(...params);
      return { changes: num(r.changes), lastId: num(r.lastInsertRowid) };
    },
    async get<T extends Row>(sql: string, params: Param[] = []) {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    async all<T extends Row>(sql: string, params: Param[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const r = await fn();
        raw.exec('COMMIT');
        return r;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    async close() {
      raw.close();
    },
  };
  await migrate(db);
  return db;
}

// ---- Postgres -----------------------------------------------------------

/**
 * Postgres adapter over the `pg` package, loaded on demand so SQLite users
 * never install it. Appends take a per-project advisory lock in the store
 * so the global seq is assigned in commit order. Not exercised by this
 * repository's tests yet.
 */
export async function openPostgres(connectionString: string): Promise<Db> {
  const mod = (await import(/* @vite-ignore */ 'pg' as string)) as { default?: { Client: new (o: { connectionString: string }) => PgClient }; Client?: new (o: { connectionString: string }) => PgClient };
  const Client = mod.Client ?? mod.default?.Client;
  if (!Client) throw new Error('pg package not found; install it to use LAMPROOM_DATABASE_URL');
  const client = new Client({ connectionString });
  await client.connect();
  const db: Db = {
    dialect: 'postgres',
    async exec(sql) {
      await client.query(sql);
    },
    async run(sql, params = []) {
      const r = await client.query(pg(sql) + (/^\s*INSERT/i.test(sql) && !/RETURNING/i.test(sql) ? ' RETURNING *' : ''), params);
      const first = r.rows[0] as Row | undefined;
      return { changes: r.rowCount ?? 0, lastId: first && typeof first.seq === 'string' ? Number(first.seq) : undefined };
    },
    async get<T extends Row>(sql: string, params: Param[] = []) {
      const r = await client.query(pg(sql), params);
      return r.rows[0] as T | undefined;
    },
    async all<T extends Row>(sql: string, params: Param[] = []) {
      const r = await client.query(pg(sql), params);
      return r.rows as T[];
    },
    async tx(fn) {
      await client.query('BEGIN');
      try {
        const r = await fn();
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    },
    async close() {
      await client.end();
    },
  };
  await migrate(db);
  return db;
}

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}
