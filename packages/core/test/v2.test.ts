import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  SCHEMA_VERSION,
  atomFragment,
  claim,
  compose,
  complete,
  decomposeWith,
  evaluate,
  extend,
  fill,
  project,
  proposeActions,
  attachVersion,
  review,
  unionState,
  upcast,
  validateFragment,
  seams,
  type Actor,
  type Ctx,
  type Event,
  type Fragment,
  type Result,
} from '../src/index.js';

const agent: Actor = { id: 'agent:a1', kind: 'agent', principal: 'human:tom' };
const human: Actor = { id: 'human:tom', kind: 'human' };

class Mem {
  events: Event[] = [];
  run<T extends Result>(actor: Actor, fn: (ctx: Ctx) => T): T {
    const ctx: Ctx = { state: project(this.events), policy: DEFAULT_POLICY, actor, rung: actor.kind === 'human' ? 'owned' : 'reported' };
    const r = fn(ctx);
    this.events.push(...r.events);
    return r;
  }
  get state() {
    return project(this.events);
  }
}

function goal(m: Mem, title: string) {
  return m.run(agent, (ctx) =>
    proposeActions(ctx, { actions: [{ title, size: 'L', outputs: [{ kind: 'pull-request', title: `${title} PR` }] }] }),
  ).actions[0]!;
}

/** Drive a goal to done: claim, attach, complete, accept. */
function finish(m: Mem, goalId: string) {
  const pr = m.state.actions[goalId]!.outputs[0]!;
  m.run(agent, (ctx) => claim(ctx, { actionId: goalId }));
  m.run(agent, (ctx) => attachVersion(ctx, { artefactId: pr, ref: 'mock:pr' }));
  m.run(agent, (ctx) => complete(ctx, { actionId: goalId }));
  m.run(human, (ctx) => review(ctx, { artefactId: pr, verdict: 'accept' }));
  return pr;
}

describe('one seam per stream', () => {
  it('refuses an action whose inputs span two seams', () => {
    const m = new Mem();
    const a = goal(m, 'A');
    const b = goal(m, 'B');
    const inA = m.state.actions[a.id]!.outputs[0]!;
    const inB = m.state.actions[b.id]!.outputs[0]!;
    expect(() =>
      m.run(agent, (ctx) => proposeActions(ctx, { actions: [{ title: 'bridge', inputs: [inA, inB], outputs: [] }] })),
    ).toThrow(/different seams/);
  });
  it('refuses amending an action to read another seam', () => {
    const m = new Mem();
    const a = goal(m, 'A');
    const b = goal(m, 'B');
    const inB = m.state.actions[b.id]!.outputs[0]!;
    expect(() => m.run(agent, (ctx) => proposeActions(ctx, { parent: a.id, actions: [{ title: 'child', inputs: [inB] }] }))).toThrow(
      /different seams/,
    );
  });
  it('the union of stream projections is the projection of the union', () => {
    const m = new Mem();
    goal(m, 'A');
    goal(m, 'B');
    const all = m.state;
    const allSeams = seams(all);
    const streams = allSeams.list.map((w) => project(all.events.filter((e) => allSeams.of.get(entity(e)) === w.id)));
    const u = unionState(streams);
    expect(Object.keys(u.actions).sort()).toEqual(Object.keys(all.actions).sort());
    expect(u.order).toEqual(all.order);
    for (const id of Object.keys(all.actions)) expect(u.actions[id]!.status).toBe(all.actions[id]!.status);
  });
});

function entity(e: Event): string {
  if (e.type === 'artefact.declared') return e.artefact.id;
  if (e.type === 'action.proposed') return e.action.id;
  return 'artefactId' in e ? e.artefactId : e.actionId;
}

describe('follow-ups', () => {
  it('a finished seam reopens when a follow-up takes its deliverable as input', () => {
    const m = new Mem();
    const g = goal(m, 'Ship login');
    const pr = finish(m, g.id);
    let w = seams(m.state).list[0]!;
    expect(w.status).toBe('done');
    const terminal = m.state.artefacts[pr]!.closedTo!;
    const f = m.run(agent, (ctx) =>
      proposeActions(ctx, { actions: [{ title: 'Add rate limiting', size: 'S', inputs: [terminal], outputs: [{ kind: 'pull-request', title: 'rate limit PR' }] }] }),
    ).actions[0]!;
    const s = m.state;
    w = seams(s).list[0]!;
    expect(seams(s).list).toHaveLength(1);
    expect(w.followUps).toEqual([f.id]);
    expect(w.status).toBe('ready');
    expect(s.actions[f.id]!.status).toBe('ready');
    expect(w.deliverables).toHaveLength(2);
    finish(m, f.id);
    expect(seams(m.state).list[0]!.status).toBe('done');
  });
});

