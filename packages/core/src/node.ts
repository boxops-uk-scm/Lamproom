// Node-only: the file-backed event store. One JSONL file, append-only.
// Sequence numbers are line positions, so concurrent appenders never clash.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx, Result } from './commands.js';
import { DEFAULT_POLICY, mergePolicy, validatePolicy } from './policy.js';
import { project } from './project.js';
import { upcast } from './upcast.js';
import type { Actor, Event, Policy, Rung, State } from './types.js';

export const DIR_NAME = '.lamproom';

export class Store {
  readonly eventsPath: string;
  readonly policyPath: string;

  constructor(readonly dir: string) {
    this.eventsPath = path.join(dir, 'events.jsonl');
    this.policyPath = path.join(dir, 'policy.json');
  }

  /** Walk up from `start` looking for a .lamproom dir; default to start/.lamproom. */
  static resolve(start: string = process.cwd()): Store {
    const explicit = process.env.LAMPROOM_DIR;
    if (explicit) return new Store(path.resolve(explicit));
    let cur = path.resolve(start);
    for (;;) {
      const candidate = path.join(cur, DIR_NAME);
      if (fs.existsSync(candidate)) return new Store(candidate);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return new Store(path.join(path.resolve(start), DIR_NAME));
  }

  exists(): boolean {
    return fs.existsSync(this.eventsPath);
  }

  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.policyPath)) {
      fs.writeFileSync(this.policyPath, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n');
    }
    if (!fs.existsSync(this.eventsPath)) fs.writeFileSync(this.eventsPath, '');
  }

  readEvents(): Event[] {
    return this.readEventsFrom(this.eventsPath);
  }

  /** Read any JSON-lines log; seq is the line position. */
  readEventsFrom(file: string): Event[] {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const events: Event[] = [];
    let seq = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push({ ...upcast(JSON.parse(trimmed)), seq });
      } catch {
        // A torn write; skip the line but keep seq stable for later lines.
      }
      seq++;
    }
    return events;
  }

  policy(): Policy {
    if (!fs.existsSync(this.policyPath)) return DEFAULT_POLICY;
    const p = mergePolicy(JSON.parse(fs.readFileSync(this.policyPath, 'utf8')) as Policy);
    const errors = validatePolicy(p);
    if (errors.length) throw new Error(`invalid policy: ${errors.join('; ')}`);
    return p;
  }

  append(events: Event[]): void {
    if (!events.length) return;
    if (!this.exists()) this.init();
    const lines = events.map((e) => JSON.stringify(stripSeq(e))).join('\n') + '\n';
    fs.appendFileSync(this.eventsPath, lines);
  }

  state(): State {
    return project(this.readEvents());
  }

  ctx(actor: Actor, rung: Rung, onBehalfOf?: Actor): Ctx {
    return { state: this.state(), policy: this.policy(), actor, rung, onBehalfOf };
  }

  /** Project, run a command, append its events. Returns the command result. */
  run<T extends Result>(actor: Actor, rung: Rung, fn: (ctx: Ctx) => T, onBehalfOf?: Actor): T {
    const result = fn(this.ctx(actor, rung, onBehalfOf));
    this.append(result.events);
    return result;
  }

  /** Poll the log for changes. Returns a stop function. */
  watch(onChange: () => void, intervalMs = 300): () => void {
    if (!fs.existsSync(this.eventsPath)) this.init();
    fs.watchFile(this.eventsPath, { interval: intervalMs }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) onChange();
    });
    return () => fs.unwatchFile(this.eventsPath);
  }
}

/** The store's own fields (positions) never go into the file; it assigns them on read. */
function stripSeq(e: Event): Omit<Event, 'seq' | 'stream' | 'rev'> {
  const { seq: _seq, stream: _stream, rev: _rev, ...rest } = e;
  return rest;
}

export function humanActor(): Actor {
  const name = process.env.LAMPROOM_HUMAN ?? os.userInfo().username;
  return { id: `human:${name}`, kind: 'human', name };
}

export function agentActor(label?: string): Actor {
  const principal = process.env.LAMPROOM_HUMAN ?? os.userInfo().username;
  const suffix = label ?? process.env.LAMPROOM_AGENT ?? Math.random().toString(36).slice(2, 7);
  return { id: `agent:${suffix}`, kind: 'agent', name: `agent ${suffix}`, principal: `human:${principal}` };
}
