#!/usr/bin/env node
// lamproom CLI. `serve` runs the server; everything else talks to one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@lamproom/core';
import { Store } from '@lamproom/core/node';
import { Client, ClientError, configPath, login, logout, parseRepo, repoOf, resolveProject, resolveServer, tokenFor } from '@lamproom/client';

// node:sqlite still prints an experimental warning on Node 22; it is the one we use on purpose.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
  if (typeof w === 'string' && w.includes('SQLite')) return;
  (emitWarning as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';

function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function positional(): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) {
      if (!['no-ui'].includes(argv[i]!.slice(2))) i++;
      continue;
    }
    out.push(argv[i]!);
  }
  return out;
}
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const server = resolveServer(opt('server'));
// Without a token the server answers 401 unless it runs in dev mode, and the client says to log in.
const client = () => new Client(server, tokenFor(server));
const projectOf = async (c: Client) => resolveProject(c, opt('dir') ?? process.cwd(), opt('project'));

try {
  switch (cmd) {
    case 'serve': {
      const { start } = await import('@lamproom/server');
      const here = path.dirname(fileURLToPath(import.meta.url));
      const uiDir = opt('ui') ?? [path.resolve(here, '../../ui/dist'), path.resolve(here, '../ui')].find((p) => fs.existsSync(path.join(p, 'index.html')));
      const s = await start({
        port: opt('port') ? Number(opt('port')) : undefined,
        host: opt('host'),
        dataDir: opt('data'),
        uiDir,
        log: (l) => console.error(l),
      });
      console.log(`lamproom server  ${s.url}`);
      console.log(`data             ${opt('data') ?? process.env.LAMPROOM_DATA ?? '~/.lamproom'}`);
      console.log(`sign-in          ${s.auth.mode === 'dev' ? `dev user "${s.auth.devUser}" (LAMPROOM_DEV_USER)` : 'GitHub'}`);
      if (!uiDir) console.log('ui bundle not found; run "pnpm --filter @lamproom/ui build" or pass --ui <dir>');
      break;
    }
    case 'login': {
      const user = await login(server, opt('label') ?? `cli@${process.env.HOSTNAME ?? 'local'}`, ({ userCode, verificationUri }) => {
        console.log(`Open ${verificationUri} and enter the code ${userCode}`);
      });
      console.log(`signed in to ${server} as ${user.login}; token kept in ${configPath()}`);
      break;
    }
    case 'logout':
      logout(server);
      console.log(`signed out of ${server}`);
      break;
    case 'whoami': {
      const me = await client().me();
      console.log(`${me.user.login} (${me.actor.id}) on ${server}${me.mode === 'dev' ? ' [dev mode]' : ''}`);
      break;
    }
    case 'init': {
      const c = client();
      const spec = positional()[0];
      const repo = spec ? parseRepo(spec) : await repoOf(opt('dir') ?? process.cwd());
      if (!repo) die('usage: lamproom init [owner/name]   (defaults to the GitHub remote of this directory)');
      const p = await c.createProject(repo!.owner, repo!.name);
      console.log(`project ${p.owner}/${p.name} registered on ${server} (${p.id})`);
      break;
    }
    case 'projects': {
      for (const p of await client().projects()) console.log(`${p.owner}/${p.name}  ${p.id}`);
      break;
    }
    case 'status': {
      const c = client();
      const p = await projectOf(c);
      console.log(await c.status(p.id));
      break;
    }
    case 'answer': {
      const [questionId, ...rest] = positional();
      if (!questionId || !rest.length) die('usage: lamproom answer <questionId> <text...>   (Markdown)');
      const c = client();
      const p = await projectOf(c);
      await c.command(p.id, { command: 'answer', args: { questionId, text: rest.join(' ') } });
      console.log(`answered ${questionId}`);
      break;
    }
    case 'review': {
      const [artefactId, verdict, ...notes] = positional();
      if (!artefactId || (verdict !== 'accept' && verdict !== 'reject')) {
        die('usage: lamproom review <artefactId> accept|reject [notes...]   (Markdown, one per argument)');
      }
      const c = client();
      const p = await projectOf(c);
      await c.command(p.id, { command: 'review', args: { artefactId, verdict, notes: notes.length ? notes : undefined } });
      console.log(`${verdict}ed ${artefactId}`);
      break;
    }
    case 'comment': {
      const [targetId, ...rest] = positional();
      // --attach may repeat: each value is a local file, uploaded first.
      const paths = argv.flatMap((a, i) => (a === '--attach' && argv[i + 1] ? [argv[i + 1]!] : []));
      if (!targetId || (!rest.length && !paths.length)) {
        die('usage: lamproom comment <actionId|artefactId> <text...> [--attach <file>]... [--reply <commentId>]   (Markdown)');
      }
      for (const f of paths) if (!fs.existsSync(f)) die(`no such file ${f}`);
      const c = client();
      const p = await projectOf(c);
      const attachments = [];
      for (const f of paths) attachments.push(await c.uploadFile(p.id, f));
      const r = await c.command(p.id, {
        command: 'comment',
        args: { targetId, body: rest.join(' '), attachments: attachments.length ? attachments : undefined, replyTo: opt('reply') },
      });
      console.log(`commented on ${targetId} (${String(r.commentId)})`);
      break;
    }
    case 'restore':
    case 'reopen': {
      const [actionId, ...note] = positional();
      if (!actionId) die(`usage: lamproom ${cmd} <actionId> [note...]   (Markdown)`);
      const c = client();
      const p = await projectOf(c);
      await c.command(p.id, { command: cmd, args: { actionId, note: note.length ? note.join(' ') : undefined } });
      console.log(`${cmd === 'restore' ? 'restored' : 'reopened'} ${actionId}`);
      break;
    }
    case 'import': {
      const [file] = positional();
      if (!file) die('usage: lamproom import <events.jsonl>');
      const c = client();
      const p = await projectOf(c);
      const r = await c.importEvents(p.id, fs.readFileSync(file!, 'utf8'));
      console.log(`imported ${r.imported} events into ${r.streams} stream(s), one per seam, of ${p.owner}/${p.name}`);
      break;
    }
    case 'export': {
      const c = client();
      const p = await projectOf(c);
      process.stdout.write(await c.exportEvents(p.id));
      break;
    }
    case 'replay': {
      // Offline: project the first n events of a file log, the way the tests do.
      const [file, n] = positional();
      if (!file) die('usage: lamproom replay <events.jsonl> [n]');
      const events = new Store(path.dirname(path.resolve(file!))).readEventsFrom(path.resolve(file!)).slice(0, Number(n ?? Infinity));
      console.log(core.renderStatus(core.project(events)));
      break;
    }
    default:
      console.log(`lamproom <command>

  serve [--port 4411] [--data ~/.lamproom] [--ui dir]   run the server and UI
  login [--server url] [--label name]   sign in from this terminal (GitHub device flow)
  logout                                forget this terminal's token
  whoami                                who the token belongs to
  init [owner/name]                     register this repository as a project
  projects                              list your projects
  status                                print the coal face of this project
  answer <questionId> <text...>         answer a question as yourself (Markdown)
  review <artefactId> accept|reject [notes...]   notes are Markdown, one per argument
  comment <id> <text...> [--attach file]... [--reply commentId]   comment on an action or artefact
  restore <actionId> [note]             undo an abandonment
  reopen <actionId> [note]              undo a completion; outputs keep their versions
  import <events.jsonl>                 load a file log into this project's streams
  export                                write this project's log as JSON lines
  replay <events.jsonl> [n]             project the first n events of a file, offline

Options: --server <url> (default ${server}), --project owner/name, --dir <path> to pick the repository.
Server env: LAMPROOM_GITHUB_CLIENT_ID / _SECRET for GitHub sign-in, or LAMPROOM_DEV_USER=<login> for development.`);
  }
} catch (e) {
  if (e instanceof ClientError) die(e.message);
  throw e;
}
