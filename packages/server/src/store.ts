// Projects, streams and events. One stream per workflow: events carry a
// global seq (commit order across the project) and a dense per-stream rev;
// each stream keeps a snapshot of its projected state and the summary the
// overview needs, updated in the same transaction as the append, so reading
// the project never replays anything. Scrubbing a workflow's history reads
// that stream's events alone.

import {
  PROJECTION_VERSION,
  extend,
  project,
  upcast,
  workflows,
  type Event,
  type Policy,
  type State,
  type Workflow,
} from '@coalface/core';
import { DEFAULT_POLICY, mergePolicy } from '@coalface/core';
import { randomUUID } from 'node:crypto';
import type { Db, Row } from './db.js';

export interface Project {
  id: string;
  owner: string;
  name: string;
  repoId?: number;
  policy: Policy;
  createdBy?: string;
  createdAt: string;
}

export interface StreamSummary {
  id: string;
  rev: number;
  headSeq: number;
  createdSeq: number;
  title: string;
  status: Workflow['status'];
  done: number;
  total: number;
  humanQueue: number;
}

export interface Appended {
  stream: string;
  rev: number;
  seq: number;
  events: Event[];
  summary: StreamSummary;
}

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

type Listener = (a: Appended) => void;

/** Serialises writers per project: seq order is commit order. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function stripState(s: State): Omit<State, 'events'> {
  const { events: _e, ...rest } = s;
  return rest;
}

export class Store {
  private locks = new Map<string, Mutex>();
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly db: Db) {}

  // ---- projects --------------------------------------------------------

  async createProject(input: { owner: string; name: string; repoId?: number; policy?: Policy; createdBy?: string }): Promise<Project> {
    const existing = await this.getProjectByRepo(input.owner, input.name);
    if (existing) return existing;
    const p: Project = {
      id: randomUUID(),
      owner: input.owner,
      name: input.name,
      repoId: input.repoId,
      policy: mergePolicy(input.policy ?? DEFAULT_POLICY),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    await this.db.run(`INSERT INTO projects (id, owner, name, repo_id, policy, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      p.id,
      p.owner,
      p.name,
      p.repoId ?? null,
      JSON.stringify(p.policy),
      p.createdBy ?? null,
      p.createdAt,
    ]);
    if (p.createdBy) await this.addMember(p.id, p.createdBy, 'owner');
    return p;
  }

  async getProject(id: string): Promise<Project | undefined> {
    const r = await this.db.get(`SELECT * FROM projects WHERE id = ?`, [id]);
    return r && rowToProject(r);
  }

  async getProjectByRepo(owner: string, name: string): Promise<Project | undefined> {
    const r = await this.db.get(`SELECT * FROM projects WHERE lower(owner) = lower(?) AND lower(name) = lower(?)`, [owner, name]);
    return r && rowToProject(r);
  }

  async listProjects(userId: string): Promise<Project[]> {
    const rows = await this.db.all(
      `SELECT p.* FROM projects p JOIN members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.owner, p.name`,
      [userId],
    );
    return rows.map(rowToProject);
  }

  async addMember(projectId: string, userId: string, role = 'member'): Promise<void> {
    await this.db.run(`INSERT INTO members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, user_id) DO NOTHING`, [
      projectId,
      userId,
      role,
    ]);
  }

  async isMember(projectId: string, userId: string): Promise<boolean> {
    return !!(await this.db.get(`SELECT 1 AS x FROM members WHERE project_id = ? AND user_id = ?`, [projectId, userId]));
  }

  // ---- streams ---------------------------------------------------------

  async streams(projectId: string): Promise<StreamSummary[]> {
    const rows = await this.db.all(`SELECT * FROM streams WHERE project_id = ? ORDER BY created_seq`, [projectId]);
    return rows.map(rowToSummary);
  }

  async headSeq(projectId: string): Promise<number> {
    const r = await this.db.get<{ m: number | null }>(`SELECT max(seq) AS m FROM events WHERE project_id = ?`, [projectId]);
    return Number(r?.m ?? 0);
  }

  /** A stream's current state, from its snapshot, rebuilt from its events if the projection moved on. */
  async streamState(projectId: string, streamId: string): Promise<{ summary: StreamSummary; state: State } | undefined> {
    const row = await this.db.get(`SELECT * FROM streams WHERE project_id = ? AND id = ?`, [projectId, streamId]);
    if (!row) return undefined;
    const summary = rowToSummary(row);
    if (Number(row.projection) === PROJECTION_VERSION) {
      const state = JSON.parse(String(row.snapshot)) as State;
      state.events = [];
      return { summary, state };
    }
    const state = project(await this.streamEvents(projectId, streamId));
    await this.saveSnapshot(projectId, streamId, state, summary.rev, summary.headSeq, summary.createdSeq);
    return { summary: { ...summary, ...summarise(state, streamId) }, state };
  }

  /** Every stream with its state, for the overview. */
  async allStates(projectId: string): Promise<{ summary: StreamSummary; state: State }[]> {
    const out: { summary: StreamSummary; state: State }[] = [];
    for (const s of await this.streams(projectId)) {
      const r = await this.streamState(projectId, s.id);
      if (r) out.push(r);
    }
    return out;
  }

  async streamEvents(projectId: string, streamId: string): Promise<Event[]> {
    const rows = await this.db.all(`SELECT * FROM events WHERE project_id = ? AND stream = ? ORDER BY seq`, [projectId, streamId]);
    return rows.map(rowToEvent);
  }

  async eventsSince(projectId: string, seq: number, limit = 10000): Promise<Event[]> {
    const rows = await this.db.all(`SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?`, [projectId, seq, limit]);
    return rows.map(rowToEvent);
  }

  async allEvents(projectId: string): Promise<Event[]> {
    const rows = await this.db.all(`SELECT * FROM events WHERE project_id = ? ORDER BY seq`, [projectId]);
    return rows.map(rowToEvent);
  }

  async entityStream(projectId: string, id: string): Promise<string | undefined> {
    const r = await this.db.get<{ stream: string }>(`SELECT stream FROM entities WHERE project_id = ? AND id = ?`, [projectId, id]);
    return r?.stream;
  }

  /**
   * The one stream the given entity ids live in; undefined when none exists
   * yet. Throws ConflictError when they span streams, which would be an edge
   * between workflows.
   */
  async resolveStream(projectId: string, ids: string[]): Promise<string | undefined> {
    const found = new Set<string>();
    for (const id of ids) {
      const s = await this.entityStream(projectId, id);
      if (s) found.add(s);
    }
    if (found.size > 1) throw new ConflictError(`ids span ${found.size} workflows; an action cannot join workflows`);
    return [...found][0];
  }

  // ---- append ----------------------------------------------------------

  /**
   * Append events to a stream (created if new). With `expectedRev`, the
   * append is refused unless the stream is at that revision. Seq is assigned
   * at commit under the project's lock, so seq order is commit order.
   */
  async append(projectId: string, streamId: string, events: Event[], expectedRev?: number): Promise<Appended> {
    if (!events.length) throw new Error('nothing to append');
    return this.lock(projectId).lock(() =>
      this.db.tx(async () => {
        if (this.db.dialect === 'postgres') {
          await this.db.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, [projectId]);
        }
        const row = await this.db.get(`SELECT * FROM streams WHERE project_id = ? AND id = ?`, [projectId, streamId]);
        const existing = row ? rowToSummary(row) : undefined;
        const rev0 = existing?.rev ?? 0;
        if (expectedRev !== undefined && expectedRev !== rev0) {
          throw new ConflictError(`stream ${streamId} is at rev ${rev0}, expected ${expectedRev}`);
        }
        let state: State;
        if (existing && Number(row!.projection) === PROJECTION_VERSION) {
          state = JSON.parse(String(row!.snapshot)) as State;
          state.events = [];
        } else if (existing) {
          state = project(await this.streamEvents(projectId, streamId));
        } else {
          state = project([]);
        }
        const written: Event[] = [];
        let rev = rev0;
        let seq = existing?.headSeq ?? 0;
        for (const raw of events) {
          rev++;
          const { seq: _s, stream: _st, rev: _r, ...body } = raw;
          const r = await this.db.run(
            `INSERT INTO events (project_id, stream, rev, id, type, ts, body) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [projectId, streamId, rev, raw.id, raw.type, raw.ts, JSON.stringify(body)],
          );
          seq = r.lastId ?? seq + 1;
          const e: Event = { ...raw, seq, stream: streamId, rev };
          written.push(e);
          const ent = newEntity(e);
          if (ent) {
            await this.db.run(`INSERT INTO entities (project_id, id, stream) VALUES (?, ?, ?) ON CONFLICT(project_id, id) DO NOTHING`, [
              projectId,
              ent,
              streamId,
            ]);
          }
        }
        extend(state, written);
        const createdSeq = existing?.createdSeq ?? written[0]!.seq!;
        const summary = await this.saveSnapshot(projectId, streamId, state, rev, seq, createdSeq);
        const appended: Appended = { stream: streamId, rev, seq, events: written, summary };
        // Listeners run after commit; queueMicrotask keeps them off the transaction.
        queueMicrotask(() => this.emit(projectId, appended));
        return appended;
      }),
    );
  }

  private async saveSnapshot(projectId: string, streamId: string, state: State, rev: number, headSeq: number, createdSeq: number): Promise<StreamSummary> {
    const sum = summarise(state, streamId);
    await this.db.run(
      `INSERT INTO streams (project_id, id, rev, head_seq, created_seq, projection, snapshot, title, status, done, total, human_queue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, id) DO UPDATE SET rev = excluded.rev, head_seq = excluded.head_seq, projection = excluded.projection,
         snapshot = excluded.snapshot, title = excluded.title, status = excluded.status, done = excluded.done, total = excluded.total,
         human_queue = excluded.human_queue`,
      [projectId, streamId, rev, headSeq, createdSeq, PROJECTION_VERSION, JSON.stringify(stripState(state)), sum.title, sum.status, sum.done, sum.total, sum.humanQueue],
    );
    return { id: streamId, rev, headSeq, createdSeq, ...sum };
  }

  // ---- idempotency -----------------------------------------------------

  async recall(projectId: string, key: string): Promise<unknown | undefined> {
    const r = await this.db.get<{ response: string }>(`SELECT response FROM idempotency WHERE project_id = ? AND key = ?`, [projectId, key]);
    return r ? JSON.parse(r.response) : undefined;
  }

  async remember(projectId: string, key: string, response: unknown): Promise<void> {
    await this.db.run(`INSERT INTO idempotency (project_id, key, response, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, key) DO NOTHING`, [
      projectId,
      key,
      JSON.stringify(response),
      new Date().toISOString(),
    ]);
  }

  // ---- import / export -------------------------------------------------

  /**
   * Replay a file log (events without streams) into streams. Each event's
   * stream is the stream of what it references; a declaration or proposal
   * referencing nothing starts a new stream named after itself.
   */
  async importEvents(projectId: string, raw: unknown[]): Promise<{ imported: number; streams: number }> {
    const events = raw.map(upcast);
    const streamsTouched = new Set<string>();
    let batch: Event[] = [];
    let batchStream: string | undefined;
    const flush = async () => {
      if (batch.length && batchStream) {
        await this.append(projectId, batchStream, batch);
        streamsTouched.add(batchStream);
      }
      batch = [];
      batchStream = undefined;
    };
    for (const e of events) {
      const refs = eventRefs(e);
      let stream: string | undefined;
      for (const id of refs) {
        // Pending entities from this batch count too.
        if (batchStream && batch.some((b) => newEntity(b) === id)) {
          stream = batchStream;
          break;
        }
        stream = await this.entityStream(projectId, id);
        if (stream) break;
      }
      if (!stream) {
        const ent = newEntity(e);
        if (!ent) throw new Error(`event ${e.id} (${e.type}) references nothing known`);
        stream = ent;
      }
      if (batchStream && stream !== batchStream) await flush();
      batchStream = stream;
      batch.push(e);
    }
    await flush();
    return { imported: events.length, streams: streamsTouched.size };
  }

  // ---- live ------------------------------------------------------------

  subscribe(projectId: string, fn: Listener): () => void {
    let set = this.listeners.get(projectId);
    if (!set) this.listeners.set(projectId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }

  private emit(projectId: string, a: Appended): void {
    for (const fn of this.listeners.get(projectId) ?? []) {
      try {
        fn(a);
      } catch {
        // a broken listener must not break the others
      }
    }
  }

  private lock(projectId: string): Mutex {
    let m = this.locks.get(projectId);
    if (!m) this.locks.set(projectId, (m = new Mutex()));
    return m;
  }
}

// ---- helpers ------------------------------------------------------------

function rowToProject(r: Row): Project {
  return {
    id: String(r.id),
    owner: String(r.owner),
    name: String(r.name),
    repoId: r.repo_id == null ? undefined : Number(r.repo_id),
    policy: JSON.parse(String(r.policy)) as Policy,
    createdBy: r.created_by == null ? undefined : String(r.created_by),
    createdAt: String(r.created_at),
  };
}

function rowToSummary(r: Row): StreamSummary {
  return {
    id: String(r.id),
    rev: Number(r.rev),
    headSeq: Number(r.head_seq),
    createdSeq: Number(r.created_seq),
    title: String(r.title),
    status: String(r.status) as Workflow['status'],
    done: Number(r.done),
    total: Number(r.total),
    humanQueue: Number(r.human_queue),
  };
}

function rowToEvent(r: Row): Event {
  return { ...(JSON.parse(String(r.body)) as Event), seq: Number(r.seq), stream: String(r.stream), rev: Number(r.rev) };
}

function summarise(state: State, streamId: string): Pick<StreamSummary, 'title' | 'status' | 'done' | 'total' | 'humanQueue'> {
  const w = workflows(state).list.find((x) => x.id === streamId) ?? workflows(state).list[0];
  if (!w) return { title: streamId, status: 'blocked', done: 0, total: 0, humanQueue: 0 };
  return { title: w.title, status: w.status, done: w.done, total: w.total, humanQueue: w.humanQueue };
}

/** The entity an event creates, if any. */
export function newEntity(e: Event): string | undefined {
  if (e.type === 'artefact.declared') return e.artefact.id;
  if (e.type === 'action.proposed') return e.action.id;
  return undefined;
}

/** Every existing entity an event refers to, most specific first. */
export function eventRefs(e: Event): string[] {
  switch (e.type) {
    case 'artefact.declared':
      return [e.artefact.parent, e.artefact.closedTo, e.artefact.expandedFrom].filter((x): x is string => !!x);
    case 'action.proposed':
      return [e.action.parent, ...e.action.inputs, ...e.action.outputs, e.action.expandedFrom].filter((x): x is string => !!x);
    case 'action.amended':
      return [e.actionId, ...(e.addInputs ?? []), ...(e.addOutputs ?? [])];
    default:
      return ['artefactId' in e ? e.artefactId : e.actionId];
  }
}
