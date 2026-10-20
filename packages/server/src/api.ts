// HTTP surface: sign-in, projects, streams, commands, the live feed, and
// the UI bundle. Plain node:http; the routes are a small table.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as core from '@lamproom/core';
import type { Actor } from '@lamproom/core';
import { Auth, actorFor, agentActor, readCookie, type User } from './auth.js';
import { HttpError } from './github.js';
import { runCommand, type CommandRequest } from './commands.js';
import { ConflictError, NotFoundError, type Project, type Store } from './store.js';

export interface ServerOptions {
  store: Store;
  auth: Auth;
  /** Where the browser reaches this server; the GitHub callback is built from it. */
  publicUrl: string;
  /** The built UI, served for every non-API path. */
  uiDir?: string;
  log?: (line: string) => void;
}

type Req = http.IncomingMessage;
type Res = http.ServerResponse;
type Params = Record<string, string>;
type Handler = (ctx: { req: Req; res: Res; url: URL; params: Params; user?: User }) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  auth: boolean;
}

class Router {
  routes: Route[] = [];
  add(method: string, pathPattern: string, handler: Handler, auth = true): void {
    const keys: string[] = [];
    const src = pathPattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k: string) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${src}$`), keys, handler, auth });
  }
  match(method: string, pathname: string): { route: Route; params: Params } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params: Params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { route, params };
    }
    return undefined;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createServer(opts: ServerOptions): http.Server {
  const { store, auth } = opts;
  const r = new Router();
  const secure = opts.publicUrl.startsWith('https://');
  const cookie = (value: string, maxAge: number) =>
    `lr_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  // ---- sign-in -----------------------------------------------------------

