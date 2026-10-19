// Node-side client for the lamproom server, shared by the CLI and the
// plugin. Holds the sign-in config (~/.config/lamproom/config.json: one API
// token per server), works out which project the working directory is
// (its GitHub remote), and wraps the API.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Actor, Event, Policy, State } from '@lamproom/core';

const run = promisify(execFile);

export const DEFAULT_SERVER = 'http://localhost:4411';

// ---- config -------------------------------------------------------------

export interface Config {
  default?: string;
  servers: Record<string, { token: string; login?: string }>;
}

export function configPath(): string {
  return process.env.LAMPROOM_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'lamproom', 'config.json');
}

export function loadConfig(): Config {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<Config>;
    return { ...c, servers: c.servers ?? {} };
  } catch {
    return { servers: {} };
  }
}

export function saveConfig(c: Config): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

export function resolveServer(explicit?: string): string {
  return (explicit ?? process.env.LAMPROOM_SERVER ?? loadConfig().default ?? DEFAULT_SERVER).replace(/\/$/, '');
}

export function tokenFor(server: string): string | undefined {
  return process.env.LAMPROOM_TOKEN ?? loadConfig().servers[server]?.token;
}

// ---- which project ------------------------------------------------------

export interface Repo {
  owner: string;
  name: string;
}

/** owner/name from a GitHub remote in any of its spellings. */
export function parseRepo(remote: string): Repo | undefined {
  const m =
    /^(?:git@|ssh:\/\/git@|https?:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim()) ??
    /^([\w.-]+)\/([\w.-]+)$/.exec(remote.trim());
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

export async function repoOf(cwd: string): Promise<Repo | undefined> {
  try {
    const { stdout } = await run('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
    return parseRepo(stdout);
  } catch {
    return undefined;
  }
}

// ---- API ----------------------------------------------------------------

export interface Project {
  id: string;
  owner: string;
  name: string;
  policy: Policy;
}

export interface Me {
  user: { id: string; login: string; name?: string; avatar?: string };
  actor: Actor;
  mode: 'github' | 'dev';
}

export interface StreamSummary {
  id: string;
  rev: number;
  headSeq: number;
  createdSeq: number;
  title: string;
  status: string;
  done: number;
  total: number;
  humanQueue: number;
}

export interface CommandBody {
  command: string;
  args: Record<string, unknown>;
  agent?: string;
  onBehalfOf?: boolean;
  expectedRev?: number;
  idempotencyKey?: string;
}

export interface CommandResponse {
  ok: true;
  warnings: string[];
  stream?: string;
  rev?: number;
  seq?: number;
  [k: string]: unknown;
}

export class ClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Client {
  constructor(
    readonly server: string,
    readonly token?: string,
  ) {}

  private async call<T>(method: string, p: string, body?: unknown, raw = false): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.server}${p}`, { method, headers, body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body) });
    } catch (e) {
      throw new ClientError(0, `cannot reach ${this.server}: ${e instanceof Error ? e.message : String(e)}. Is "lamproom serve" running?`);
    }
    const text = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    if (!res.ok) {
      let msg = text;
      if (isJson) {
        try {
          msg = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          // keep text
        }
      }
      if (res.status === 401) msg = `not signed in to ${this.server}: run "lamproom login"`;
      throw new ClientError(res.status, msg);
    }
    return (isJson ? JSON.parse(text) : text) as T;
  }

  me(): Promise<Me> {
    return this.call('GET', '/api/me');
  }
  projects(): Promise<Project[]> {
    return this.call('GET', '/api/projects');
  }
  projectByRepo(owner: string, name: string): Promise<Project> {
    return this.call('GET', `/api/projects/by-repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  }
  createProject(owner: string, name: string): Promise<Project> {
    return this.call('POST', '/api/projects', { owner, name });
  }
  status(projectId: string, agent?: string): Promise<string> {
    return this.call('GET', `/api/projects/${projectId}/status${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`);
  }
  streams(projectId: string): Promise<{ head: number; streams: StreamSummary[] }> {
    return this.call('GET', `/api/projects/${projectId}/streams`);
  }
  states(projectId: string): Promise<{ head: number; streams: (StreamSummary & { state: State })[] }> {
    return this.call('GET', `/api/projects/${projectId}/streams?states=1`);
  }
  streamEvents(projectId: string, stream: string): Promise<Event[]> {
    return this.call('GET', `/api/projects/${projectId}/streams/${encodeURIComponent(stream)}/events`);
  }
  command(projectId: string, body: CommandBody): Promise<CommandResponse> {
    return this.call('POST', `/api/projects/${projectId}/commands`, body);
  }
  importEvents(projectId: string, jsonl: string): Promise<{ imported: number; streams: number }> {
    return this.call('POST', `/api/projects/${projectId}/import`, jsonl, true);
  }
  exportEvents(projectId: string): Promise<string> {
    return this.call('GET', `/api/projects/${projectId}/export`);
  }
  deviceStart(label?: string): Promise<{ id: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }> {
    return this.call('POST', '/api/auth/device', { label });
  }
  devicePoll(id: string): Promise<{ status: 'pending' | 'slow_down' | 'expired' | 'denied' } | { status: 'ok'; token: string; user: Me['user'] }> {
    return this.call('POST', '/api/auth/device/poll', { id });
  }
}

/** The device flow from a terminal: show the code, wait for approval, keep the token. */
export async function login(server: string, label: string, show: (info: { userCode: string; verificationUri: string }) => void): Promise<Me['user']> {
  const anon = new Client(server);
  const d = await anon.deviceStart(label);
  show({ userCode: d.userCode, verificationUri: d.verificationUri });
  let interval = Math.max(1, d.interval) * 1000;
  const deadline = Date.now() + d.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const p = await anon.devicePoll(d.id);
    if (p.status === 'ok') {
      const c = loadConfig();
      c.servers[server] = { token: p.token, login: p.user.login };
      c.default ??= server;
      saveConfig(c);
      return p.user;
    }
    if (p.status === 'slow_down') interval += 5000;
    if (p.status === 'expired' || p.status === 'denied') throw new ClientError(400, `sign-in ${p.status}`);
  }
  throw new ClientError(400, 'sign-in timed out');
}

export function logout(server: string): void {
  const c = loadConfig();
  delete c.servers[server];
  if (c.default === server) delete c.default;
  saveConfig(c);
}

/** Which project a directory is: --project owner/name, LAMPROOM_PROJECT, or its GitHub remote. */
export async function resolveProject(client: Client, cwd: string, explicit?: string): Promise<Project> {
  const spec = explicit ?? process.env.LAMPROOM_PROJECT;
  const repo = spec ? parseRepo(spec) : await repoOf(cwd);
  if (!repo) throw new ClientError(0, 'no project: this directory has no GitHub remote; pass --project owner/name or set LAMPROOM_PROJECT');
  try {
    return await client.projectByRepo(repo.owner, repo.name);
  } catch (e) {
    if (e instanceof ClientError && e.status === 404) {
      throw new ClientError(404, `${repo.owner}/${repo.name} is not registered on ${client.server}; run "lamproom init" there first`);
    }
    throw e;
  }
}
