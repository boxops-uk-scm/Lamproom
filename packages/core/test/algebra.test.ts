import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  abandon,
  agentFace,
  answer,
  ask,
  claim,
  coalFace,
  complete,
  evaluate,
  humanQueue,
  project,
  proposeActions,
  attachVersion,
  reopen,
  restore,
  review,
  validatePolicy,
  seams,
  type Actor,
  type Ctx,
  type Event,
  type Result,
} from '../src/index.js';

const agent: Actor = { id: 'agent:a1', kind: 'agent', principal: 'human:tom' };
const human: Actor = { id: 'human:tom', kind: 'human' };

/** Tiny in-memory store so tests read like a session transcript. */
class Mem {
  events: Event[] = [];
  run<T extends Result>(actor: Actor, fn: (ctx: Ctx) => T, onBehalfOf?: Actor): T {
    const ctx: Ctx = {
      state: project(this.events),
      policy: DEFAULT_POLICY,
      actor,
      rung: actor.kind === 'human' ? 'owned' : 'reported',
      onBehalfOf,
    };
    const r = fn(ctx);
    this.events.push(...r.events);
    return r;
  }
  get state() {
    return project(this.events);
  }
}

function seed(m: Mem) {
  // A top-level goal whose deliverable is a pull request.
  return m.run(agent, (ctx) =>
    proposeActions(ctx, {
      actions: [
        {
          title: 'Add login',
          size: 'L',
          outputs: [{ kind: 'pull-request', title: 'login PR', criteria: ['users can log in'] }],
        },
      ],
    }),
  );
}

describe('policy', () => {
  it('default policy is well-founded', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
  });
  it('detects atom cycles', () => {
    const bad = {
      atoms: {
        a: { terminal: 'b', action: { title: 'x', requires: { actorKind: 'human' as const } } },
        b: { terminal: 'a', action: { title: 'y', requires: { actorKind: 'human' as const } } },
      },
    };
    expect(validatePolicy(bad).length).toBeGreaterThan(0);
  });
});

describe('atom expansion', () => {
  it('declaring a pull request inserts a human review and a terminal', () => {
    const m = new Mem();
    const r = seed(m);
    const s = m.state;
    const goal = s.actions[r.actions[0]!.id]!;
    const pr = s.artefacts[goal.outputs[0]!]!;
    expect(pr.kind).toBe('pull-request');
    expect(pr.closedTo).toBeDefined();
    const terminal = s.artefacts[pr.closedTo!]!;
    expect(terminal.kind).toBe('reviewed-pull-request');
    expect(terminal.expandedFrom).toBe(pr.id);
    const rev = Object.values(s.actions).find((t) => t.expandedFrom === pr.id)!;
    expect(rev.requires).toEqual({ actorKind: 'human', count: 1 });
    expect(rev.inputs).toEqual([pr.id]);
    expect(rev.outputs).toEqual([terminal.id]);
    expect(rev.status).toBe('blocked');
    // The goal itself is ready (no inputs) and on the agent face.
    expect(goal.status).toBe('ready');
    expect(agentFace(s).map((t) => t.id)).toEqual([goal.id]);
  });
});

