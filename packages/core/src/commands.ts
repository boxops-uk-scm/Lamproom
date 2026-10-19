// Commands turn an actor's intent into a batch of events. They validate
// against the current projection and perform policy (atom) expansion, so the
// log stays self-contained: every expansion is recorded as ordinary events.

import { newActionId, newArtefactId, newEventId } from './ids.js';
import { joinRichText } from './richtext.js';
import { fill } from './policy.js';
import { current } from './project.js';
import type {
  ActionState,
  Actor,
  ArtefactState,
  Evaluation,
  Event,
  EventPayload,
  Policy,
  Rung,
  Size,
  State,
} from './types.js';

export interface Ctx {
  state: State;
  policy: Policy;
  actor: Actor;
  rung: Rung;
  /** Set when an agent relays a human's decision from chat. */
  onBehalfOf?: Actor;
  now?: () => string;
}

export class CommandError extends Error {}

export interface Result {
  events: Event[];
  warnings: string[];
}

function ev(ctx: Ctx, payload: EventPayload, rung: Rung = ctx.rung): Event {
  return {
    ...payload,
    id: newEventId(),
    ts: (ctx.now ?? (() => new Date().toISOString()))(),
    actor: ctx.actor,
    onBehalfOf: ctx.onBehalfOf,
    rung,
  };
}

/** The actor whose decision a command records. */
function decider(ctx: Ctx): Actor {
  return ctx.onBehalfOf ?? ctx.actor;
}

/** Relayed decisions are only allowed where the artefact's atom permits it. */
function checkRelay(ctx: Ctx, a: ArtefactState): void {
  if (!ctx.onBehalfOf) return;
  if (ctx.onBehalfOf.kind !== 'human') throw new CommandError('can only act on behalf of a human');
  if (ctx.actor.principal && ctx.actor.principal !== ctx.onBehalfOf.id) {
    throw new CommandError(`${ctx.actor.id} may only relay for its principal ${ctx.actor.principal}`);
  }
  if (!ctx.policy.atoms[a.kind]?.relay) {
    throw new CommandError(`${a.kind} decisions cannot be relayed; the human must act in the UI or CLI`);
  }
}

function producedByHuman(ctx: Ctx, artefactId: string): boolean {
  return Object.values(ctx.state.actions).some(
    (t) => t.outputs.includes(artefactId) && t.requires?.actorKind === 'human',
  );
}

function getAction(ctx: Ctx, id: string): ActionState {
  const t = ctx.state.actions[id];
  if (!t) throw new CommandError(`unknown action ${id}`);
  return t;
}

function getArtefact(ctx: Ctx, id: string): ArtefactState {
  const a = ctx.state.artefacts[id];
  if (!a) throw new CommandError(`unknown artefact ${id}`);
  return a;
}

// ---- artefacts ----------------------------------------------------------

export interface DeclareInput {
  kind: string;
  title: string;
  criteria?: string[];
  parent?: string;
  /** Initial content; becomes version 1 immediately (questions, notes). */
  content?: string;
}

export interface DeclareResult extends Result {
  id: string;
  /** Terminal artefact id if the kind expanded through an atom. */
  terminalId?: string;
  /** The atom's action id (e.g. the review or answer action). */
  atomActionId?: string;
}

export function declareArtefact(ctx: Ctx, input: DeclareInput): DeclareResult {
  if (!input.title?.trim()) throw new CommandError('artefact needs a title');
  if (input.parent) getAction(ctx, input.parent);
  const events: Event[] = [];
  const id = newArtefactId();
  const atom = ctx.policy.atoms[input.kind];
  let terminalId: string | undefined;
  let atomActionId: string | undefined;

  if (atom) {
    // Expansion: naked -> atom action -> terminal. Recurse in case the
    // terminal kind has its own atom (well-foundedness is checked at load).
    const terminal = declareArtefact(
      { ...ctx, rung: 'owned' },
      {
        kind: atom.terminal,
        title: fill(atom.terminalTitle ?? '{title}', { title: input.title }),
        criteria: input.criteria,
        parent: input.parent,
      },
    );
    terminalId = terminal.id;
    atomActionId = newActionId();
    events.push(
      ev(ctx, {
        type: 'artefact.declared',
        artefact: {
          id,
          kind: input.kind,
          title: input.title,
          criteria: input.criteria,
          parent: input.parent,
          closedTo: terminalId,
        },
      }),
    );
    for (const e of terminal.events) {
      if (e.type === 'artefact.declared' && e.artefact.id === terminalId) {
        e.artefact.expandedFrom = id;
      }
      events.push(e);
    }
    events.push(
      ev(
        ctx,
        {
          type: 'action.proposed',
          action: {
            id: atomActionId,
            title: fill(atom.action.title, { title: input.title }),
            description: atom.action.description,
            parent: input.parent,
            inputs: [id],
            outputs: [terminalId],
            size: atom.action.size,
            requires: atom.action.requires,
            expandedFrom: id,
          },
        },
        'owned',
      ),
    );
  } else {
    events.push(
      ev(ctx, {
        type: 'artefact.declared',
        artefact: {
          id,
          kind: input.kind,
          title: input.title,
          criteria: input.criteria,
          parent: input.parent,
        },
      }),
    );
  }

  if (input.content) {
    // Insert the version right after the naked declaration.
    const idx = events.findIndex((e) => e.type === 'artefact.declared' && e.artefact.id === id);
    events.splice(idx + 1, 0, ev(ctx, { type: 'artefact.version', artefactId: id, ref: input.content }));
  }
  return { events, warnings: [], id, terminalId, atomActionId };
}

