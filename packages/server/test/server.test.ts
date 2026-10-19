import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, type Started } from '../src/index.js';
import { startFakeGitHub, type FakeGitHub } from './fake-github.js';
import { project, unionState, workflows, type Event, type State } from '@coalface/core';

let gh: FakeGitHub;
let srv: Started;
let dataDir: string;

beforeAll(async () => {
  gh = await startFakeGitHub();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coalface-test-'));
  srv = await start({
    port: 0,
    dataDir,
    env: {
      COALFACE_GITHUB_CLIENT_ID: 'id',
      COALFACE_GITHUB_CLIENT_SECRET: 'secret',
      COALFACE_GITHUB_URL: gh.url,
      COALFACE_GITHUB_API_URL: gh.url,
      COALFACE_SECRET: 'test-secret',
    },
    log: () => undefined,
  });
});
afterAll(async () => {
  await srv.close();
  await gh.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Follow the web flow by hand: start -> fake GitHub -> callback -> cookie. */
async function signInWeb(login = 'tom'): Promise<string> {
  const start = await fetch(`${srv.url}/auth/github/start`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const ghUrl = new URL(start.headers.get('location')!);
  expect(ghUrl.searchParams.get('code_challenge_method')).toBe('S256');
  ghUrl.searchParams.set('login', login);
  const approved = await fetch(ghUrl, { redirect: 'manual' });
  const back = new URL(approved.headers.get('location')!);
  // The callback is built from the public URL; point it at the test port.
  back.host = new URL(srv.url).host;
  const cb = await fetch(back, { redirect: 'manual' });
  expect(cb.status).toBe(302);
  const cookie = cb.headers.get('set-cookie')!.split(';')[0]!;
  return cookie;
}

async function signInDevice(login = 'tom'): Promise<string> {
  const d = (await (await fetch(`${srv.url}/api/auth/device`, { method: 'POST', body: JSON.stringify({ label: 'cli' }) })).json()) as {
    id: string;
    userCode: string;
  };
  const pending = (await (await fetch(`${srv.url}/api/auth/device/poll`, { method: 'POST', body: JSON.stringify({ id: d.id }) })).json()) as { status: string };
  expect(pending.status).toBe('pending');
  gh.approveDevice(d.userCode, login);
  const ok = (await (await fetch(`${srv.url}/api/auth/device/poll`, { method: 'POST', body: JSON.stringify({ id: d.id }) })).json()) as {
    status: string;
    token: string;
  };
  expect(ok.status).toBe('ok');
  return ok.token;
}

function api(headers: Record<string, string>) {
  return async <T = unknown>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await fetch(`${srv.url}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // text response
    }
    return { status: r.status, body: parsed as T };
  };
}

describe('sign-in', () => {
  it('refuses anonymous API calls', async () => {
    const r = await fetch(`${srv.url}/api/projects`);
    expect(r.status).toBe(401);
  });
  it('web flow with PKCE sets a session cookie', async () => {
    const cookie = await signInWeb('tom');
    const me = await api({ cookie })<{ user: { login: string }; actor: { id: string } }>('GET', '/api/me');
    expect(me.body.user.login).toBe('tom');
    expect(me.body.actor.id).toBe('github:1001');
  });
  it('device flow mints an API token', async () => {
    const token = await signInDevice('ada');
    const me = await api({ authorization: `Bearer ${token}` })<{ user: { login: string } }>('GET', '/api/me');
    expect(me.body.user.login).toBe('ada');
  });
  it('a forged cookie is ignored', async () => {
    const r = await fetch(`${srv.url}/api/me`, { headers: { cookie: 'cf_session=abc.def' } });
    expect(r.status).toBe(401);
  });
});

describe('projects', () => {
  it('registers a repository the user can see and refuses one they cannot', async () => {
    const tom = api({ cookie: await signInWeb('tom') });
    const made = await tom<{ id: string; repoId: number }>('POST', '/api/projects', { owner: 'boxops', name: 'coalface' });
    expect(made.status).toBe(201);
    expect(made.body.repoId).toBe(500);
    const no = await tom('POST', '/api/projects', { owner: 'boxops', name: 'secret' });
    expect(no.status).toBe(404);
    const list = await tom<{ name: string }[]>('GET', '/api/projects');
    expect(list.body.map((p) => p.name)).toContain('coalface');
  });
  it('a second user joins by repo when GitHub lets them see it', async () => {
    const ada = api({ authorization: `Bearer ${await signInDevice('ada')}` });
    const p = await ada<{ id: string }>('GET', '/api/projects/by-repo/boxops/coalface');
    expect(p.status).toBe(200);
    const www = await api({ cookie: await signInWeb('tom') })('POST', '/api/projects', { owner: 'boxops', name: 'www' });
    expect(www.status).toBe(201);
    const denied = await ada('GET', '/api/projects/by-repo/boxops/www');
    expect(denied.status).toBe(403);
  });
});

describe('streams', () => {
  let tom: ReturnType<typeof api>;
  let pid: string;
  beforeAll(async () => {
    tom = api({ cookie: await signInWeb('tom') });
    pid = (await tom<{ id: string }>('GET', '/api/projects/by-repo/boxops/coalface')).body.id;
  });
  const cmd = <T = Record<string, unknown>>(body: Record<string, unknown>) => tom<T & { ok: boolean; stream: string; rev: number; error?: string }>('POST', `/api/projects/${pid}/commands`, body);

  it('each goal gets its own stream; children and policy steps join it', async () => {
    const a = await cmd<{ actions: { id: string; outputs: string[] }[] }>({
      command: 'propose',
      agent: 'ab12c',
      args: { actions: [{ title: 'Goal A', size: 'L', outputs: [{ kind: 'pull-request', title: 'A PR' }] }] },
    });
    expect(a.status).toBe(200);
    const goalA = a.body.actions[0]!;
    expect(a.body.stream).toBe(goalA.id);
    expect(a.body.rev).toBe(4); // terminal and naked PR declared, review action, the goal
    const b = await cmd<{ actions: { id: string }[] }>({ command: 'propose', args: { actions: [{ title: 'Goal B', size: 'M', outputs: [{ kind: 'document', title: 'B doc' }] }] } });
    expect(b.body.stream).not.toBe(a.body.stream);
    const kids = await cmd<{ actions: { id: string }[] }>({
      command: 'propose',
      agent: 'ab12c',
      args: { parent: goalA.id, actions: [{ title: 'A1', size: 'S', outputs: [goalA.outputs[0]] }] },
    });
    expect(kids.body.stream).toBe(goalA.id);
    const streams = await tom<{ streams: { id: string; title: string; total: number }[] }>('GET', `/api/projects/${pid}/streams`);
    expect(streams.body.streams.map((s) => s.title).sort()).toEqual(['Goal A', 'Goal B']);
    expect(streams.body.streams.find((s) => s.id === goalA.id)!.total).toBe(3); // goal, review, child
  });

  it('refuses an edge between workflows', async () => {
    const list = (await tom<{ streams: { id: string; state: State }[] }>('GET', `/api/projects/${pid}/streams?states=1`)).body.streams;
    const docB = Object.values(list.find((s) => s.state.actions[s.id]?.title === 'Goal B')!.state.artefacts)[0]!.id;
    const goalA = list.find((s) => s.state.actions[s.id]?.title === 'Goal A')!.id;
    const r = await cmd({ command: 'propose', args: { parent: goalA, actions: [{ title: 'bridge', inputs: [docB] }] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/workflows/);
  });

  it('expected revisions conflict and idempotency keys replay', async () => {
    const list = (await tom<{ streams: { id: string; rev: number; title: string }[] }>('GET', `/api/projects/${pid}/streams`)).body.streams;
    const b = list.find((s) => s.title === 'Goal B')!;
    const stale = await cmd({ command: 'claim', args: { actionId: b.id }, expectedRev: b.rev - 1 });
    expect(stale.status).toBe(409);
    const fresh = await cmd({ command: 'claim', args: { actionId: b.id }, expectedRev: b.rev, idempotencyKey: 'k1' });
    expect(fresh.status).toBe(200);
    expect(fresh.body.rev).toBe(b.rev + 1);
    const again = await cmd({ command: 'claim', args: { actionId: b.id }, expectedRev: b.rev, idempotencyKey: 'k1' });
    expect(again.status).toBe(200);
    expect(again.body.rev).toBe(b.rev + 1);
  });

  it('a follow-up joins a finished workflow and the live feed catches up by seq', async () => {
    const list = (await tom<{ streams: { id: string; state: State; headSeq: number }[] }>('GET', `/api/projects/${pid}/streams?states=1`)).body.streams;
    const b = list.find((s) => s.state.actions[s.id]?.title === 'Goal B')!;
    const doc = b.state.actions[b.id]!.outputs[0]!;
    await cmd({ command: 'attach', args: { artefactId: doc, ref: 'mock:b' } });
    await cmd({ command: 'complete', args: { actionId: b.id } });
    let s = (await tom<{ streams: { id: string; status: string }[] }>('GET', `/api/projects/${pid}/streams`)).body.streams.find((x) => x.id === b.id)!;
    expect(s.status).toBe('done');
    const since = b.headSeq;
    const f = await cmd<{ actions: { id: string }[] }>({ command: 'propose', agent: 'ab12c', args: { actions: [{ title: 'Follow up B', size: 'S', inputs: [doc], outputs: [{ kind: 'document', title: 'more' }] }] } });
    expect(f.body.stream).toBe(b.id);
    s = (await tom<{ streams: { id: string; status: string }[] }>('GET', `/api/projects/${pid}/streams`)).body.streams.find((x) => x.id === b.id)!;
    expect(s.status).toBe('ready');
    // SSE catch-up from the old head returns exactly the events since.
    const ctrl = new AbortController();
    const res = await fetch(`${srv.url}/api/projects/${pid}/events?since=${since}`, { headers: { cookie: (await signInWeb('tom')) }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: append')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (text.includes('\n\n') && text.split('\n\n').length > 2) break;
    }
    ctrl.abort();
    const appendBlock = text.split('\n\n').find((b) => b.startsWith('event: append'))!;
    const data = JSON.parse(appendBlock.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as { events: Event[] };
    expect(data.events.every((e) => e.seq! > since)).toBe(true);
    expect(data.events.map((e) => e.type)).toEqual(['artefact.version', 'action.completed', 'artefact.declared', 'action.proposed']);
    expect(data.events.every((e) => e.stream === b.id)).toBe(true);
  });

  it('union of stream states equals the projection of the exported log', async () => {
    const list = (await tom<{ streams: { state: State }[] }>('GET', `/api/projects/${pid}/streams?states=1`)).body.streams;
    const union = unionState(list.map((s) => s.state));
    const exported = (await tom<string>('GET', `/api/projects/${pid}/export`)).body;
    const events = exported.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Event);
    const full = project(events);
    expect(Object.keys(union.actions).sort()).toEqual(Object.keys(full.actions).sort());
    for (const id of Object.keys(full.actions)) expect(union.actions[id]!.status).toBe(full.actions[id]!.status);
    expect(workflows(union).list.length).toBe(workflows(full).list.length);
  });

  it('imports a v1 file log into streams', async () => {
    const www = (await tom<{ id: string }>('GET', '/api/projects/by-repo/boxops/www')).body.id;
    const file = fs.readFileSync(path.resolve(__dirname, 'fixtures/mvp.jsonl'), 'utf8');
    const r = await tom<{ imported: number; streams: number }>('POST', `/api/projects/${www}/import`, undefined);
    expect(r.status).toBe(400);
    const res = await fetch(`${srv.url}/api/projects/${www}/import`, { method: 'POST', headers: { cookie: await signInWeb('tom') }, body: file });
    const body = (await res.json()) as { imported: number; streams: number };
    expect(body.imported).toBe(file.split('\n').filter(Boolean).length);
    expect(body.streams).toBe(2);
    const st = (await tom<{ streams: { title: string; status: string }[] }>('GET', `/api/projects/${www}/streams`)).body.streams;
    expect(st.map((s) => s.title).sort()).toEqual(['Add passwordless login', 'Move CI to GitHub Actions']);
    const text = (await tom<string>('GET', `/api/projects/${www}/status`)).body;
    expect(text).toContain('Coalface:');
  });
});
