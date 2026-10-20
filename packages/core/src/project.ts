import type {
  ActionState,
  ActionStatus,
  ArtefactState,
  ArtefactStatus,
  Event,
  State,
} from './types.js';

export function emptyState(): State {
  return { artefacts: {}, actions: {}, order: [], events: [], warnings: [] };
}

/**
 * Fold the event log into state. Pure and deterministic.
 *
 * The log is a grow-only set of events, each with a unique global `seq`, and
 * the state is a function of that set: events are sorted by seq before the
 * fold, so any arrival order gives the same state (the set under union is a
 * join-semilattice, and this projection is monotone over it). Events without
 * a seq are taken in array order, which is the file-log convention.
 */
export function project(events: Event[]): State {
  const s = emptyState();
  const ordered = events.every((e) => typeof e.seq === 'number')
    ? [...events].sort((a, b) => a.seq! - b.seq!)
    : events.map((raw, i) => ({ ...raw, seq: raw.seq ?? i }));
  for (const e of ordered) {
    s.events.push(e);
    apply(s, e);
  }
  derive(s);
  return s;
}

/**
 * Apply further events to an existing state, in place, and re-derive. The
 * events must follow the ones already folded (higher seq). Used to advance a
 * stored snapshot without replaying the stream.
 */
export function extend(s: State, events: Event[]): State {
  const ordered = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const e of ordered) {
    if (typeof e.seq !== 'number') throw new Error('extend needs events with a seq');
    s.events.push(e);
    apply(s, e);
  }
  derive(s);
  return s;
}

/**
 * The state of several independent streams together. Streams share no
 * entities (no cross-seam edges), so the union of their projections is
 * the projection of their union.
 */
export function unionState(states: State[]): State {
  if (states.length === 1) return states[0]!;
  const s = emptyState();
  const order: { id: string; seq: number }[] = [];
  for (const x of states) {
    Object.assign(s.artefacts, x.artefacts);
    Object.assign(s.actions, x.actions);
    for (const id of x.order) order.push({ id, seq: x.actions[id]?.seq ?? x.artefacts[id]?.seq ?? 0 });
    s.events.push(...x.events);
    s.warnings.push(...x.warnings);
  }
  order.sort((a, b) => a.seq - b.seq);
  s.order = order.map((o) => o.id);
  s.events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return s;
}

