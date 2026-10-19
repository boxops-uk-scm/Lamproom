// Text renderings of state for agents (tool results, injected context).

import { agentFace, humanQueue, summarise } from './project.js';
import { inlineText } from './richtext.js';
import type { ActionState, Actor, State } from './types.js';

function art(s: State, id: string): string {
  const a = s.artefacts[id];
  if (!a) return `${id} (unknown)`;
  return `${id} "${a.title}" <${a.kind}:${a.status}>`;
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
    `Coalface: ${total} actions (${sum.actions.done} done, ${sum.actions.active} active, ${sum.agentFace} ready for agents, ${sum.humanQueue} waiting on humans, ${sum.actions.blocked} blocked, ${sum.undecomposedLarge} large or unsized still undecomposed).`,
  );
  if (total === 0) {
    out.push('The workflow is empty. Propose a top-level action for the goal with a concrete output artefact.');
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
