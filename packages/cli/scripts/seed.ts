// Seeds a demo workflow so the UI can be exercised without an agent. Writes
// a file log, then imports it into a project on the server when one is
// named. Acts as two agents and one human, with realistic timestamps.
//
//   pnpm --filter @coalface/cli seed --dir <where to write .coalface/events.jsonl>
//   pnpm --filter @coalface/cli seed --project owner/name [--server url]   (also imports)

import * as core from '@coalface/core';
import { Store } from '@coalface/core/node';
import { Client, parseRepo, resolveServer, tokenFor } from '@coalface/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const store = new Store(path.join(arg('dir') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'coalface-seed-')), '.coalface'));
store.init();

const human: core.Actor = { id: 'human:tom', kind: 'human', name: 'tom' };
const a1: core.Actor = { id: 'agent:ab12c', kind: 'agent', name: 'agent ab12c', principal: 'human:tom' };
const a2: core.Actor = { id: 'agent:k9q2z', kind: 'agent', name: 'agent k9q2z', principal: 'human:tom' };

let clock = Date.now() - 1000 * 60 * 90;
const now = () => new Date((clock += 1000 * 37)).toISOString();

function run<T extends core.Result>(actor: core.Actor, fn: (ctx: core.Ctx) => T): T {
  const ctx: core.Ctx = {
    state: store.state(),
    policy: store.policy(),
    actor,
    rung: actor.kind === 'human' ? 'owned' : 'reported',
    now,
  };
  const r = fn(ctx);
  store.append(r.events);
  return r;
}

// Goal 1: passwordless login, mined to completion through a rejection loop.
const g1 = run(a1, (ctx) =>
  core.proposeActions(ctx, {
    actions: [
      {
        title: 'Add passwordless login',
        description: 'Users can sign in with a magic link emailed to them.',
        size: 'L',
        outputs: [
          {
            kind: 'pull-request',
            title: 'Passwordless login PR',
            criteria: ['user can request a magic link', 'link signs the user in once', 'password login still works'],
          },
        ],
      },
    ],
  }),
).actions[0]!;
const prId = g1.outputs[0]!;

run(a1, (ctx) => core.claim(ctx, { actionId: g1.id }));
run(a1, (ctx) =>
  core.evaluate(ctx, {
    actionId: g1.id,
    judgement: 'decompose',
    size: 'L',
    rationale: 'Needs a design decision on token lifetime, a token service, and the endpoint wiring. Not one PR of work.',
    unknowns: ['token lifetime', 'email provider'],
  }),
);
const kids = run(a1, (ctx) =>
  core.proposeActions(ctx, {
    parent: g1.id,
    actions: [
      {
        title: 'Design magic-link flow',
        size: 'S',
        outputs: [{ kind: 'document', title: 'Magic-link design note', criteria: ['states token lifetime', 'states single-use rule'] }],
      },
      {
        title: 'Implement token issuance',
        size: 'M',
        outputs: [{ kind: 'document', title: 'Token service', criteria: ['issues signed single-use tokens', 'unit tests pass'] }],
      },
      {
        title: 'Wire login endpoint',
        size: 'S',
        outputs: [prId],
      },
    ],
  }),
);
const design = kids.actions[0]!;
const tokens = kids.actions[1]!;
const wire = kids.actions[2]!;
run(a1, (ctx) => core.amend(ctx, { actionId: tokens.id, addInputs: [design.outputs[0]!] }));
run(a1, (ctx) => core.amend(ctx, { actionId: wire.id, addInputs: [tokens.outputs[0]!] }));
run(a1, (ctx) => core.release(ctx, { actionId: g1.id, reason: 'decomposed' }));

// Design: ask a question, get an answer, finish.
run(a1, (ctx) => core.claim(ctx, { actionId: design.id }));
run(a1, (ctx) =>
  core.evaluate(ctx, { actionId: design.id, judgement: 'yield', size: 'S', unknowns: ['token lifetime'], rationale: 'Lifetime is a product call.' }),
);
const q = run(a1, (ctx) =>
  core.ask(ctx, {
    actionId: design.id,
    question: 'Should magic links expire after 15 minutes or 1 hour?',
    context: 'Shorter is safer; longer is friendlier for slow email delivery.',
  }),
);
run(human, (ctx) => core.answer(ctx, { questionId: q.questionId, text: '15 minutes. We can revisit if support tickets show up.' }));
run(a1, (ctx) => core.claim(ctx, { actionId: design.id }));
run(a1, (ctx) =>
  core.evaluate(ctx, { actionId: design.id, judgement: 'implement', size: 'S', criteria: ['lifetime 15 min', 'single use', 'bound to email'] }),
);
run(a1, (ctx) => core.progress(ctx, { actionId: design.id, note: 'Wrote the design note: HMAC token, 15 min TTL, consumed on first use.' }));
run(a1, (ctx) => core.attachVersion(ctx, { artefactId: design.outputs[0]!, ref: 'mock:docs/magic-link.md' }));
run(a1, (ctx) => core.complete(ctx, { actionId: design.id }));

