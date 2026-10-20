// Lamproom MCP server: the reporting verbs an agent uses to keep a seam
// state in step with what it is doing. Every tool appends events; nothing
// here touches the repository.
//
// With LAMPROOM_DRY_RUN=1 the verbs that would append events are traced to
// LAMPROOM_DRY_RUN_LOG and sent nowhere. Reads still reach the server, so a
// prompt under test sees the real graph, and provisional ids let the agent
// carry on past a propose and show the rest of what it would have done.

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as core from '@lamproom/core';
import { Client, ClientError, resolveProject, resolveServer, tokenFor, type CommandResponse, type Project } from '@lamproom/client';
import { describeMode, modeTrace, readMode, repoRoot, writeMode } from './autotrack.js';

// The agent is a label under the signed-in human's token; the server
// stamps every event with agent:<label> and the human as principal.
const label = process.env.LAMPROOM_AGENT ?? Math.random().toString(36).slice(2, 7);
const serverUrl = resolveServer();
const client = new Client(serverUrl, tokenFor(serverUrl));
const meId = `agent:${label}`;

const envDryRun = process.env.LAMPROOM_DRY_RUN === '1';
const envTrace = process.env.LAMPROOM_DRY_RUN_LOG;

/**
 * Whether this call is a rehearsal, and where to trace it. Two sources: the
 * environment, set by the tracker when the dry-run driver spawns it, and the
 * repository's own mode, set by /lamproom:dry-run. The mode is read per call,
 * not once at startup, so switching it takes effect on the very next tool
 * call of a live session rather than at the next restart.
 */
function rehearsal(): { trace?: string } | undefined {
  if (envDryRun) return { trace: envTrace };
  try {
    const cwd = process.cwd();
    if (readMode(cwd).dryRun) return { trace: modeTrace(cwd) };
  } catch {
    // Unreadable mode means live: never silently stop recording.
  }
  return undefined;
}

/** One line of the rehearsal: every call the agent made, in order. */
function trace(file: string | undefined, entry: { kind: 'read' | 'write' | 'refused'; tool: string; args?: unknown; note?: string }): void {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // A rehearsal must never break the thing it is rehearsing.
  }
}

let projectCache: Project | undefined;
async function project(): Promise<Project> {
  if (!projectCache) projectCache = await resolveProject(client, process.cwd());
  return projectCache;
}

/** Whole-project state, the union of every seam stream. */
async function state(): Promise<core.State> {
  const p = await project();
  const r = await client.states(p.id);
  return core.unionState(r.streams.map((s) => s.state));
}

const server = new McpServer({ name: 'lamproom', version: '0.2.0' });

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