describe('coal face loop', () => {
  it('decompose, implement, review, reject, rework, accept', () => {
    const m = new Mem();
    const goalId = seed(m).actions[0]!.id;
    const prId = m.state.actions[goalId]!.outputs[0]!;

    // Evaluate: too big, decompose.
    m.run(agent, (ctx) => evaluate(ctx, { actionId: goalId, judgement: 'decompose', size: 'L', rationale: 'two concerns' }));
    const kids = m.run(agent, (ctx) =>
      proposeActions(ctx, {
        parent: goalId,
        actions: [
          { title: 'Schema', size: 'S', outputs: [{ kind: 'document', title: 'users table' }] },
          { title: 'Handler', size: 'S', inputs: [], outputs: [prId] },
        ],
      }),
    );
    const schema = kids.actions[0]!.id;
    const handler = kids.actions[1]!.id;
    // Handler depends on schema's output.
    const schemaDoc = kids.actions[0]!.outputs[0]!;
    m.events.push({
      type: 'action.amended', actionId: handler, addInputs: [schemaDoc],
      id: 'e1', ts: 't', actor: agent, rung: 'reported',
    });

    let s = m.state;
    expect(s.actions[goalId]!.status).toBe('decomposed');
    expect(coalFace(s).map((t) => t.id)).toEqual([schema]);
    expect(s.actions[handler]!.status).toBe('blocked');

    // Do schema.
    m.run(agent, (ctx) => claim(ctx, { actionId: schema }));
    expect(m.state.actions[schema]!.status).toBe('active');
    m.run(agent, (ctx) => attachVersion(ctx, { artefactId: schemaDoc, ref: 'v1' }));
    m.run(agent, (ctx) => complete(ctx, { actionId: schema }));
    s = m.state;
    expect(s.actions[schema]!.status).toBe('done');
    expect(coalFace(s).map((t) => t.id)).toEqual([handler]);

    // Do handler, which produces the PR; review becomes a human action.
    m.run(agent, (ctx) => claim(ctx, { actionId: handler }));
    m.run(agent, (ctx) => attachVersion(ctx, { artefactId: prId, ref: 'sha1' }));
    const c = m.run(agent, (ctx) => complete(ctx, { actionId: handler }));
    expect(c.warnings).toEqual([]);
    s = m.state;
    expect(s.actions[handler]!.status).toBe('submitted');
    expect(humanQueue(s).length).toBe(1);
    expect(agentFace(s).length).toBe(0);
    const reviewAction = humanQueue(s)[0]!;
    expect(() => m.run(agent, (ctx) => claim(ctx, { actionId: reviewAction.id }))).toThrow(/requires a human/);

    // Human rejects: handler goes to rework and back onto the face.
    m.run(human, (ctx) => review(ctx, { artefactId: prId, verdict: 'reject', notes: ['no tests'] }));
    s = m.state;
    expect(s.artefacts[prId]!.status).toBe('rejected');
    expect(s.actions[handler]!.status).toBe('rework');
    expect(agentFace(s).map((t) => t.id)).toEqual([handler]);
    expect(humanQueue(s).length).toBe(0);

    // Rework: new version clears the rejection, resubmit, accept.
    m.run(agent, (ctx) => claim(ctx, { actionId: handler }));
    m.run(agent, (ctx) => attachVersion(ctx, { artefactId: prId, ref: 'sha2' }));
    m.run(agent, (ctx) => complete(ctx, { actionId: handler }));
    s = m.state;
    expect(s.actions[handler]!.status).toBe('submitted');
    m.run(human, (ctx) => review(ctx, { artefactId: prId, verdict: 'accept' }));
    s = m.state;
    expect(s.artefacts[prId]!.closed).toBe(true);
    expect(s.actions[handler]!.status).toBe('done');
    expect(s.actions[reviewAction.id]!.status).toBe('done');
    expect(s.actions[goalId]!.status).toBe('done');
    expect(s.warnings).toEqual([]);
  });

  it('asking a question blocks the action until a human answers', () => {
    const m = new Mem();
    const goalId = seed(m).actions[0]!.id;
    m.run(agent, (ctx) => claim(ctx, { actionId: goalId }));
    const q = m.run(agent, (ctx) => ask(ctx, { actionId: goalId, question: 'OAuth or password?' }));
    let s = m.state;
    expect(s.actions[goalId]!.status).toBe('blocked');
    expect(s.actions[goalId]!.claimedBy).toBeUndefined();
    expect(s.artefacts[q.questionId]!.status).toBe('produced');
    const answerAction = humanQueue(s)[0]!;
    expect(answerAction.inputs).toEqual([q.questionId]);
    m.run(human, (ctx) => answer(ctx, { questionId: q.questionId, text: 'password first' }));
    s = m.state;
    expect(s.artefacts[q.answerId]!.status).toBe('accepted');
    expect(s.actions[answerAction.id]!.status).toBe('done');
    expect(s.actions[goalId]!.status).toBe('ready');
  });

  it('humans pre-empt agent claims; agents cannot', () => {
    const m = new Mem();
    const goalId = seed(m).actions[0]!.id;
    m.run(agent, (ctx) => claim(ctx, { actionId: goalId }));
    const other: Actor = { id: 'agent:a2', kind: 'agent' };
    expect(() => m.run(other, (ctx) => claim(ctx, { actionId: goalId }))).toThrow(/held by/);
    m.run(human, (ctx) => claim(ctx, { actionId: goalId }));
    expect(m.state.actions[goalId]!.claimedBy?.id).toBe('human:tom');
  });
});

describe('relaying human decisions', () => {
  it('an agent can relay its principal\'s answer, attributed to the human via the agent', () => {
    const m = new Mem();
    const goalId = seed(m).actions[0]!.id;
    m.run(agent, (ctx) => claim(ctx, { actionId: goalId }));
    const q = m.run(agent, (ctx) => ask(ctx, { actionId: goalId, question: 'OAuth or password?' }));
    // Agents cannot sneak an answer in through attach.
    expect(() => m.run(agent, (ctx) => attachVersion(ctx, { artefactId: q.answerId, ref: 'password' }))).toThrow(/produced by a human/);
    // Nor relay for someone other than their principal.
    const stranger: Actor = { id: 'human:eve', kind: 'human' };
    expect(() => m.run(agent, (ctx) => answer(ctx, { questionId: q.questionId, text: 'x' }), stranger)).toThrow(/principal/);
    m.run(agent, (ctx) => answer(ctx, { questionId: q.questionId, text: 'password first' }), human);
    const s = m.state;
    const ans = s.artefacts[q.answerId]!;
    expect(ans.status).toBe('accepted');
    expect(ans.acceptedBy[0]!.id).toBe('human:tom');
    expect(ans.versions[0]!.by.id).toBe('human:tom');
    expect(ans.versions[0]!.via?.id).toBe('agent:a1');
    expect(s.actions[goalId]!.status).toBe('ready');
  });

  it('pull-request reviews cannot be relayed', () => {
    const m = new Mem();
    const goalId = seed(m).actions[0]!.id;
    const prId = m.state.actions[goalId]!.outputs[0]!;
    m.run(agent, (ctx) => claim(ctx, { actionId: goalId }));
    m.run(agent, (ctx) => attachVersion(ctx, { artefactId: prId, ref: 'sha1' }));
    m.run(agent, (ctx) => complete(ctx, { actionId: goalId }));
    expect(() => m.run(agent, (ctx) => review(ctx, { artefactId: prId, verdict: 'accept' }), human)).toThrow(/cannot be relayed/);
    const reviewAction = humanQueue(m.state)[0]!;
    expect(() => m.run(agent, (ctx) => complete(ctx, { actionId: reviewAction.id }))).toThrow(/requires a human/);
  });
});