export function attachVersion(
  ctx: Ctx,
  input: { artefactId: string; ref: string; note?: string },
): Result {
  getArtefact(ctx, input.artefactId);
  if (decider(ctx).kind !== 'human' && producedByHuman(ctx, input.artefactId)) {
    throw new CommandError(`${input.artefactId} is produced by a human action; use answer or review`);
  }
  return {
    events: [ev(ctx, { type: 'artefact.version', artefactId: input.artefactId, ref: input.ref, note: input.note })],
    warnings: [],
  };
}

// ---- actions ------------------------------------------------------------

export type OutputSpec = string | { kind: string; title: string; criteria?: string[] };

export interface ProposeInput {
  parent?: string;
  actions: {
    title: string;
    description?: string;
    size?: Size;
    inputs?: string[];
    outputs?: OutputSpec[];
  }[];
}

export interface ProposeResult extends Result {
  actions: { id: string; title: string; inputs: string[]; outputs: string[] }[];
}

export function proposeActions(ctx: Ctx, input: ProposeInput): ProposeResult {
  if (input.parent) getAction(ctx, input.parent);
  if (!input.actions?.length) throw new CommandError('propose at least one action');
  const events: Event[] = [];
  const warnings: string[] = [];
  const out: ProposeResult['actions'] = [];
  for (const spec of input.actions) {
    if (!spec.title?.trim()) throw new CommandError('action needs a title');
    const inputs = spec.inputs ?? [];
    for (const i of inputs) getArtefact(ctx, i);
    const outputs: string[] = [];
    for (const o of spec.outputs ?? []) {
      if (typeof o === 'string') {
        getArtefact(ctx, o);
        outputs.push(o);
      } else {
        const d = declareArtefact(ctx, { ...o, parent: input.parent });
        events.push(...d.events);
        outputs.push(d.id);
      }
    }
    if (!outputs.length) warnings.push(`action "${spec.title}" has no outputs; it can never be verified`);
    const id = newActionId();
    events.push(
      ev(ctx, {
        type: 'action.proposed',
        action: {
          id,
          title: spec.title,
          description: spec.description,
          parent: input.parent,
          inputs,
          outputs,
          size: spec.size,
        },
      }),
    );
    out.push({ id, title: spec.title, inputs, outputs });
  }
  return { events, warnings, actions: out };
}

export function evaluate(ctx: Ctx, input: { actionId: string } & Evaluation): Result {
  const t = getAction(ctx, input.actionId);
  const warnings: string[] = [];
  if (input.judgement === 'implement' && (input.size === 'L' || input.size === 'XL')) {
    warnings.push(`judgement is implement but size is ${input.size}; sizes L and XL should be decomposed`);
  }
  if (input.judgement === 'implement' && !(input.criteria?.length || t.outputs.some((o) => ctx.state.artefacts[o]?.criteria?.length))) {
    warnings.push('implement without acceptance criteria; state what done looks like');
  }
  const { actionId, ...rest } = input;
  return { events: [ev(ctx, { type: 'action.evaluated', actionId, ...rest })], warnings };
}

