import type { Actor, Event, Policy } from '@coalface/core';

export interface Meta {
  dir: string;
  human: Actor;
  policy: Policy;
}

export function subscribe(handlers: {
  snapshot: (events: Event[]) => void;
  append: (events: Event[]) => void;
  status: (connected: boolean) => void;
}): () => void {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => handlers.snapshot(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('append', (e) => handlers.append(JSON.parse((e as MessageEvent).data)));
  es.onopen = () => handlers.status(true);
  es.onerror = () => handlers.status(false);
  return () => es.close();
}

export async function command<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch('/api/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: name, args }),
  });
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `command ${name} failed`);
  return body;
}

export async function fetchMeta(): Promise<Meta> {
  const r = await fetch('/api/meta');
  if (!r.ok) throw new Error('meta unavailable');
  return (await r.json()) as Meta;
}