function explain(e: unknown): string {
  if (e instanceof ClientError) {
    if (e.status === 401) return `${e.message}. The human must run "lamproom login" in a terminal, then restart this session.`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Provisional ids for a dry run, so a traced propose or declare can be
 * referred to by the calls that follow it. Numbered per process and marked
 * `dry` so they can never be mistaken for ids the server issued.
 */
let provisional = 0;
const dryId = (prefix: 't' | 'a') => `${prefix}-dry${++provisional}`;

/** What the server would have answered, enough for the describe callbacks. */
function pretend(command: string, args: Record<string, unknown>): CommandResponse {
  const r: CommandResponse = { ok: true, warnings: [] };
  if (command === 'propose') {
    const actions = (args.actions as { title: string; inputs?: string[]; outputs?: unknown[] }[]) ?? [];
    r.actions = actions.map((a) => ({
      id: dryId('t'),
      title: a.title,
      inputs: a.inputs ?? [],
      outputs: (a.outputs ?? []).map((o) => (typeof o === 'string' ? o : dryId('a'))),
    }));
  }
  if (command === 'declare') r.id = dryId('a');
  if (command === 'amend') r.addedOutputs = ((args.addOutputs as unknown[]) ?? []).map(() => dryId('a'));
  if (command === 'ask') {
    r.questionId = dryId('a');
    r.answerId = dryId('a');
  }
  return r;
}

async function mutate(
  command: string,
  args: Record<string, unknown>,
  describe: (r: CommandResponse) => string,
  onBehalfOf = false,
): Promise<ToolResult> {
  try {
    const p = await project();
    const dry = rehearsal();
    if (dry) {
      trace(dry.trace, { kind: 'write', tool: command, args: { ...args, onBehalfOf: onBehalfOf || undefined } });
      const r = pretend(command, args);
      return text(
        [
          `DRY RUN: ${command} was recorded for review and sent nowhere.`,
          describe(r),
          'Ids above are provisional. Carry on as though it succeeded.',
          faceLine(await state()),
        ].join('\n'),
      );
    }
    const r = await client.command(p.id, { command, args, agent: label, onBehalfOf });
    const lines = [describe(r)];
    if (r.warnings.length) lines.push(`Warnings: ${r.warnings.join('; ')}`);
    lines.push(faceLine(await state()));
    return text(lines.join('\n'));
  } catch (e) {
    return fail(explain(e));
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
    title: 'Lamproom status',
    description:
      'Show every seam in this project: your held actions, the coal face (actions ready for an agent), actions waiting on humans, blocked actions, and decomposed actions in progress. Call this first.',
    inputSchema: {},
  },
  async () => {
    try {
      const p = await project();
      trace(rehearsal()?.trace, { kind: 'read', tool: 'status' });
      const m = readMode(process.cwd());
      return text(
        [`You are ${meId} in ${p.owner}/${p.name}.`, ...(m.dryRun ? [describeMode(m)] : []), await client.status(p.id, label)].join('\n'),
      );
    } catch (e) {
      return fail(explain(e));
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
    let s: core.State;
    const dry = rehearsal();
    trace(dry?.trace, { kind: 'read', tool: 'inspect', args: { id } });
    try {
      s = await state();
    } catch (e) {
      return fail(explain(e));
    }
    // A provisional id exists only in this rehearsal; say so rather than failing.
    if (dry && /-dry\d+$/.test(id) && !s.actions[id] && !s.artefacts[id]) {
      return text(`${id} is provisional: proposed earlier in this dry run and never sent, so it has no detail to inspect.`);
    }
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
      'Add actions to a seam. With no parent and no inputs this starts a new goal (its own seam); with a parent it decomposes that action into children (call evaluate with judgement "decompose" first); with inputs from a finished seam\'s delivered artefacts and no parent it is a follow-up that extends that seam. Outputs may be existing artefact ids or new artefacts declared inline; declaring a pull-request or question automatically adds the human review or answer step required by policy. Inputs are artefact ids the action needs before it can start; they must all belong to one seam.',
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
    mutate('propose', args, (r) => {
      const acts = (r.actions as { id: string; title: string; inputs: string[]; outputs: string[] }[]) ?? [];
      return (
        'Proposed:\n' +
        acts
          .map((a) => `- ${a.id} "${a.title}" outputs: ${a.outputs.join(', ') || 'none'}${a.inputs.length ? ` inputs: ${a.inputs.join(', ')}` : ''}`)
          .join('\n')
      );
    }),
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
  async (args) => mutate('evaluate', args, () => `Evaluated ${args.actionId}: ${args.judgement}${args.size ? ` (${args.size})` : ''}.`),
);

server.registerTool(
  'claim',
  {
    title: 'Claim an action',
    description: 'Take an action from the coal face before working on it. Fails if another agent holds it unless force is set, which is only for sessions known to be dead.',
    inputSchema: { actionId: z.string(), force: z.boolean().optional() },
  },
  async (args) => mutate('claim', args, () => `Claimed ${args.actionId}.`),
);

server.registerTool(
  'release',
  {
    title: 'Release an action',
    description: 'Give up a claim without completing, e.g. when stopping for the turn or handing over.',
    inputSchema: { actionId: z.string(), reason: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate('release', args, () => `Released ${args.actionId}.`),
);

server.registerTool(
  'progress',
  {
    title: 'Note progress',
    description: 'Append a short progress note to an action you hold. One or two sentences about what was just done or decided.',
    inputSchema: { actionId: z.string(), note: z.string().describe('Markdown') },
  },
  async (args) => mutate('progress', args, () => `Noted on ${args.actionId}.`),
);

server.registerTool(
  'attach',
  {
    title: 'Attach an artefact version',
    description:
      'Record that an artefact now exists or has a new version. ref is a pointer to it: a commit SHA, a file path, or for a pull request its URL at the head commit (https://github.com/<owner>/<name>/pull/<n>/commits/<sha>). A new version clears an earlier rejection, so re-attaching the same ref after a rejection does not.',
    inputSchema: { artefactId: z.string(), ref: z.string(), note: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate('attach', args, () => `Attached version to ${args.artefactId}.`),
);

server.registerTool(
  'complete',
  {
    title: 'Complete an action',
    description: 'Mark an action finished. Attach versions to its outputs first. If an output needs human review, the action shows as submitted until the review lands.',
    inputSchema: { actionId: z.string(), note: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate('complete', args, () => `Completed ${args.actionId}.`),
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
  async (args) => mutate('ask', args, (r) => `Asked ${String(r.questionId)}; ${args.actionId} is blocked on ${String(r.answerId)} and released.`),
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
    mutate('amend', args, (r) => {
      const added = (r.addedOutputs as string[]) ?? [];
      return `Amended ${args.actionId}.${added.length ? ` New outputs: ${added.join(', ')}` : ''}`;
    }),
);

server.registerTool(
  'abandon',
  {
    title: 'Abandon an action',
    description: 'Drop an action that should not be done. Say why. Prefer this over leaving dead actions on the face.',
    inputSchema: { actionId: z.string(), reason: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate('abandon', args, () => `Abandoned ${args.actionId}.`),
);

server.registerTool(
  'restore',
  {
    title: 'Restore an abandoned action',
    description: 'Undo an abandonment: the action returns to the face as its inputs allow. For an action abandoned by mistake, or one that circumstances brought back.',
    inputSchema: { actionId: z.string(), note: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate('restore', args, () => `Restored ${args.actionId}.`),
);

server.registerTool(
  'reopen',
  {
    title: 'Reopen a completed action',
    description: 'Undo a completion: the action is workable again and its outputs keep their versions. For when more work turned out to be needed.',
    inputSchema: { actionId: z.string(), note: z.string().optional().describe('Markdown') },
  },
  async (args) => mutate('reopen', args, () => `Reopened ${args.actionId}.`),
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
    mutate('declare', args, (r) => `Declared ${String(r.id)}.${r.terminalId ? ` Policy added ${String(r.atomActionId)} producing ${String(r.terminalId)}.` : ''}`),
);

server.registerTool(
  'answer',
  {
    title: 'Relay a human answer',
    description:
      'Record an answer the human gave you in chat to one of your questions, on their behalf. The log attributes the answer to the human with you as the relay. Only for questions; never invent an answer, and never use this for pull-request reviews.',
    inputSchema: { questionId: z.string().describe('the question artefact id (a-...)'), text: z.string().describe('the answer as given; Markdown') },
  },
  async (args) => mutate('answer', args, () => `Recorded the answer to ${args.questionId} on behalf of your principal.`, true),
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
  async (args) => mutate('review', args, () => `Recorded ${args.verdict} for ${args.artefactId} on behalf of your principal.`, true),
);

server.registerTool(
  'mode',
  {
    title: 'Switch tracking between recording and dry run',
    description:
      'Read or set how this repository\'s work is tracked. In dry run, every Lamproom verb that would append an event is rehearsed instead: the call is traced and answered with provisional ids, reads still return the real graph, and the automatic turn tracker reports what it would have recorded without recording it. The setting belongs to the checkout, not to this session, so it outlives a restart and must be switched off deliberately; give turns to have it revert on its own instead. Use it to try the tracking out from a state the chat has already reached.',
    inputSchema: {
      dryRun: z.boolean().optional().describe('true to rehearse, false to record; omit to read the current mode'),
      turns: z.number().int().positive().optional().describe('rehearse this many turns, then go back to recording on its own'),
    },
  },
  async ({ dryRun, turns }) => {
    const cwd = process.cwd();
    try {
      if (dryRun === undefined) {
        const m = readMode(cwd);
        return text(`${describeMode(m)}\nCheckout: ${repoRoot(cwd)}`);
      }
      const m = writeMode(cwd, dryRun ? { dryRun: true, since: new Date().toISOString(), by: meId, turnsLeft: turns, rehearsed: 0 } : { dryRun: false });
      return text(
        [
          describeMode(m),
          `Checkout: ${repoRoot(cwd)}`,
          ...(m.dryRun
            ? [
                'Nothing you report from now on reaches the log. Tell the user plainly that the rehearsal is on, and that it stays on until switched off.',
                `Rehearsed calls are traced to ${modeTrace(cwd)}.`,
              ]
            : ['Reporting is live again.']),
        ].join('\n'),
      );
    } catch (e) {
      return fail(explain(e));
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`lamproom mcp ready as ${meId} against ${serverUrl}\n`);