// Tokens: a second agent picks it up.
run(a2, (ctx) => core.claim(ctx, { actionId: tokens.id }));
run(a2, (ctx) =>
  core.evaluate(ctx, { actionId: tokens.id, judgement: 'implement', size: 'S', criteria: ['issue()', 'consume() rejects reuse', 'tests'] }),
);
run(a2, (ctx) => core.progress(ctx, { actionId: tokens.id, note: 'Token service with issue/consume and a replay test.' }));
run(a2, (ctx) => core.attachVersion(ctx, { artefactId: tokens.outputs[0]!, ref: 'mock:src/auth/tokens.ts@3f1c2a' }));
run(a2, (ctx) => core.complete(ctx, { actionId: tokens.id }));

// Wire: PR submitted, rejected, reworked, accepted.
run(a1, (ctx) => core.claim(ctx, { actionId: wire.id }));
run(a1, (ctx) => core.evaluate(ctx, { actionId: wire.id, judgement: 'implement', size: 'S', criteria: ['POST /login/magic', 'GET /login/magic/:token'] }));
run(a1, (ctx) => core.progress(ctx, { actionId: wire.id, note: 'Endpoints wired; email sent via existing mailer.' }));
run(a1, (ctx) => core.attachVersion(ctx, { artefactId: prId, ref: 'mock:PR #412 @a81f0e' }));
run(a1, (ctx) => core.complete(ctx, { actionId: wire.id }));
run(human, (ctx) => core.review(ctx, { artefactId: prId, verdict: 'reject', notes: ['no rate limit on link requests', 'missing test for expired link'] }));
run(a1, (ctx) => core.claim(ctx, { actionId: wire.id }));
run(a1, (ctx) => core.progress(ctx, { actionId: wire.id, note: 'Added per-email rate limit and the expiry test.' }));
run(a1, (ctx) => core.attachVersion(ctx, { artefactId: prId, ref: 'mock:PR #412 @c07d44' }));
run(a1, (ctx) => core.complete(ctx, { actionId: wire.id }));
run(human, (ctx) => core.review(ctx, { artefactId: prId, verdict: 'accept', notes: ['nice'] }));

// Goal 2: in flight, to show ready, active, and blocked side by side.
const g2 = run(a2, (ctx) =>
  core.proposeActions(ctx, {
    actions: [
      {
        title: 'Move CI to GitHub Actions',
        size: 'L',
        outputs: [{ kind: 'pull-request', title: 'CI migration PR', criteria: ['all checks green on main', 'old pipeline removed'] }],
      },
    ],
  }),
).actions[0]!;
run(a2, (ctx) => core.claim(ctx, { actionId: g2.id }));
run(a2, (ctx) => core.evaluate(ctx, { actionId: g2.id, judgement: 'decompose', size: 'L', rationale: 'Workflow file and secrets are separable from pipeline removal.' }));
const k2 = run(a2, (ctx) =>
  core.proposeActions(ctx, {
    parent: g2.id,
    actions: [
      { title: 'Write workflow file', size: 'S', outputs: [{ kind: 'document', title: 'ci.yml' }] },
      { title: 'Port secrets', size: 'XS', outputs: [{ kind: 'document', title: 'Secrets checklist' }] },
      { title: 'Remove old pipeline', size: 'S', outputs: [g2.outputs[0]!] },
    ],
  }),
);
run(a2, (ctx) => core.amend(ctx, { actionId: k2.actions[2]!.id, addInputs: [k2.actions[0]!.outputs[0]!, k2.actions[1]!.outputs[0]!] }));
run(a2, (ctx) => core.release(ctx, { actionId: g2.id, reason: 'decomposed' }));
run(a2, (ctx) => core.claim(ctx, { actionId: k2.actions[0]!.id }));
run(a2, (ctx) => core.evaluate(ctx, { actionId: k2.actions[0]!.id, judgement: 'implement', size: 'S', criteria: ['lint, test, build jobs', 'caches pnpm store'] }));
run(a2, (ctx) => core.progress(ctx, { actionId: k2.actions[0]!.id, note: 'Drafting the matrix for node 20 and 22.' }));

console.log(`seeded ${store.readEvents().length} events into ${store.eventsPath}`);
const spec = arg('project');
if (spec) {
  const repo = parseRepo(spec);
  if (!repo) throw new Error('--project must be owner/name');
  const server = resolveServer(arg('server'));
  const client = new Client(server, tokenFor(server));
  let p;
  try {
    p = await client.projectByRepo(repo.owner, repo.name);
  } catch {
    p = await client.createProject(repo.owner, repo.name);
  }
  const r = await client.importEvents(p.id, fs.readFileSync(store.eventsPath, 'utf8'));
  console.log(`imported ${r.imported} events into ${r.streams} stream(s) of ${p.owner}/${p.name} on ${server}`);
} else {
  console.log(core.renderStatus(store.state()));
}