export function claim(ctx: Ctx, input: { actionId: string; force?: boolean }): Result {
  const t = getAction(ctx, input.actionId);
  const events: Event[] = [];
  const warnings: string[] = [];
  if (t.abandoned) throw new CommandError(`action ${t.id} is abandoned`);
  if (t.children.length) throw new CommandError(`action ${t.id} is decomposed; claim one of its children`);
  if (t.requires && t.requires.actorKind !== ctx.actor.kind) {
    throw new CommandError(`action ${t.id} requires a ${t.requires.actorKind}`);
  }
  if (t.claimedBy && t.claimedBy.id !== ctx.actor.id) {
    // Humans always pre-empt. Agents may take over another agent's claim
    // only with force, meant for sessions that died holding an action.
    const mayTake = ctx.actor.kind === 'human' || (input.force && t.claimedBy.kind === 'agent');
    if (!mayTake) {
      throw new CommandError(
        `action ${t.id} is held by ${t.claimedBy.id}; if that session is gone, claim again with force`,
      );
    }
    events.push(ev(ctx, { type: 'action.released', actionId: t.id, reason: `pre-empted by ${ctx.actor.id}` }));
  }
  if (!t.enabled) warnings.push(`action ${t.id} is blocked on ${t.blockedOn.join(', ')}`);
  events.push(ev(ctx, { type: 'action.claimed', actionId: t.id }));
  return { events, warnings };
}

export function release(ctx: Ctx, input: { actionId: string; reason?: string }): Result {
  const t = getAction(ctx, input.actionId);
  if (!t.claimedBy) return { events: [], warnings: [`action ${t.id} was not claimed`] };
  return { events: [ev(ctx, { type: 'action.released', actionId: t.id, reason: input.reason })], warnings: [] };
}

export function progress(ctx: Ctx, input: { actionId: string; note: string }): Result {
  const t = getAction(ctx, input.actionId);
  const warnings: string[] = [];
  if (t.claimedBy?.id !== ctx.actor.id) warnings.push(`you have not claimed ${t.id}`);
  return { events: [ev(ctx, { type: 'action.progressed', actionId: t.id, note: input.note })], warnings };
}

export function complete(ctx: Ctx, input: { actionId: string; note?: string }): Result {
  const t = getAction(ctx, input.actionId);
  const warnings: string[] = [];
  if (t.children.length) throw new CommandError(`action ${t.id} is decomposed; it completes when its children do`);
  for (const o of t.outputs) {
    const a = ctx.state.artefacts[o];
    if (a && !a.versions.length) warnings.push(`output ${o} "${a.title}" has no version attached`);
  }
  if (t.claimedBy && t.claimedBy.id !== ctx.actor.id && ctx.actor.kind !== 'human') {
    throw new CommandError(`action ${t.id} is held by ${t.claimedBy.id}`);
  }
  if (t.requires && t.requires.actorKind !== decider(ctx).kind) {
    throw new CommandError(`action ${t.id} requires a ${t.requires.actorKind}; use answer or review`);
  }
  return { events: [ev(ctx, { type: 'action.completed', actionId: t.id, note: input.note })], warnings };
}

export function abandon(ctx: Ctx, input: { actionId: string; reason?: string }): Result {
  const t = getAction(ctx, input.actionId);
  return { events: [ev(ctx, { type: 'action.abandoned', actionId: t.id, reason: input.reason })], warnings: [] };
}

/** Undoes an abandonment. The log keeps both; the action is simply workable again. */
export function restore(ctx: Ctx, input: { actionId: string; note?: string }): Result {
  const t = getAction(ctx, input.actionId);
  if (!t.abandoned) throw new CommandError(`action ${t.id} is not abandoned`);
  return { events: [ev(ctx, { type: 'action.restored', actionId: t.id, note: input.note })], warnings: [] };
}

/** Undoes a completion. Outputs keep their versions; the action goes back to the face. */
export function reopen(ctx: Ctx, input: { actionId: string; note?: string }): Result {
  const t = getAction(ctx, input.actionId);
  if (t.children.length) throw new CommandError(`action ${t.id} is decomposed; reopen one of its children`);
  if (!t.completed) throw new CommandError(`action ${t.id} is not completed`);
  return { events: [ev(ctx, { type: 'action.reopened', actionId: t.id, note: input.note })], warnings: [] };
}

export interface AmendInput {
  actionId: string;
  addInputs?: string[];
  removeInputs?: string[];
  addOutputs?: OutputSpec[];
  removeOutputs?: string[];
  size?: Size;
  title?: string;
}

