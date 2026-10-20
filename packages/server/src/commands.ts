// Runs a core command against one stream. The stream is whichever one the
// command's ids live in; a proposal or declaration that references nothing
// starts a new stream named after what it creates. Each core command sees
// only its stream's state, which is also what makes "no edges between
// seams" hold at the server without trusting the client.

import * as core from '@lamproom/core';
import type { Actor, Ctx, Event, Result } from '@lamproom/core';
import { ConflictError, NotFoundError, type Project, type Store } from './store.js';

export interface CommandRequest {
  command: string;
  args: Record<string, unknown>;
  /** Refuse unless the target stream is at this revision. */
  expectedRev?: number;
  /** Replay-safe retries: the same key returns the first response. */
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

const STARTERS = new Set(['propose', 'declare']);

type Runner = (ctx: Ctx, args: Record<string, unknown>) => Result;
const RUNNERS: Record<string, Runner> = {
  propose: (ctx, a) => core.proposeActions(ctx, a as unknown as core.ProposeInput),
  decompose: (ctx, a) => core.decomposeWith(ctx, a as unknown as core.DecomposeInput),
  declare: (ctx, a) => core.declareArtefact(ctx, a as unknown as core.DeclareInput),
  evaluate: (ctx, a) => core.evaluate(ctx, a as unknown as { actionId: string } & core.Evaluation),
  claim: (ctx, a) => core.claim(ctx, a as { actionId: string; force?: boolean }),
  release: (ctx, a) => core.release(ctx, a as { actionId: string; reason?: string }),
  progress: (ctx, a) => core.progress(ctx, a as { actionId: string; note: string }),
  attach: (ctx, a) => core.attachVersion(ctx, a as { artefactId: string; ref: string; note?: string }),
  complete: (ctx, a) => core.complete(ctx, a as { actionId: string; note?: string }),
  abandon: (ctx, a) => core.abandon(ctx, a as { actionId: string; reason?: string }),
  restore: (ctx, a) => core.restore(ctx, a as { actionId: string; note?: string }),
  reopen: (ctx, a) => core.reopen(ctx, a as { actionId: string; note?: string }),
  amend: (ctx, a) => core.amend(ctx, a as unknown as core.AmendInput),
  ask: (ctx, a) => core.ask(ctx, a as { actionId: string; question: string; context?: string; release?: boolean }),
  answer: (ctx, a) => core.answer(ctx, a as { questionId: string; text: string }),
  review: (ctx, a) => core.review(ctx, a as { artefactId: string; verdict: 'accept' | 'reject'; notes?: string[] }),
  comment: (ctx, a) => core.comment(ctx, a as unknown as core.CommentInput),
};

export const COMMANDS = Object.keys(RUNNERS);

/** Every existing entity id a command refers to. */
export function commandRefs(args: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const str = (v: unknown): v is string => typeof v === 'string';
  for (const k of ['actionId', 'artefactId', 'questionId', 'targetId', 'parent']) if (str(args[k])) ids.push(args[k]);
  for (const k of ['inputs', 'outputs', 'addInputs', 'addOutputs']) {
    const v = args[k];
    if (Array.isArray(v)) ids.push(...v.filter(str));
  }
  if (Array.isArray(args.actions)) {
    for (const a of args.actions as Record<string, unknown>[]) {
      for (const k of ['inputs', 'outputs']) {
        const v = a[k];
        if (Array.isArray(v)) ids.push(...v.filter(str));
      }
    }
  }
  if (args.bind && typeof args.bind === 'object') ids.push(...Object.values(args.bind as Record<string, unknown>).filter(str));
  return ids;
}

export async function runCommand(
  store: Store,
  project: Project,
  who: { actor: Actor; onBehalfOf?: Actor },
  req: CommandRequest,
): Promise<CommandResponse> {
  const runner = RUNNERS[req.command];
  if (!runner) throw new core.CommandError(`unknown command ${req.command}; one of ${COMMANDS.join(', ')}`);
  if (req.idempotencyKey) {
    const seen = await store.recall(project.id, req.idempotencyKey);
    if (seen) return seen as CommandResponse;
  }
  const args = req.args ?? {};
  // A batch of goals with no parent is several seams: one stream each.
  if (req.command === 'propose' && !args.parent && Array.isArray(args.actions) && args.actions.length > 1 && commandRefs(args).length === 0) {
    const parts: CommandResponse[] = [];
    for (const a of args.actions as unknown[]) parts.push(await runCommand(store, project, who, { command: 'propose', args: { actions: [a] } }));
    const merged: CommandResponse = {
      ok: true,
      warnings: parts.flatMap((p) => p.warnings),
      actions: parts.flatMap((p) => (p.actions as unknown[]) ?? []),
      streams: parts.map((p) => p.stream),
    };
    if (req.idempotencyKey) await store.remember(project.id, req.idempotencyKey, merged);
    return merged;
  }
  const refs = commandRefs(args);
  let streamId: string | undefined;
  try {
    streamId = await store.resolveStream(project.id, refs);
  } catch (e) {
    if (e instanceof ConflictError) throw new core.CommandError(e.message);
    throw e;
  }
  if (!streamId && !STARTERS.has(req.command)) {
    throw new NotFoundError(refs.length ? `unknown id ${refs[0]}` : `${req.command} needs an id`);
  }
  const current = streamId ? await store.streamState(project.id, streamId) : undefined;
  const ctx: Ctx = {
    state: current?.state ?? core.project([]),
    policy: project.policy,
    actor: who.actor,
    rung: who.actor.kind === 'human' ? 'owned' : 'reported',
    onBehalfOf: who.onBehalfOf,
  };
  const r = runner(ctx, args) as Result & Record<string, unknown>;
  const { events, warnings, ...rest } = r;
  const target = streamId ?? newStreamId(r, events);
  let response: CommandResponse;
  if (!events.length) {
    response = { ok: true, warnings, stream: target, rev: current?.summary.rev, ...rest };
  } else {
    const a = await store.append(project.id, target, events, req.expectedRev);
    response = { ok: true, warnings, stream: a.stream, rev: a.rev, seq: a.seq, ...rest };
  }
  if (req.idempotencyKey) await store.remember(project.id, req.idempotencyKey, response);
  return response;
}

function newStreamId(r: Result & Record<string, unknown>, events: Event[]): string {
  const acts = r.actions as { id: string }[] | undefined;
  if (acts?.[0]?.id) return acts[0].id;
  if (typeof r.id === 'string') return r.id;
  for (const e of events) {
    if (e.type === 'action.proposed') return e.action.id;
    if (e.type === 'artefact.declared') return e.artefact.id;
  }
  throw new Error('cannot name a stream for these events');
}