  r.add(
    'GET',
    '/auth/github/start',
    ({ res }) => {
      const { url } = auth.startWebFlow(`${opts.publicUrl}/auth/github/callback`);
      res.writeHead(302, { Location: url }).end();
    },
    false,
  );
  r.add(
    'GET',
    '/auth/github/callback',
    async ({ res, url }) => {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) throw new ApiError(400, 'missing code or state');
      const { cookie: value } = await auth.finishWebFlow({ code, state, redirectUri: `${opts.publicUrl}/auth/github/callback` });
      res.writeHead(302, { Location: '/', 'Set-Cookie': cookie(value, 30 * 86400) }).end();
    },
    false,
  );
  r.add(
    'POST',
    '/api/auth/logout',
    async ({ req, res }) => {
      await auth.endSession(readCookie(req.headers.cookie, 'lr_session'));
      res.setHeader('Set-Cookie', cookie('', 0));
      json(res, 200, { ok: true });
    },
    false,
  );
  r.add(
    'POST',
    '/api/auth/device',
    async ({ req, res }) => {
      const body = (await readJson(req)) as { label?: string };
      json(res, 200, await auth.startDeviceFlow(body.label));
    },
    false,
  );
  r.add(
    'POST',
    '/api/auth/device/poll',
    async ({ req, res }) => {
      const body = (await readJson(req)) as { id?: string };
      if (!body.id) throw new ApiError(400, 'missing id');
      json(res, 200, await auth.pollDeviceFlow(body.id));
    },
    false,
  );
  r.add(
    'GET',
    '/api/me',
    ({ res, user }) => {
      if (!user) throw new ApiError(401, 'sign in');
      json(res, 200, { user, actor: actorFor(user), mode: auth.mode, github: !!auth.github });
    },
    false,
  );

  // ---- projects ----------------------------------------------------------

  r.add('GET', '/api/projects', async ({ res, user }) => json(res, 200, await store.listProjects(user!.id)));
  r.add('POST', '/api/projects', async ({ req, res, user }) => {
    const body = (await readJson(req)) as { owner?: string; name?: string };
    const owner = body.owner?.trim();
    const name = body.name?.trim();
    if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) throw new ApiError(400, 'owner and name are required, as on GitHub');
    let repoId: number | undefined;
    if (auth.github) {
      const token = await auth.githubToken(user!.id);
      if (!token) throw new ApiError(403, 'no GitHub token on file; sign in again');
      const repo = await auth.github.repo(token, owner, name);
      if (!repo) throw new ApiError(404, `GitHub says you cannot see ${owner}/${name}`);
      repoId = repo.id;
    }
    const p = await store.createProject({ owner, name, repoId, createdBy: user!.id });
    await store.addMember(p.id, user!.id, 'owner');
    json(res, 201, p);
  });
  r.add('GET', '/api/projects/by-repo/:owner/:name', async ({ res, params, user }) => {
    const p = await store.getProjectByRepo(params.owner!, params.name!);
    if (!p) throw new ApiError(404, `no project for ${params.owner}/${params.name}`);
    await joinIfAllowed(p, user!);
    json(res, 200, p);
  });

  const member = async (id: string, user: User): Promise<Project> => {
    const p = await store.getProject(id);
    if (!p) throw new ApiError(404, 'no such project');
    if (!(await store.isMember(p.id, user.id))) throw new ApiError(403, 'not a member of this project');
    return p;
  };
  /** A signed-in user who can see the repository on GitHub becomes a member on first contact. */
  const joinIfAllowed = async (p: Project, user: User): Promise<void> => {
    if (await store.isMember(p.id, user.id)) return;
    if (auth.github) {
      const token = await auth.githubToken(user.id);
      const repo = token ? await auth.github.repo(token, p.owner, p.name) : undefined;
      if (!repo) throw new ApiError(403, `GitHub says you cannot see ${p.owner}/${p.name}`);
    }
    await store.addMember(p.id, user.id);
  };

  r.add('GET', '/api/projects/:id', async ({ res, params, user }) => {
    const p = await member(params.id!, user!);
    json(res, 200, { project: p, me: actorFor(user!), head: await store.headSeq(p.id) });
  });

  // ---- streams and events ------------------------------------------------

  r.add('GET', '/api/projects/:id/streams', async ({ res, url, params, user }) => {
    const p = await member(params.id!, user!);
    if (url.searchParams.get('states')) {
      const all = await store.allStates(p.id);
      json(res, 200, { head: await store.headSeq(p.id), streams: all.map((x) => ({ ...x.summary, state: x.state })) });
    } else {
      json(res, 200, { head: await store.headSeq(p.id), streams: await store.streams(p.id) });
    }
  });
  r.add('GET', '/api/projects/:id/streams/:stream/events', async ({ res, params, user }) => {
    const p = await member(params.id!, user!);
    json(res, 200, await store.streamEvents(p.id, params.stream!));
  });
  r.add('GET', '/api/projects/:id/export', async ({ res, params, user }) => {
    const p = await member(params.id!, user!);
    const events = await store.allEvents(p.id);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${p.owner}-${p.name}.jsonl"` });
    res.end(events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  });
  r.add('POST', '/api/projects/:id/import', async ({ req, res, params, user }) => {
    const p = await member(params.id!, user!);
    const text = await readBody(req);
    let raw: unknown[];
    try {
      raw = text.trimStart().startsWith('[') ? (JSON.parse(text) as unknown[]) : text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
    } catch (e) {
      throw new ApiError(400, `not JSON lines: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!raw.length) throw new ApiError(400, 'no events in the body');
    json(res, 200, await store.importEvents(p.id, raw));
  });
  r.add('GET', '/api/projects/:id/status', async ({ res, url, params, user }) => {
    const p = await member(params.id!, user!);
    const me = who(user!, url.searchParams.get('agent') ?? undefined).actor;
    const state = core.unionState((await store.allStates(p.id)).map((x) => x.state));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(core.renderStatus(state, me));
  });
  r.add('GET', '/api/projects/:id/events', async ({ req, res, url, params, user }) => {
    const p = await member(params.id!, user!);
    const sinceRaw = req.headers['last-event-id'] ?? url.searchParams.get('since');
    const since = Number(Array.isArray(sinceRaw) ? sinceRaw[0] : (sinceRaw ?? NaN));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event: string, id: number | undefined, data: unknown) => {
      res.write(`event: ${event}\n${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    };
    const head = await store.headSeq(p.id);
    send('hello', undefined, { head, since: Number.isFinite(since) ? since : null });
    let last = Number.isFinite(since) ? since : head;
    if (Number.isFinite(since) && since < head) {
      const missed = await store.eventsSince(p.id, since);
      if (missed.length) {
        last = missed[missed.length - 1]!.seq!;
        send('append', last, { events: missed });
      }
    }
    const unsub = store.subscribe(p.id, (a) => {
      const fresh = a.events.filter((e) => e.seq! > last);
      if (!fresh.length) return;
      last = fresh[fresh.length - 1]!.seq!;
      send('append', last, { events: fresh, stream: a.summary });
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  });

  // ---- files -------------------------------------------------------------

  // Uploads for comment attachments. The body is the file itself; the name
  // rides in the query string. The answer is the attachment to put on a comment.
  r.add('POST', '/api/projects/:id/files', async ({ req, res, url, params, user }) => {
    const p = await member(params.id!, user!);
    const name = url.searchParams.get('name')?.trim().slice(0, 200);
    if (!name) throw new ApiError(400, 'missing name');
    const data = await readBytes(req, MAX_FILE);
    if (!data.byteLength) throw new ApiError(400, 'empty file');
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim() || 'application/octet-stream';
    const id = core.newFileId();
    await store.saveFile(p.id, { id, name, type, data, createdBy: user!.id });
    json(res, 201, { ref: `/api/projects/${p.id}/files/${id}`, title: name, type, size: data.byteLength } satisfies core.Attachment);
  });
  r.add('GET', '/api/projects/:id/files/:file', async ({ res, params, user }) => {
    const p = await member(params.id!, user!);
    const f = await store.getFile(p.id, params.file!);
    if (!f) throw new ApiError(404, 'no such file');
    // Only images open in the page; anything else downloads, so an uploaded
    // page can never run as this origin.
    const inline = /^image\/(png|jpeg|gif|webp)$/.test(f.type);
    res.writeHead(200, {
      'Content-Type': inline ? f.type : 'application/octet-stream',
      'Content-Length': f.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.end(f.data);
  });

  // ---- commands ----------------------------------------------------------

  r.add('POST', '/api/projects/:id/commands', async ({ req, res, params, user }) => {
    const p = await member(params.id!, user!);
    const body = (await readJson(req)) as CommandRequest & { agent?: string; onBehalfOf?: boolean };
    if (!body.command) throw new ApiError(400, 'missing command');
    const w = who(user!, body.agent, body.onBehalfOf);
    json(res, 200, await runCommand(store, p, w, { command: body.command, args: body.args ?? {}, expectedRev: body.expectedRev, idempotencyKey: body.idempotencyKey }));
  });

  // ---- server ------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', opts.publicUrl);
    try {
      const m = r.match(req.method ?? 'GET', url.pathname);
      if (m) {
        const user = await auth.authenticate({ authorization: req.headers.authorization, cookie: req.headers.cookie });
        if (m.route.auth && !user) throw new ApiError(401, 'sign in');
        await m.route.handler({ req, res, url, params: m.params, user });
        return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) throw new ApiError(404, 'not found');
      serveStatic(opts.uiDir, url.pathname, res);
    } catch (e) {
      const status =
        e instanceof ApiError ? e.status
        : e instanceof core.CommandError ? 400
        : e instanceof ConflictError ? 409
        : e instanceof NotFoundError ? 404
        : e instanceof HttpError ? 502
        : 500;
      const msg = e instanceof Error ? e.message : String(e);
      if (status === 500) opts.log?.(`error ${req.method} ${url.pathname}: ${e instanceof Error ? (e.stack ?? msg) : msg}`);
      if (!res.headersSent) json(res, status, { error: msg });
      else res.end();
    }
  });
  return server;
}

/** The actor a request acts as: the user, or an agent they run, optionally relaying their decision. */
function who(user: User, agent?: string, onBehalfOf?: boolean): { actor: Actor; onBehalfOf?: Actor } {
  if (!agent) return { actor: actorFor(user) };
  if (!/^[\w.-]{1,40}$/.test(agent)) throw new ApiError(400, 'agent label must be a short word');
  return { actor: agentActor(user, agent), onBehalfOf: onBehalfOf ? actorFor(user) : undefined };
}

function json(res: Res, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const MAX_FILE = 10 * 1024 * 1024;

function readBytes(req: Req, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Past the limit the rest is drained and dropped, so the 413 still reaches the client.
      if (size > max) return reject(new ApiError(413, `files are limited to ${max / 1024 / 1024} MB`));
      chunks.push(c);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function readBody(req: Req): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJson(req: Req): Promise<unknown> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'body is not JSON');
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function serveStatic(dir: string | undefined, pathname: string, res: Res): void {
  if (!dir) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<p>Lamproom API is running, but the UI bundle was not found. Build it with <code>pnpm --filter @lamproom/ui build</code>.</p>');
    return;
  }
  let file = path.join(dir, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(dir)) return void res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}