function apply(s: State, e: Event): void {
  const seq = e.seq!;
  switch (e.type) {
    case 'artefact.declared': {
      if (s.artefacts[e.artefact.id]) {
        s.warnings.push(`#${seq}: artefact ${e.artefact.id} declared twice`);
        return;
      }
      s.artefacts[e.artefact.id] = {
        ...e.artefact,
        seq,
        comments: [],
        versions: [],
        acceptedBy: [],
        rejections: [],
        status: 'declared',
        valid: false,
        closed: false,
      };
      s.order.push(e.artefact.id);
      return;
    }
    case 'artefact.version': {
      const a = s.artefacts[e.artefactId];
      if (!a) return warn(s, seq, `version for unknown artefact ${e.artefactId}`);
      a.versions.push({ ref: e.ref, ts: e.ts, seq, by: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined, note: e.note });
      a.invalidated = undefined;
      return;
    }
    case 'artefact.accepted': {
      const a = s.artefacts[e.artefactId];
      if (!a) return warn(s, seq, `accept for unknown artefact ${e.artefactId}`);
      const ref = e.ref ?? current(a);
      if (!ref) return warn(s, seq, `accept of ${a.id} before any version`);
      if (a.acceptedRef !== ref) a.acceptedBy = [];
      a.acceptedRef = ref;
      a.acceptedBy.push(e.onBehalfOf ?? e.actor);
      return;
    }
    case 'artefact.rejected': {
      const a = s.artefacts[e.artefactId];
      if (!a) return warn(s, seq, `reject for unknown artefact ${e.artefactId}`);
      a.rejectedRef = e.ref ?? current(a) ?? '';
      a.rejections = e.reasons;
      return;
    }
    case 'artefact.invalidated': {
      const a = s.artefacts[e.artefactId];
      if (!a) return warn(s, seq, `invalidate for unknown artefact ${e.artefactId}`);
      a.invalidated = e.reason;
      return;
    }
    case 'action.proposed': {
      if (s.actions[e.action.id]) {
        s.warnings.push(`#${seq}: action ${e.action.id} proposed twice`);
        return;
      }
      s.actions[e.action.id] = {
        ...e.action,
        inputs: [...e.action.inputs],
        outputs: [...e.action.outputs],
        seq,
        comments: [],
        children: [],
        evaluations: [],
        completed: false,
        log: [],
        status: 'blocked',
        enabled: false,
        blockedOn: [],
      };
      s.order.push(e.action.id);
      if (e.action.parent) {
        const p = s.actions[e.action.parent];
        if (p) p.children.push(e.action.id);
        else s.warnings.push(`#${seq}: action ${e.action.id} has unknown parent ${e.action.parent}`);
      }
      return;
    }
    case 'action.evaluated': {
      const t = s.actions[e.actionId];
      if (!t) return warn(s, seq, `evaluation for unknown action ${e.actionId}`);
      const ev = {
        judgement: e.judgement,
        size: e.size,
        criteria: e.criteria,
        unknowns: e.unknowns,
        rationale: e.rationale,
      };
      t.evaluation = ev;
      t.evaluations.push({ ...ev, seq, actor: e.onBehalfOf ?? e.actor });
      if (e.size) t.size = e.size;
      t.log.push({
        seq,
        ts: e.ts,
        type: e.type,
        actor: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined,
        note: `${e.judgement}${e.size ? ` (${e.size})` : ''}`,
      });
      return;
    }
    case 'action.amended': {
      const t = s.actions[e.actionId];
      if (!t) return warn(s, seq, `amendment for unknown action ${e.actionId}`);
      if (e.removeInputs) t.inputs = t.inputs.filter((x) => !e.removeInputs!.includes(x));
      if (e.removeOutputs) t.outputs = t.outputs.filter((x) => !e.removeOutputs!.includes(x));
      for (const x of e.addInputs ?? []) if (!t.inputs.includes(x)) t.inputs.push(x);
      for (const x of e.addOutputs ?? []) if (!t.outputs.includes(x)) t.outputs.push(x);
      if (e.size) t.size = e.size;
      if (e.title) t.title = e.title;
      t.log.push({ seq, ts: e.ts, type: e.type, actor: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined, note: describeAmend(e) });
      return;
    }
    case 'action.claimed': {
      const t = s.actions[e.actionId];
      if (!t) return warn(s, seq, `claim for unknown action ${e.actionId}`);
      t.claimedBy = e.actor;
      t.completed = false;
      t.log.push({ seq, ts: e.ts, type: e.type, actor: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined });
      return;
    }
    case 'action.released': {
      const t = s.actions[e.actionId];
      if (!t) return warn(s, seq, `release for unknown action ${e.actionId}`);
      t.claimedBy = undefined;
      t.log.push({ seq, ts: e.ts, type: e.type, actor: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined, note: e.reason });
      return;
    }
    case 'action.progressed': {
      const t = s.actions[e.actionId];
      if (!t) return warn(s, seq, `progress for unknown action ${e.actionId}`);
      t.log.push({ seq, ts: e.ts, type: e.type, actor: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined, note: e.note });
      return;
    }
    case 'action.completed': {
      const t = s.actions[e.actionId];
      if (!t) return warn(s, seq, `completion for unknown action ${e.actionId}`);
      t.completed = true;
      t.claimedBy = undefined;
      t.log.push({ seq, ts: e.ts, type: e.type, actor: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined, note: e.note });
      return;
    }
    case 'action.abandoned': {
      const t = s.actions[e.actionId];
      if (!t) return warn(s, seq, `abandonment for unknown action ${e.actionId}`);
      t.abandoned = e.reason ?? 'abandoned';
      t.claimedBy = undefined;
      t.log.push({ seq, ts: e.ts, type: e.type, actor: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined, note: e.reason });
      return;
    }
    case 'action.restored': {
      const t = s.actions[e.actionId];
      if (!t) return warn(s, seq, `restore for unknown action ${e.actionId}`);
      t.abandoned = undefined;
      t.log.push({ seq, ts: e.ts, type: e.type, actor: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined, note: e.note });
      return;
    }
    case 'action.reopened': {
      const t = s.actions[e.actionId];
      if (!t) return warn(s, seq, `reopen for unknown action ${e.actionId}`);
      t.completed = false;
      t.claimedBy = undefined;
      t.log.push({ seq, ts: e.ts, type: e.type, actor: e.onBehalfOf ?? e.actor, via: e.onBehalfOf ? e.actor : undefined, note: e.note });
      return;
    }
    case 'comment.added': {
      const target = s.actions[e.targetId] ?? s.artefacts[e.targetId];
      if (!target) return warn(s, seq, `comment on unknown ${e.targetId}`);
      target.comments.push({
        id: e.commentId,
        seq,
        ts: e.ts,
        by: e.onBehalfOf ?? e.actor,
        via: e.onBehalfOf ? e.actor : undefined,
        body: e.body,
        attachments: e.attachments,
        replyTo: e.replyTo,
      });
      return;
    }
  }
}

function warn(s: State, seq: number, msg: string): void {
  s.warnings.push(`#${seq}: ${msg}`);
}

function describeAmend(e: Extract<Event, { type: 'action.amended' }>): string {
  const parts: string[] = [];
  if (e.addInputs?.length) parts.push(`+in ${e.addInputs.join(',')}`);
  if (e.removeInputs?.length) parts.push(`-in ${e.removeInputs.join(',')}`);
  if (e.addOutputs?.length) parts.push(`+out ${e.addOutputs.join(',')}`);
  if (e.removeOutputs?.length) parts.push(`-out ${e.removeOutputs.join(',')}`);
  if (e.size) parts.push(`size ${e.size}`);
  if (e.title) parts.push('retitled');
  return parts.join(' ');
}