describe('seams', () => {
  it('each goal is one component, including policy siblings and questions', () => {
    const m = new Mem();
    const g1 = seed(m).actions[0]!.id;
    const g2 = m.run(agent, (ctx) =>
      proposeActions(ctx, { actions: [{ title: 'Second goal', size: 'L', outputs: [{ kind: 'pull-request', title: 'second PR' }] }] }),
    ).actions[0]!.id;
    m.run(agent, (ctx) => claim(ctx, { actionId: g1 }));
    const q = m.run(agent, (ctx) => ask(ctx, { actionId: g1, question: 'Which?' }));
    const s = m.state;
    const w = seams(s);
    expect(w.list.map((x) => x.id)).toEqual([g1, g2]);
    const first = w.list[0]!;
    // Review action for the PR and the question's answer action are top-level siblings but belong to goal 1.
    const review = Object.values(s.actions).find((t) => t.title.startsWith('Review:') && t.inputs.includes(s.actions[g1]!.outputs[0]!))!;
    expect(w.of.get(review.id)).toBe(g1);
    expect(w.of.get(q.questionId)).toBe(g1);
    expect(w.of.get(q.answerId)).toBe(g1);
    expect(first.deliverables).toEqual([s.artefacts[s.actions[g1]!.outputs[0]!]!.closedTo]);
    expect(first.status).toBe('waiting');
    expect(w.list[1]!.status).toBe('ready');
  });
});

describe('event sourcing', () => {
  it('any prefix of the log projects to a consistent state', () => {
    const m = new Mem();
    const goalId = seed(m).actions[0]!.id;
    m.run(agent, (ctx) => claim(ctx, { actionId: goalId }));
    m.run(agent, (ctx) => attachVersion(ctx, { artefactId: m.state.actions[goalId]!.outputs[0]!, ref: 'sha' }));
    m.run(agent, (ctx) => complete(ctx, { actionId: goalId }));
    const statuses = [];
    for (let n = 0; n <= m.events.length; n++) {
      const s = project(m.events.slice(0, n));
      expect(s.warnings).toEqual([]);
      statuses.push(s.actions[goalId]?.status ?? '-');
    }
    expect(statuses[0]).toBe('-');
    expect(statuses[statuses.length - 1]).toBe('submitted');
    expect(statuses).toContain('active');
  });
});

describe('undo', () => {
  it('restores an abandoned action to the face', () => {
    const m = new Mem();
    const goal = seed(m).actions[0]!.id;
    m.run(human, (ctx) => abandon(ctx, { actionId: goal, reason: 'slip of the hand' }));
    expect(m.state.actions[goal]!.status).toBe('abandoned');
    expect(coalFace(m.state).map((t) => t.id)).not.toContain(goal);
    m.run(human, (ctx) => restore(ctx, { actionId: goal }));
    const t = m.state.actions[goal]!;
    expect(t.status).toBe('ready');
    expect(t.abandoned).toBeUndefined();
    expect(coalFace(m.state).map((x) => x.id)).toContain(goal);
    expect(t.log.map((l) => l.type)).toEqual(['action.abandoned', 'action.restored']);
    expect(() => m.run(human, (ctx) => restore(ctx, { actionId: goal }))).toThrow(/not abandoned/);
  });

  it('reopens a completed action without touching its outputs', () => {
    const m = new Mem();
    const goal = seed(m).actions[0]!.id;
    const pr = m.state.actions[goal]!.outputs[0]!;
    m.run(agent, (ctx) => claim(ctx, { actionId: goal }));
    m.run(agent, (ctx) => attachVersion(ctx, { artefactId: pr, ref: 'mock:PR #1' }));
    m.run(agent, (ctx) => complete(ctx, { actionId: goal }));
    expect(m.state.actions[goal]!.status).toBe('submitted');
    m.run(human, (ctx) => reopen(ctx, { actionId: goal, note: 'tests missing' }));
    const t = m.state.actions[goal]!;
    expect(t.status).toBe('ready');
    expect(m.state.artefacts[pr]!.versions).toHaveLength(1);
    expect(() => m.run(human, (ctx) => reopen(ctx, { actionId: goal }))).toThrow(/not completed/);
  });
});
