#!/usr/bin/env node
// coalface CLI: init, status, serve (UI + API), answer, review, replay.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@coalface/core';
import { Store, humanActor } from '@coalface/core/node';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function positional(): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) {
      i++;
      continue;
    }
    out.push(argv[i]!);
  }
  return out;
}

const store = Store.resolve(opt('dir') ?? process.cwd());
const human = humanActor();

switch (cmd) {
  case 'init':
    store.init();
    console.log(`initialised ${store.dir}`);
    break;
  case 'status':
    console.log(core.renderStatus(store.state()));
    break;
  case 'reset': {
    // Blank slate: keep the policy, move the log aside with a timestamp.
    if (!store.exists()) {
      store.init();
      console.log(`initialised ${store.dir}`);
      break;
    }
    const n = store.readEvents().length;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = store.eventsPath.replace(/\.jsonl$/, `-${stamp}.jsonl.bak`);
    fs.renameSync(store.eventsPath, backup);
    fs.writeFileSync(store.eventsPath, '');
    console.log(`reset ${store.dir}: ${n} events moved to ${path.basename(backup)}`);
    break;
  }
  case 'replay': {
    const n = Number(positional()[0] ?? Infinity);
    const events = store.readEvents().slice(0, n);
    console.log(core.renderStatus(core.project(events)));
    break;
  }
  case 'answer': {
    const [questionId, ...rest] = positional();
    if (!questionId || !rest.length) die('usage: coalface answer <questionId> <text...>   (Markdown)');
    store.run(human, 'owned', (ctx) => core.answer(ctx, { questionId: questionId!, text: rest.join(' ') }));
    console.log(`answered ${questionId} as ${human.id}`);
    break;
  }
  case 'review': {
    const [artefactId, verdict, ...notes] = positional();
    if (!artefactId || (verdict !== 'accept' && verdict !== 'reject')) {
      die('usage: coalface review <artefactId> accept|reject [notes...]   (Markdown, one per argument)');
    }
    store.run(human, 'owned', (ctx) =>
      core.review(ctx, { artefactId: artefactId!, verdict: verdict as 'accept' | 'reject', notes: notes.length ? notes : undefined }),
    );
    console.log(`${verdict}ed ${artefactId} as ${human.id}`);
    break;
  }
  case 'restore':
  case 'reopen': {
    const [actionId, ...note] = positional();
    if (!actionId) die(`usage: coalface ${cmd} <actionId> [note...]   (Markdown)`);
    const input = { actionId: actionId!, note: note.length ? note.join(' ') : undefined };
    store.run(human, 'owned', (ctx) => (cmd === 'restore' ? core.restore(ctx, input) : core.reopen(ctx, input)));
    console.log(`${cmd === 'restore' ? 'restored' : 'reopened'} ${actionId} as ${human.id}`);
    break;
  }
  case 'serve':
    serve(Number(opt('port') ?? 4411), opt('ui'));
    break;
  default:
    console.log(`coalface <command>

  init                      create .coalface in this project
  status                    print the coal face
  reset                     blank slate: back up the log and empty it
  serve [--port 4411]       serve the live graph UI and API
  answer <questionId> ...   answer a question as yourself (Markdown)
  review <artefactId> accept|reject [notes]   notes are Markdown, one per argument
  restore <actionId> [note]  undo an abandonment
  reopen <actionId> [note]   undo a completion; outputs keep their versions
  replay [n]                project the first n events

Options: --dir <path> to pick the project; COALFACE_HUMAN to set your name.`);
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---- server -------------------------------------------------------------

type Client = { res: http.ServerResponse; sent: number };

function serve(port: number, uiDir?: string): void {
  if (!store.exists()) store.init();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const staticDir = uiDir ?? firstExisting([
    path.resolve(here, '../../ui/dist'),
    path.resolve(here, '../ui'),
  ]);
  const clients = new Set<Client>();

  const broadcast = () => {
    const events = store.readEvents();
    for (const c of clients) {
      if (events.length < c.sent) {
        send(c.res, 'snapshot', events);
        c.sent = events.length;
      } else if (events.length > c.sent) {
        send(c.res, 'append', events.slice(c.sent));
        c.sent = events.length;
      }
    }
  };
  store.watch(broadcast);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      if (url.pathname === '/api/events') {
        return json(res, 200, store.readEvents());
      }
      if (url.pathname === '/api/meta') {
        return json(res, 200, { dir: store.dir, human, policy: store.policy() });
      }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const events = store.readEvents();
        send(res, 'snapshot', events);
        const client: Client = { res, sent: events.length };
        clients.add(client);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(client);
        });
        return;
      }
      if (url.pathname === '/api/command' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { command: string; args: Record<string, unknown> };
        const result = runCommand(body.command, body.args ?? {});
        return json(res, 200, result);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      return serveStatic(staticDir, url.pathname, res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json(res, e instanceof core.CommandError ? 400 : 500, { error: msg });
    }
  });

  server.listen(port, () => {
    console.log(`coalface ui  http://localhost:${port}`);
    console.log(`log          ${store.eventsPath}`);
    console.log(`you are      ${human.id}`);
    if (!staticDir) console.log('ui bundle not found; run "pnpm --filter @coalface/ui build" or use --ui <dir>');
  });
}

function runCommand(command: string, args: Record<string, unknown>): unknown {
  const run = <T extends core.Result>(fn: (ctx: core.Ctx) => T) => {
    const r = store.run(human, 'owned', fn);
    return { ok: true, warnings: r.warnings, ...stripEvents(r) };
  };
  switch (command) {
    case 'propose':
      return run((ctx) => core.proposeActions(ctx, args as unknown as core.ProposeInput));
    case 'claim':
      return run((ctx) => core.claim(ctx, args as { actionId: string }));
    case 'release':
      return run((ctx) => core.release(ctx, args as { actionId: string; reason?: string }));
    case 'complete':
      return run((ctx) => core.complete(ctx, args as { actionId: string; note?: string }));
    case 'abandon':
      return run((ctx) => core.abandon(ctx, args as { actionId: string; reason?: string }));
    case 'restore':
      return run((ctx) => core.restore(ctx, args as { actionId: string; note?: string }));
    case 'reopen':
      return run((ctx) => core.reopen(ctx, args as { actionId: string; note?: string }));
    case 'attach':
      return run((ctx) => core.attachVersion(ctx, args as { artefactId: string; ref: string; note?: string }));
    case 'answer':
      return run((ctx) => core.answer(ctx, args as { questionId: string; text: string }));
    case 'review':
      return run((ctx) => core.review(ctx, args as { artefactId: string; verdict: 'accept' | 'reject'; notes?: string[] }));
    case 'progress':
      return run((ctx) => core.progress(ctx, args as { actionId: string; note: string }));
    default:
      throw new core.CommandError(`unknown command ${command}`);
  }
}

function stripEvents<T extends core.Result>(r: T): Omit<T, 'events' | 'warnings'> {
  const { events: _e, warnings: _w, ...rest } = r;
  return rest;
}

function send(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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

function serveStatic(dir: string | undefined, pathname: string, res: http.ServerResponse): void {
  if (!dir) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<p>Coalface API is running, but the UI bundle was not found. Build it with <code>pnpm --filter @coalface/ui build</code>.</p>');
    return;
  }
  let file = path.join(dir, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(dir)) return void res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => fs.existsSync(path.join(p, 'index.html')));
}