export function amend(ctx: Ctx, input: AmendInput): Result & { addedOutputs: string[] } {
  const t = getAction(ctx, input.actionId);
  const events: Event[] = [];
  for (const i of input.addInputs ?? []) getArtefact(ctx, i);
  const addOutputs: string[] = [];
  for (const o of input.addOutputs ?? []) {
    if (typeof o === 'string') {
      getArtefact(ctx, o);
      addOutputs.push(o);
    } else {
      const d = declareArtefact(ctx, { ...o, parent: t.parent });
      events.push(...d.events);
      addOutputs.push(d.id);
    }
  }
  events.push(
    ev(ctx, {
      type: 'action.amended',
      actionId: t.id,
      addInputs: input.addInputs,
      removeInputs: input.removeInputs,
      addOutputs: addOutputs.length ? addOutputs : undefined,
      removeOutputs: input.removeOutputs,
      size: input.size,
      title: input.title,
    }),
  );
  return { events, warnings: [], addedOutputs: addOutputs };
}

/**
 * Yield to a human with a question. Declares a question artefact (which the
 * policy expands into an answer action), adds the answer as an input of the
 * asking action so it blocks, and optionally releases the claim.
 */
export function ask(
  ctx: Ctx,
  input: { actionId: string; question: string; context?: string; release?: boolean },
): Result & { questionId: string; answerId: string } {
  const t = getAction(ctx, input.actionId);
  const q = declareArtefact(ctx, {
    kind: 'question',
    title: input.question,
    parent: t.parent,
    content: input.context ? `${input.question}\n\n${input.context}` : input.question,
  });
  if (!q.terminalId) throw new CommandError('policy has no atom for kind "question"');
  const events = [...q.events];
  events.push(ev(ctx, { type: 'action.amended', actionId: t.id, addInputs: [q.terminalId] }));
  if (input.release !== false && t.claimedBy?.id === ctx.actor.id) {
    events.push(ev(ctx, { type: 'action.released', actionId: t.id, reason: `waiting on ${q.terminalId}` }));
  }
  return { events, warnings: q.warnings, questionId: q.id, answerId: q.terminalId };
}

/** A human answers a question: versions and accepts the answer, completes the answer action. */
export function answer(ctx: Ctx, input: { questionId: string; text: string }): Result {
  const q = getArtefact(ctx, input.questionId);
  if (!q.closedTo) throw new CommandError(`${q.id} is not a question with an answer artefact`);
  checkRelay(ctx, q);
  if (decider(ctx).kind !== 'human') throw new CommandError('only a human can answer');
  const action = Object.values(ctx.state.actions).find((t) => t.expandedFrom === q.id);
  const events: Event[] = [
    ev(ctx, { type: 'artefact.version', artefactId: q.closedTo, ref: input.text }),
    ev(ctx, { type: 'artefact.accepted', artefactId: q.closedTo }),
  ];
  if (action) events.push(ev(ctx, { type: 'action.completed', actionId: action.id, note: 'answered' }));
  return { events, warnings: [] };
}

/**
 * A human reviews an artefact. For a naked artefact with a terminal (e.g. a
 * pull request), accept versions and accepts the terminal and completes the
 * atom's action; reject marks the naked artefact's current version rejected,
 * which sends its producer to rework.
 */
export function review(
  ctx: Ctx,
  input: { artefactId: string; verdict: 'accept' | 'reject'; notes?: string[] },
): Result {
  const a = getArtefact(ctx, input.artefactId);
  checkRelay(ctx, a);
  if (decider(ctx).kind !== 'human') throw new CommandError('only a human can review');
  const ref = current(a);
  if (!ref) throw new CommandError(`${a.id} has no version to review`);
  const events: Event[] = [];
  if (input.verdict === 'reject') {
    events.push(ev(ctx, { type: 'artefact.rejected', artefactId: a.id, ref, reasons: input.notes ?? ['rejected'] }));
    return { events, warnings: [] };
  }
  if (a.closedTo) {
    events.push(
      ev(ctx, { type: 'artefact.version', artefactId: a.closedTo, ref, note: joinRichText(input.notes) }),
      ev(ctx, { type: 'artefact.accepted', artefactId: a.closedTo, ref }),
    );
    const action = Object.values(ctx.state.actions).find((t) => t.expandedFrom === a.id);
    if (action) events.push(ev(ctx, { type: 'action.completed', actionId: action.id, note: 'accepted' }));
  } else {
    events.push(ev(ctx, { type: 'artefact.accepted', artefactId: a.id, ref, note: joinRichText(input.notes) }));
  }
  return { events, warnings: [] };
}
