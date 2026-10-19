// The browser's view of the server. Reads are per project: every workflow
// stream's current state at once, one stream's events for scrubbing, and a
// live feed that resumes from the last seq the page saw.

import type { Actor, Event, Policy, State } from '@coalface/core';

export interface Me {
  user: { id: string; login: string; name?: string; avatar?: string };
  actor: Actor;
  mode: 'github' | 'dev';
  github: boolean;
}

export interface Project {
  id: string;
  owner: string;
  name: string;
  policy: Policy;
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

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // plain text
  }
  if (!r.ok) throw new ApiError(r.status, (parsed as { error?: string })?.error ?? `${method} ${path} failed (${r.status})`);
  return parsed as T;
}

/** The signed-in user, or null when the server wants a sign-in. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await call<Me>('GET', '/api/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export const signInUrl = '/auth/github/start';

export async function logout(): Promise<void> {
  await call('POST', '/api/auth/logout');
}

export function fetchProjects(): Promise<Project[]> {
  return call('GET', '/api/projects');
}

export function createProject(owner: string, name: string): Promise<Project> {
  return call('POST', '/api/projects', { owner, name });
}

export function fetchStates(projectId: string): Promise<{ head: number; streams: (StreamSummary & { state: State })[] }> {
  return call('GET', `/api/projects/${projectId}/streams?states=1`);
}

export function fetchStreamEvents(projectId: string, stream: string): Promise<Event[]> {
  return call('GET', `/api/projects/${projectId}/streams/${encodeURIComponent(stream)}/events`);
}

export function subscribe(
  projectId: string,
  since: number,
  handlers: { append: (events: Event[]) => void; status: (connected: boolean) => void },
): () => void {
  const es = new EventSource(`/api/projects/${projectId}/events?since=${since}`);
  es.addEventListener('append', (e) => handlers.append((JSON.parse((e as MessageEvent).data) as { events: Event[] }).events));
  es.onopen = () => handlers.status(true);
  es.onerror = () => handlers.status(false);
  return () => es.close();
}

export interface CommandResult {
  ok: true;
  warnings?: string[];
  stream?: string;
  rev?: number;
  [k: string]: unknown;
}

export function command<T = CommandResult>(projectId: string, name: string, args: Record<string, unknown>): Promise<T> {
  return call<T>('POST', `/api/projects/${projectId}/commands`, { command: name, args });
}