export function current(a: ArtefactState): string | undefined {
  return a.versions.length ? a.versions[a.versions.length - 1]!.ref : undefined;
}

/** Compute every derived field. Called once after the fold. */
export function derive(s: State): void {
  for (const a of Object.values(s.artefacts)) {
    a.status = artefactStatus(a);
    a.valid = a.status === 'produced' || a.status === 'accepted';
  }
  for (const a of Object.values(s.artefacts)) {
    const terminal = a.closedTo ? s.artefacts[a.closedTo] : undefined;
    a.closed = a.valid && (terminal ? terminal.status === 'accepted' : true);
  }
  for (const t of Object.values(s.actions)) {
    t.blockedOn = t.inputs.filter((id) => !s.artefacts[id]?.valid);
    t.enabled = t.blockedOn.length === 0;
  }
  // Status depends on children, so resolve via memoised recursion.
  const memo = new Map<string, ActionStatus>();
  const status = (id: string): ActionStatus => {
    const cached = memo.get(id);
    if (cached) return cached;
    const t = s.actions[id]!;
    const r = actionStatus(s, t, status);
    memo.set(id, r);
    return r;
  };
  for (const t of Object.values(s.actions)) t.status = status(t.id);
}

function artefactStatus(a: ArtefactState): ArtefactStatus {
  if (a.invalidated) return 'invalidated';
  const ref = current(a);
  if (!ref) return 'declared';
  if (a.rejectedRef === ref) return 'rejected';
  if (a.acceptedRef === ref) return 'accepted';
  return 'produced';
}

function actionStatus(
  s: State,
  t: ActionState,
  status: (id: string) => ActionStatus,
): ActionStatus {
  if (t.abandoned) return 'abandoned';
  const outputs = t.outputs
    .map((id) => s.artefacts[id])
    .filter((x): x is ArtefactState => !!x);
  const outputsClosed = outputs.every((a) => a.closed);
  const anyRejected = outputs.some((a) => a.status === 'rejected');
  if (t.children.length) {
    const kids = t.children.map(status);
    const finished = kids.every((k) => k === 'done' || k === 'abandoned');
    return finished && outputsClosed ? 'done' : 'decomposed';
  }
  if (t.completed) {
    if (anyRejected) return 'rework';
    return outputsClosed ? 'done' : 'submitted';
  }
  if (t.claimedBy) return 'active';
  if (anyRejected && t.enabled) return 'rework';
  return t.enabled ? 'ready' : 'blocked';
}

/** The coal face: actions an actor can pick up right now. */
export function coalFace(s: State): ActionState[] {
  return Object.values(s.actions)
    .filter((t) => t.status === 'ready' || t.status === 'rework')
    .sort((a, b) => a.seq - b.seq);
}

export function humanQueue(s: State): ActionState[] {
  return coalFace(s).filter((t) => t.requires?.actorKind === 'human');
}

export function agentFace(s: State): ActionState[] {
  return coalFace(s).filter((t) => t.requires?.actorKind !== 'human');
}

export interface Summary {
  actions: Record<ActionStatus, number>;
  artefacts: Record<ArtefactStatus, number>;
  undecomposedLarge: number;
  humanQueue: number;
  agentFace: number;
}

export function summarise(s: State, only?: Set<string>): Summary {
  const actions: Record<ActionStatus, number> = {
    blocked: 0, ready: 0, active: 0, submitted: 0, rework: 0, decomposed: 0, done: 0, abandoned: 0,
  };
  const artefacts: Record<ArtefactStatus, number> = {
    declared: 0, produced: 0, accepted: 0, rejected: 0, invalidated: 0,
  };
  let undecomposedLarge = 0;
  let human = 0;
  let agent = 0;
  for (const t of Object.values(s.actions)) {
    if (only && !only.has(t.id)) continue;
    actions[t.status]++;
    const open = t.status !== 'done' && t.status !== 'abandoned';
    const large = t.size === 'L' || t.size === 'XL' || !t.size;
    if (!t.children.length && open && large && t.requires?.actorKind !== 'human') undecomposedLarge++;
    if (t.status === 'ready' || t.status === 'rework') {
      if (t.requires?.actorKind === 'human') human++;
      else agent++;
    }
  }
  for (const a of Object.values(s.artefacts)) {
    if (only && !only.has(a.id)) continue;
    artefacts[a.status]++;
  }
  return { actions, artefacts, undecomposedLarge, humanQueue: human, agentFace: agent };
}

/** Nearest ancestor action that is decomposed, i.e. renders as a container. */
export function containerOf(s: State, actionId: string | undefined): string | undefined {
  let cur = actionId;
  while (cur) {
    const t = s.actions[cur];
    if (!t) return undefined;
    if (t.children.length) return cur;
    cur = t.parent;
  }
  return undefined;
}

export function depth(s: State, actionId: string): number {
  let d = 0;
  let cur = s.actions[actionId]?.parent;
  while (cur) {
    d++;
    cur = s.actions[cur]?.parent;
  }
  return d;
}
