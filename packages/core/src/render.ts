// Text renderings of state for agents (tool results, injected context).

import { agentFace, humanQueue, summarise } from './project.js';
import { inlineText } from './richtext.js';
import type { ActionState, Actor, Comment, State } from './types.js';

function art(s: State, id: string): string {
  const a = s.artefacts[id];
  if (!a) return `${id} (unknown)`;
  return `${id} "${a.title}" <${a.kind}:${a.status}>`;
}

/** One comment on one line: who, what, and what it points at. */
export function describeComment(c: Comment, max = 280): string {
  const who = `${c.by.kind} ${c.by.name ?? c.by.id}${c.via ? ` via ${c.via.id}` : ''}`;
  const att = c.attachments?.length ? ` [attached: ${c.attachments.map((a) => a.title ?? a.ref).join(', ')}]` : '';
  return `${c.id}${c.replyTo ? ` (re ${c.replyTo})` : ''} ${who}: ${inlineText(c.body, max)}${att}`;
}

/**
 * The latest comments on an action and on the artefacts it touches, for an
 * agent about to work it. Humans' comments are the main channel for
 * steering work that is already planned, so they are never left out.
 */
function commentLines(s: State, t: ActionState, perTarget = 5): string[] {
  const lines: string[] = [];
  const recent = (cs: Comment[]) => {
    const human = cs.filter((c) => c.by.kind === 'human');
    const keep = new Set([...cs.slice(-perTarget), ...human.slice(-perTarget)]);
    return cs.filter((c) => keep.has(c));
  };
  const own = recent(t.comments);
  if (own.length) lines.push(`    comments (${t.comments.length}):`, ...own.map((c) => `      ${describeComment(c)}`));
  for (const id of [...t.inputs, ...t.outputs]) {
    const a = s.artefacts[id];
    if (!a?.comments.length) continue;
    lines.push(`    comments on ${id} (${a.comments.length}):`, ...recent(a.comments).map((c) => `      ${describeComment(c)}`));
  }
  return lines;
}

export function describeAction(s: State, t: ActionState, verbose = false): string {
  const size = t.size ? ` [${t.size}]` : ' [unsized]';
  const who = t.claimedBy ? ` held by ${t.claimedBy.id}` : '';
  const req = t.requires ? ` (needs ${t.requires.actorKind})` : '';
  const lines = [`- ${t.id} "${t.title}"${size} ${t.status}${who}${req}`];
  if (t.parent) lines.push(`    parent: ${t.parent}`);
  if (t.inputs.length) lines.push(`    inputs: ${t.inputs.map((i) => art(s, i)).join(', ')}`);
  if (t.outputs.length) lines.push(`    outputs: ${t.outputs.map((o) => art(s, o)).join(', ')}`);
  if (t.blockedOn.length) lines.push(`    blocked on: ${t.blockedOn.map((i) => art(s, i)).join(', ')}`);
  if (verbose) {
    if (t.description) lines.push(`    description: ${inlineText(t.description)}`);
    const crit = t.evaluation?.criteria ?? [];
    if (crit.length) lines.push(`    criteria: ${crit.map((c) => inlineText(c)).join(' | ')}`);
    if (t.evaluation?.rationale) lines.push(`    rationale: ${inlineText(t.evaluation.rationale)}`);
    for (const o of t.outputs) {
      const a = s.artefacts[o];
      if (a?.status === 'rejected' && a.rejections.length) {
        lines.push(`    rejection of ${o}: ${a.rejections.map((r) => inlineText(r)).join(' | ')}`);
      }
    }
    if (t.children.length) lines.push(`    children: ${t.children.join(', ')}`);
    lines.push(...commentLines(s, t));
    const recent = t.log.slice(-4);
    if (recent.length) lines.push(`    recent: ${recent.map((l) => `${l.type.replace('action.', '')}${l.note ? ` (${inlineText(l.note, 160)})` : ''}`).join('; ')}`);
  }
  return lines.join('\n');
}

export function renderStatus(s: State, me?: Actor): string {
  const sum = summarise(s);
  const total = Object.values(s.actions).length;
  const out: string[] = [];
  out.push(
    `Lamproom: ${total} actions (${sum.actions.done} done, ${sum.actions.active} active, ${sum.agentFace} ready for agents, ${sum.humanQueue} waiting on humans, ${sum.actions.blocked} blocked, ${sum.undecomposedLarge} large or unsized still undecomposed).`,
  );
  if (total === 0) {
    out.push('The seam is empty. Propose a top-level action for the goal with a concrete output artefact.');
    return out.join('\n');
  }
  if (me) {
    const mine = Object.values(s.actions).filter((t) => t.claimedBy?.id === me.id);
    if (mine.length) {
      out.push('', `Held by you (${me.id}):`);
      for (const t of mine) out.push(describeAction(s, t, true));
    }
  }
  const face = agentFace(s);
  out.push('', face.length ? 'Coal face (ready for an agent):' : 'Coal face is empty for agents.');
  for (const t of face) out.push(describeAction(s, t, true));
  const hq = humanQueue(s);
  if (hq.length) {
    out.push('', 'Waiting on humans:');
    for (const t of hq) out.push(describeAction(s, t));
  }
  const blocked = Object.values(s.actions).filter((t) => t.status === 'blocked' && !t.children.length);
  if (blocked.length) {
    out.push('', 'Blocked:');
    for (const t of blocked) out.push(describeAction(s, t));
  }
  const groups = Object.values(s.actions).filter((t) => t.status === 'decomposed');
  if (groups.length) {
    out.push('', 'In progress (decomposed):');
    for (const t of groups) {
      const kids = t.children.map((c) => s.actions[c]!);
      const done = kids.filter((k) => k.status === 'done').length;
      out.push(`- ${t.id} "${t.title}" ${done}/${kids.length} children done`);
    }
  }
  if (s.warnings.length) out.push('', `Log warnings: ${s.warnings.slice(-3).join('; ')}`);
  return out.join('\n');
}