describe('fragments', () => {
  const design: Fragment = {
    inputs: ['brief'],
    outputs: ['note'],
    artefacts: { note: { kind: 'document', title: 'Design note' } },
    actions: [{ title: 'Design it', size: 'S', inputs: ['brief'], outputs: ['note'] }],
  };
  const build: Fragment = {
    inputs: ['note'],
    outputs: ['pr'],
    artefacts: { pr: { kind: 'pull-request', title: 'The PR' } },
    actions: [{ title: 'Build it', size: 'M', inputs: ['note'], outputs: ['pr'] }],
  };
  it('validates boundaries', () => {
    expect(validateFragment(design)).toEqual([]);
    expect(validateFragment({ ...design, outputs: ['nope'] })).toContain('output port "nope" names nothing inside the fragment');
    expect(validateFragment({ ...design, actions: [{ title: 'x', inputs: ['brief'], outputs: ['brief'] }] })).toContain(
      'action "x" writes input port "brief"',
    );
  });
  it('composes along a shared boundary', () => {
    const both = compose(design, build);
    expect(both.inputs).toEqual(['brief']);
    expect(both.outputs).toEqual(['pr']);
    expect(Object.keys(both.artefacts).sort()).toEqual(['note', 'pr']);
    expect(both.actions.map((a) => a.title)).toEqual(['Design it', 'Build it']);
    expect(validateFragment(both)).toEqual([]);
    expect(() => compose(design, build, { note: 'missing' })).toThrow(/not an output port/);
  });
  it('an atom is a fragment', () => {
    const f = atomFragment(DEFAULT_POLICY.atoms['pull-request']!, (t) => fill(t, { title: 'login' }));
    expect(validateFragment(f)).toEqual([]);
    expect(f.actions[0]!.requires?.actorKind).toBe('human');
    expect(f.artefacts.terminal!.kind).toBe('reviewed-pull-request');
  });
  it('decomposes an action with a fragment bound to its boundary', () => {
    const m = new Mem();
    const g = m.run(agent, (ctx) =>
      proposeActions(ctx, {
        actions: [{ title: 'Feature', size: 'L', outputs: [{ kind: 'pull-request', title: 'Feature PR', criteria: ['works'] }] }],
      }),
    ).actions[0]!;
    m.run(agent, (ctx) => evaluate(ctx, { actionId: g.id, judgement: 'decompose', size: 'L' }));
    const brief = m.run(agent, (ctx) => proposeActions(ctx, { parent: g.id, actions: [{ title: 'Brief', size: 'XS', outputs: [{ kind: 'document', title: 'Brief' }] }] }))
      .actions[0]!.outputs[0]!;
    const r = m.run(agent, (ctx) => decomposeWith(ctx, { parent: g.id, fragment: compose(design, build), bind: { brief } }));
    const s = m.state;
    // The output port took the parent's deliverable; the inner note is new.
    expect(r.artefacts.pr).toBe(s.actions[g.id]!.outputs[0]);
    expect(s.artefacts[r.artefacts.note!]!.parent).toBe(g.id);
    const [d, b] = r.actions;
    expect(s.actions[d!.id]!.inputs).toEqual([brief]);
    expect(s.actions[b!.id]!.inputs).toEqual([r.artefacts.note]);
    expect(s.actions[b!.id]!.outputs).toEqual([r.artefacts.pr]);
    expect(s.actions[g.id]!.status).toBe('decomposed');
    expect(seams(s).list).toHaveLength(1);
    expect(() => m.run(agent, (ctx) => decomposeWith(ctx, { parent: g.id, fragment: design }))).toThrow(/not bound/);
  });
});

describe('the log is a set', () => {
  it('projects the same state from any arrival order', () => {
    const m = new Mem();
    const g = goal(m, 'Order');
    finish(m, g.id);
    const numbered = m.events.map((e, i) => ({ ...e, seq: i }));
    const expected = project(numbered);
    const shuffled = [...numbered].sort(() => Math.random() - 0.5);
    const got = project(shuffled);
    expect(JSON.stringify(got.actions)).toBe(JSON.stringify(expected.actions));
    expect(JSON.stringify(got.artefacts)).toBe(JSON.stringify(expected.artefacts));
    expect(got.order).toEqual(expected.order);
  });
  it('extend advances a snapshot to the same state as a full replay', () => {
    const m = new Mem();
    const g = goal(m, 'Extend');
    const numbered = () => m.events.map((e, i) => ({ ...e, seq: i }));
    const snapshot = project(numbered());
    const before = m.events.length;
    finish(m, g.id);
    const later = numbered().slice(before);
    extend(snapshot, later);
    const full = project(numbered());
    expect(JSON.stringify(snapshot.actions)).toBe(JSON.stringify(full.actions));
    expect(JSON.stringify(snapshot.artefacts)).toBe(JSON.stringify(full.artefacts));
  });
});

describe('event versions', () => {
  it('commands write the current schema version', () => {
    const m = new Mem();
    goal(m, 'V');
    expect(m.events.every((e) => e.v === SCHEMA_VERSION)).toBe(true);
  });
  it('upcasts an unversioned MVP event and refuses a future one', () => {
    const raw = { type: 'action.claimed', actionId: 't-1', id: 'e-1', ts: 't', actor: human, rung: 'owned' };
    expect(upcast(raw).v).toBe(SCHEMA_VERSION);
    expect(() => upcast({ ...raw, v: SCHEMA_VERSION + 1 })).toThrow(/schema v/);
  });
});
