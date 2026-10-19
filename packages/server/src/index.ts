// Assemble a server from the environment (or explicit options, in tests).
//
//   LAMPROOM_DATA                 data directory, default ~/.lamproom (holds lamproom.db and the secret)
//   LAMPROOM_DATABASE_URL         postgres://... to use Postgres instead of SQLite
//   LAMPROOM_SECRET               cookie signing and token encryption key; generated into the data dir if unset
//   LAMPROOM_PUBLIC_URL           how the browser reaches the server, default http://localhost:<port>
//   LAMPROOM_GITHUB_CLIENT_ID     GitHub App (or OAuth App) client id; with the secret, enables sign-in
//   LAMPROOM_GITHUB_CLIENT_SECRET
//   LAMPROOM_GITHUB_URL           default https://github.com (a fake in tests)
//   LAMPROOM_GITHUB_API_URL       default https://api.github.com
//   LAMPROOM_DEV_USER             sign every request in as this login, no GitHub needed (development only)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { Auth } from './auth.js';
import { openPostgres, openSqlite, type Db } from './db.js';
import { GitHub, githubFromEnv } from './github.js';
import { createServer } from './api.js';
import { Store } from './store.js';

export * from './api.js';
export * from './auth.js';
export * from './commands.js';
export * from './db.js';
export * from './github.js';
export * from './store.js';

export interface Started {
  server: http.Server;
  store: Store;
  auth: Auth;
  db: Db;
  url: string;
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  uiDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export async function start(opts: StartOptions = {}): Promise<Started> {
  const env = opts.env ?? process.env;
  const port = opts.port ?? Number(env.LAMPROOM_PORT ?? 4411);
  const host = opts.host ?? env.LAMPROOM_HOST ?? '127.0.0.1';
  const dataDir = opts.dataDir ?? env.LAMPROOM_DATA ?? path.join(os.homedir(), '.lamproom');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = env.LAMPROOM_DATABASE_URL ? await openPostgres(env.LAMPROOM_DATABASE_URL) : await openSqlite(path.join(dataDir, 'lamproom.db'));
  const secret = env.LAMPROOM_SECRET ?? loadSecret(path.join(dataDir, 'secret'));
  const gh = githubFromEnv(env);
  const auth = new Auth(db, secret, gh ? new GitHub(gh) : undefined, env.LAMPROOM_DEV_USER || undefined);
  if (!gh && !auth.devUser) {
    throw new Error('no way to sign in: set LAMPROOM_GITHUB_CLIENT_ID and LAMPROOM_GITHUB_CLIENT_SECRET, or LAMPROOM_DEV_USER for development');
  }
  const store = new Store(db);
  const publicUrl = (env.LAMPROOM_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const server = createServer({ store, auth, publicUrl, uiDir: opts.uiDir, log: opts.log });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const url = typeof addr === 'object' && addr ? `http://${host}:${addr.port}` : publicUrl;
  return {
    server,
    store,
    auth,
    db,
    url,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

function loadSecret(file: string): string {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  fs.writeFileSync(file, s + '\n', { mode: 0o600 });
  return s;
}
