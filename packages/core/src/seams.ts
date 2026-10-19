// Seams are the connected components of the hypergraph: one goal and
// everything connected to it, the thing agents work along (what other trackers
// call a workflow; the coal face is the working end of a seam). Each is named
// after its top-level action (the goal). Connectivity, not parentage, is the
// boundary: a goal's review action is a top-level sibling that only touches
// the goal through its deliverable, and it belongs inside the frame.
//
// A seam is the logical unit and the storage unit (one event stream per
// seam); the composable unit is the fragment (see fragment.ts), an open
// hypergraph with a boundary. Commands refuse edges between seams, so a
// seam only ever grows by composing fragments into it: decompositions
// under an action, policy expansions, and follow-up actions that take its
// delivered artefacts as inputs after it has finished.

import type { ActionState, Event, State } from './types.js';

export type SeamStatus = 'done' | 'abandoned' | 'active' | 'waiting' | 'ready' | 'blocked';

export interface Seam {
  /** Goal action id, or the first member's id for a goal-less component. */
  id: string;
  title: string;
  seq: number;
  goal?: ActionState;
  /** Top-level actions proposed after the goal, taking its deliverables as inputs. */
  followUps: string[];
  actions: string[];
  artefacts: string[];
  /** Terminal artefacts the goal delivers: the end of each output's closedTo chain. */
  deliverables: string[];
  status: SeamStatus;
  done: number;
  total: number;
  humanQueue: number;
}

export interface Seams {
  list: Seam[];
  /** Entity id (action or artefact) -> seam id. */
  of: Map<string, string>;
}

class UnionFind {
  private parent = new Map<string, string>();
  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let cur = x;
    while (this.parent.get(cur) !== r) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, r);
      cur = next;
    }
    return r;
  }
  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Follow closedTo to the terminal artefact. */
export function terminalOf(s: State, id: string): string {
  let cur = id;
  const seen = new Set<string>();
  while (s.artefacts[cur]?.closedTo && !seen.has(cur)) {
    seen.add(cur);
    cur = s.artefacts[cur]!.closedTo!;
  }
  return cur;
}

export function seams(s: State): Seams {
  const uf = new UnionFind();
  for (const id of s.order) uf.add(id);
  for (const t of Object.values(s.actions)) {
    if (t.parent && s.actions[t.parent]) uf.union(t.id, t.parent);
    for (const i of t.inputs) if (s.artefacts[i]) uf.union(t.id, i);
    for (const o of t.outputs) if (s.artefacts[o]) uf.union(t.id, o);
  }
  for (const a of Object.values(s.artefacts)) {
    if (a.parent && s.actions[a.parent]) uf.union(a.id, a.parent);
    if (a.closedTo && s.artefacts[a.closedTo]) uf.union(a.id, a.closedTo);
  }

  const members = new Map<string, string[]>();
  for (const id of s.order) {
    const root = uf.find(id);
    const list = members.get(root);
    if (list) list.push(id);
    else members.set(root, [id]);
  }

  const list: Seam[] = [];
  const of = new Map<string, string>();
  for (const ids of members.values()) {
    const actions = ids.filter((id) => s.actions[id]);
    const artefacts = ids.filter((id) => s.artefacts[id]);
    // Policy-added actions (a goal's review) are proposed before the goal
    // itself, so prefer the earliest top-level action an actor proposed.
    const topLevel = actions
      .map((id) => s.actions[id]!)
      .filter((t) => !t.parent)
      .sort((a, b) => a.seq - b.seq);
    const goal = topLevel.find((t) => !t.expandedFrom) ?? topLevel[0];
    const first = ids[0]!;
    const id = goal?.id ?? first;
    const title = goal?.title ?? s.artefacts[first]?.title ?? first;
    const seq = goal?.seq ?? s.artefacts[first]?.seq ?? 0;
    const live = actions.map((x) => s.actions[x]!).filter((t) => t.status !== 'abandoned');
    const done = live.filter((t) => t.status === 'done').length;
    const humanQueue = live.filter(
      (t) => (t.status === 'ready' || t.status === 'rework') && t.requires?.actorKind === 'human',
    ).length;
    // Follow-ups extend a seam past its goal: top-level, not from policy,
    // and taking inputs (the goal takes none). The seam is finished only
    // when the goal and every live follow-up are.
    const followUps = topLevel.filter((t) => t !== goal && !t.expandedFrom && t.inputs.length > 0);
    const liveTop = topLevel.filter((t) => t.status !== 'abandoned');
    let status: SeamStatus;
    if (!goal) status = 'blocked';
    else if (goal.status === 'done' && liveTop.every((t) => t.status === 'done')) status = 'done';
    else if (goal.status === 'abandoned') status = 'abandoned';
    else if (live.some((t) => t.status === 'active')) status = 'active';
    else if (humanQueue) status = 'waiting';
    else if (live.some((t) => (t.status === 'ready' || t.status === 'rework') && t.requires?.actorKind !== 'human')) status = 'ready';
    else status = 'blocked';
    const deliverers = goal ? [goal, ...followUps] : [];
    const seam: Seam = {
      id,
      title,
      seq,
      goal,
      followUps: followUps.map((t) => t.id),
      actions,
      artefacts,
      deliverables: [...new Set(deliverers.flatMap((t) => t.outputs.map((o) => terminalOf(s, o))))],
      status,
      done,
      total: live.length,
      humanQueue,
    };
    list.push(seam);
    for (const m of ids) of.set(m, id);
  }
  list.sort((a, b) => a.seq - b.seq);
  return { list, of };
}

/**
 * The one seam the given entities belong to, or undefined when none of
 * them exists yet. Throws when they span seams: that would be an edge
 * between seams, which the model forbids (each seam is its own
 * stream, and the union of stream projections must equal the projection of
 * the union).
 */
export function streamOf(s: State, ids: string[], of: Map<string, string> = seams(s).of): string | undefined {
  const found = new Set<string>();
  for (const id of ids) {
    const w = of.get(id);
    if (w) found.add(w);
  }
  if (found.size > 1) {
    const names = [...found].map((w) => `"${s.actions[w]?.title ?? s.artefacts[w]?.title ?? w}"`);
    throw new Error(`these belong to different seams (${names.join(', ')}); an action cannot join seams`);
  }
  return [...found][0];
}

/** The action or artefact an event is about. */
export function eventEntityId(e: Event): string {
  switch (e.type) {
    case 'artefact.declared':
      return e.artefact.id;
    case 'action.proposed':
      return e.action.id;
    default:
      return 'artefactId' in e ? e.artefactId : e.actionId;
  }
}
