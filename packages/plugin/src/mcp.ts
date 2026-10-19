// Coalface MCP server: the reporting verbs an agent uses to keep the workflow
// state in step with what it is doing. Every tool appends events; nothing
// here touches the repository.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as core from '@coalface/core';
import { Store, agentActor } from '@coalface/core/node';

const store = Store.resolve(process.cwd());
const me = agentActor();

const server = new McpServer({ name: 'coalface', version: '0.1.0' });

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

function faceLine(s: core.State): string {
  const face = core.agentFace(s);
  if (!face.length) {
    const hq = core.humanQueue(s);
    return hq.length
      ? `Agent coal face is empty; ${hq.length} action(s) wait on humans: ${hq.map((t) => t.id).join(', ')}.`
      : 'Agent coal face is empty.';
  }
  return (
    'Agent coal face now: ' +
    face.map((t) => `${t.id} "${t.title}"${t.size ? ` [${t.size}]` : ''}`).join('; ')
  );
}

const principal: core.Actor | undefined = me.principal ? { id: me.principal, kind: 'human' } : undefined;

function mutate<T extends core.Result>(
  fn: (ctx: core.Ctx) => T,
  describe: (r: T) => string,
  onBehalfOf?: core.Actor,
): ToolResult {
  try {
    const r = store.run(me, 'reported', fn, onBehalfOf);
    const lines = [describe(r)];
    if (r.warnings.length) lines.push(`Warnings: ${r.warnings.join('; ')}`);
    lines.push(faceLine(store.state()));
    return text(lines.join('\n'));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const Size = z.enum(core.SIZES);
const Judgement = z.enum(core.JUDGEMENTS);
const OutputSpec = z.union([
  z.string().describe('id of an existing artefact'),
  z.object({
    kind: z.string().describe('artefact kind, e.g. pull-request, document, decision, plan'),
    title: z.string(),
    criteria: z.array(z.string()).optional().describe('testable acceptance criteria, Markdown, one per item'),
  }),
]);

server.registerTool(
  'status',
  {
    title: 'Coalface status',
    description:
      'Show the workflow: your held actions, the coal face (actions ready for an agent), actions waiting on humans, blocked actions, and decomposed actions in progress. Call this first.',
    inputSchema: {},
  },
  async () => {
    try {
      if (!store.exists()) {
        return text(
          `You are ${me.id}. No workflow exists in this project yet (log would be ${store.eventsPath}). Start one by proposing a top-level action for the goal with a concrete output artefact.`,
        );
      }
      return text(`You are ${me.id}.\n${core.renderStatus(store.state(), me)}`);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  'inspect',
  {
    title: 'Inspect an action or artefact',
    description: 'Full detail for one action (t-...) or artefact (a-...): description, criteria, evaluation, inputs and outputs, children, versions, and history.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const s = store.state();
    const t = s.actions[id];
    if (t) {
      const lines = [core.describeAction(s, t, true)];
      // The listing flattens prose; the full Markdown follows when it has structure.
      if (t.description && t.description.includes('\n')) lines.push('  description (Markdown):', ...t.description.split('\n').map((l) => `    ${l}`));
      lines.push(`  history:`);
      for (const l of t.log) lines.push(`    #${l.seq} ${l.actor.id} ${l.type}${l.note ? `: ${l.note}` : ''}`);
      return text(lines.join('\n'));
    }
    const a = s.artefacts[id];
    if (a) {
      const lines = [`${a.id} "${a.title}" <${a.kind}> ${a.status}`];
      if (a.criteria?.length) lines.push(`  criteria: ${a.criteria.join(' | ')}`);
      if (a.parent) lines.push(`  parent: ${a.parent}`);
      if (a.closedTo) lines.push(`  closed by: ${a.closedTo} (${s.artefacts[a.closedTo]?.status})`);
      if (a.rejections.length) lines.push(`  rejection: ${a.rejections.join(' | ')}`);
      for (const v of a.versions) lines.push(`  version #${v.seq} by ${v.by.id}: ${v.ref}${v.note ? ` (${v.note})` : ''}`);
      const producers = Object.values(s.actions).filter((x) => x.outputs.includes(a.id)).map((x) => x.id);
      const consumers = Object.values(s.actions).filter((x) => x.inputs.includes(a.id)).map((x) => x.id);
      if (producers.length) lines.push(`  produced by: ${producers.join(', ')}`);
      if (consumers.length) lines.push(`  consumed by: ${consumers.join(', ')}`);
      return text(lines.join('\n'));
    }
    return fail(`no action or artefact with id ${id}`);
  },
);

server.registerTool(
  'propose',
  {
    title: 'Propose actions',
    description:
      'Add actions to the workflow. With no parent this starts a top-level goal; with a parent it decomposes that action into children (call evaluate with judgement "decompose" first). Outputs may be existing artefact ids or new artefacts declared inline; declaring a pull-request or question automatically adds the human review or answer step required by policy. Inputs are artefact ids the action needs before it can start.',
    inputSchema: {
      parent: z.string().optional().describe('action id being decomposed'),
      actions: z
        .array(
          z.object({
            title: z.string().describe('plain text, one line'),
            description: z.string().optional().describe('Markdown'),
            size: Size.optional(),
            inputs: z.array(z.string()).optional(),
            outputs: z.array(OutputSpec).optional(),
          }),
        )
        .min(1),
    },
  },
  async (args) =>
    mutate(
      (ctx) => core.proposeActions(ctx, args),
      (r) =>
        'Proposed:\n' +
        r.actions
          .map((a) => `- ${a.id} "${a.title}" outputs: ${a.outputs.join(', ') || 'none'}${a.inputs.length ? ` inputs: ${a.inputs.join(', ')}` : ''}`)
          .join('\n'),
    ),
);

server.registerTool(
  'evaluate',
  {
    title: 'Record an evaluation',
    description:
      'Record your judgement of an action before working on it: implement (small enough, criteria stated), decompose (too large; follow with propose using this action as parent), yield (needs a human; follow with ask), or abandon. Always give a size. Sizes L and XL must be decomposed.',
    inputSchema: {
      actionId: z.string(),
      judgement: Judgement,
      size: Size.optional(),
      criteria: z.array(z.string()).optional().describe('testable statements of done, for implement; Markdown, one per item'),
      unknowns: z.array(z.string()).optional().describe('open questions or risks; Markdown, one per item'),
      rationale: z.string().optional().describe('Markdown'),
    },
  },
  async (args) => mutate((ctx) => core.evaluate(ctx, args), () => `Evaluated ${args.actionId}: ${args.judgement}${args.size ? ` (${args.size})` : ''}.`),
);

server.registerTool(
  'claim',
  {
    title: 'Claim an action',
    description: 'Take an action from the coal face before working on it. Fails if another agent holds it unless force is set, which is only for sessions known to be dead.',
    inputSchema: { actionId: z.string(), force: z.boolean().optional() },
  },
  async (args) => mutate((ctx) => core.claim(ctx, args), () => `Claimed ${args.actionId}.`),
);

server.registerTool(
  'release',
  {
    title: 'Release an action',
    description: 'Give up a claim without completing, e.g. when stopping for the turn or handing over.',
    inputSchema: { actionId: z.string(), reason: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate((ctx) => core.release(ctx, args), () => `Released ${args.actionId}.`),
);

server.registerTool(
  'progress',
  {
    title: 'Note progress',
    description: 'Append a short progress note to an action you hold. One or two sentences about what was just done or decided.',
    inputSchema: { actionId: z.string(), note: z.string().describe('Markdown') },
  },
  async (args) => mutate((ctx) => core.progress(ctx, args), () => `Noted on ${args.actionId}.`),
);

server.registerTool(
  'attach',
  {
    title: 'Attach an artefact version',
    description:
      'Record that an artefact now exists or has a new version. ref is a pointer to it: a commit SHA, PR number, file path, URL, or for mocked work a short "mock:" description. A new version clears an earlier rejection.',
    inputSchema: { artefactId: z.string(), ref: z.string(), note: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate((ctx) => core.attachVersion(ctx, args), () => `Attached version to ${args.artefactId}.`),
);

server.registerTool(
  'complete',
  {
    title: 'Complete an action',
    description: 'Mark an action finished. Attach versions to its outputs first. If an output needs human review, the action shows as submitted until the review lands.',
    inputSchema: { actionId: z.string(), note: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate((ctx) => core.complete(ctx, args), () => `Completed ${args.actionId}.`),
);

server.registerTool(
  'ask',
  {
    title: 'Ask a human',
    description:
      'Yield an action to a human with a question. Declares the question, blocks the action on the answer, and releases your claim. Stop working on that action until status shows it ready again.',
    inputSchema: {
      actionId: z.string(),
      question: z.string().describe('one plain sentence; it becomes the title'),
      context: z.string().optional().describe('what you considered and why you cannot decide; Markdown'),
    },
  },
  async (args) => mutate((ctx) => core.ask(ctx, args), (r) => `Asked ${r.questionId}; ${args.actionId} is blocked on ${r.answerId} and released.`),
);

server.registerTool(
  'amend',
  {
    title: 'Amend an action',
    description:
      'Change an action\'s interface after discovering more: add or remove inputs and outputs, resize, or retitle. Use when implementation reveals a missing dependency or deliverable.',
    inputSchema: {
      actionId: z.string(),
      addInputs: z.array(z.string()).optional(),
      removeInputs: z.array(z.string()).optional(),
      addOutputs: z.array(OutputSpec).optional(),
      removeOutputs: z.array(z.string()).optional(),
      size: Size.optional(),
      title: z.string().optional(),
    },
  },
  async (args) =>
    mutate(
      (ctx) => core.amend(ctx, args),
      (r) => `Amended ${args.actionId}.${r.addedOutputs.length ? ` New outputs: ${r.addedOutputs.join(', ')}` : ''}`,
    ),
);

server.registerTool(
  'abandon',
  {
    title: 'Abandon an action',
    description: 'Drop an action that should not be done. Say why. Prefer this over leaving dead actions on the face.',
    inputSchema: { actionId: z.string(), reason: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate((ctx) => core.abandon(ctx, args), () => `Abandoned ${args.actionId}.`),
);

server.registerTool(
  'restore',
  {
    title: 'Restore an abandoned action',
    description: 'Undo an abandonment: the action returns to the face as its inputs allow. For an action abandoned by mistake, or one that circumstances brought back.',
    inputSchema: { actionId: z.string(), note: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate((ctx) => core.restore(ctx, args), () => `Restored ${args.actionId}.`),
);

server.registerTool(
  'reopen',
  {
    title: 'Reopen a completed action',
    description: 'Undo a completion: the action is workable again and its outputs keep their versions. For when more work turned out to be needed.',
    inputSchema: { actionId: z.string(), note: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate((ctx) => core.reopen(ctx, args), () => `Reopened ${args.actionId}.`),
);

server.registerTool(
  'declare',
  {
    title: 'Declare an artefact',
    description:
      'Declare a standalone artefact such as a decision record or plan, optionally with initial content as its first version. Usually outputs are declared inline via propose instead.',
    inputSchema: {
      kind: z.string(),
      title: z.string(),
      criteria: z.array(z.string()).optional().describe('Markdown, one per item'),
      parent: z.string().optional().describe('grouping action'),
      content: z.string().optional().describe('Markdown'),
    },
  },
  async (args) =>
    mutate(
      (ctx) => core.declareArtefact(ctx, args),
      (r) => `Declared ${r.id}.${r.terminalId ? ` Policy added ${r.atomActionId} producing ${r.terminalId}.` : ''}`,
    ),
);

server.registerTool(
  'answer',
  {
    title: 'Relay a human answer',
    description:
      'Record an answer the human gave you in chat to one of your questions, on their behalf. The log attributes the answer to the human with you as the relay. Only for questions; never invent an answer, and never use this for pull-request reviews.',
    inputSchema: { questionId: z.string().describe('the question artefact id (a-...)'), text: z.string().describe('the answer as given; Markdown') },
  },
  async (args) =>
    mutate(
      (ctx) => core.answer(ctx, args),
      () => `Recorded the answer to ${args.questionId} on behalf of ${principal?.id ?? 'your principal'}.`,
      principal,
    ),
);

server.registerTool(
  'review',
  {
    title: 'Relay a human verdict',
    description:
      'Record an accept or reject verdict the human gave you in chat, on their behalf. Policy decides which artefact kinds allow this; pull requests do not by default, and the tool will say so. Never use it without an explicit verdict from the human.',
    inputSchema: {
      artefactId: z.string(),
      verdict: z.enum(['accept', 'reject']),
      notes: z.array(z.string()).optional().describe('Markdown, one per item'),
    },
  },
  async (args) =>
    mutate(
      (ctx) => core.review(ctx, args),
      () => `Recorded ${args.verdict} for ${args.artefactId} on behalf of ${principal?.id ?? 'your principal'}.`,
      principal,
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`coalface mcp ready as ${me.id}, log ${store.eventsPath}\n`);
