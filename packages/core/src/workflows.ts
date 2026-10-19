// Workflows are the connected components of the hypergraph. Each is named
// after its top-level action (the goal). Connectivity, not parentage, is the
// boundary: a goal's review action is a top-level sibling that only touches
// the goal through its deliverable, and it belongs inside the frame.

import type { ActionState, Event, State } from './types.js';

export type WorkflowStatus = 'done' | 'abandoned' | 'active' | 'waiting' | 'ready' | 'blocked';

export interface Workflow {
  /** Goal action id, or the first member's id for a goal-less component. */
  id: string;
  title: string;
  seq: number;
  goal?: ActionState;
  actions: string[];
  artefacts: string[];
  /** Terminal artefacts the goal delivers: the end of each output's closedTo chain. */
  deliverables: string[];
  status: WorkflowStatus;
  done: number;
  total: number;
  humanQueue: number;
}

export interface Workflows {
  list: Workflow[];
  /** Entity id (action or artefact) -> workflow id. */
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

export function workflows(s: State): Workflows {
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

  const list: Workflow[] = [];
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
    let status: WorkflowStatus;
    if (!goal) status = 'blocked';
    else if (goal.status === 'done') status = 'done';
    else if (goal.status === 'abandoned') status = 'abandoned';
    else if (live.some((t) => t.status === 'active')) status = 'active';
    else if (humanQueue) status = 'waiting';
    else if (live.some((t) => (t.status === 'ready' || t.status === 'rework') && t.requires?.actorKind !== 'human')) status = 'ready';
    else status = 'blocked';
    const wf: Workflow = {
      id,
      title,
      seq,
      goal,
      actions,
      artefacts,
      deliverables: goal ? [...new Set(goal.outputs.map((o) => terminalOf(s, o)))] : [],
      status,
      done,
      total: live.length,
      humanQueue,
    };
    list.push(wf);
    for (const m of ids) of.set(m, id);
  }
  list.sort((a, b) => a.seq - b.seq);
  return { list, of };
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
