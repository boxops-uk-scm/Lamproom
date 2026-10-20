import { inlineText, type Event, type State } from '@lamproom/core';

function who(e: Event): string {
  const name = (a: Event['actor']) => (a.kind === 'human' ? a.name ?? a.id : a.id);
  return e.onBehalfOf ? `${name(e.onBehalfOf)} (via ${name(e.actor)})` : name(e.actor);
}

function actionTitle(s: State, id: string): string {
  return s.actions[id] ? `"${s.actions[id]!.title}"` : id;
}

function artefactTitle(s: State, id: string): string {
  return s.artefacts[id] ? `"${s.artefacts[id]!.title}"` : id;
}

/** One-line human description of an event, given the state after it. */
export function describeEvent(s: State, e: Event): string {
  const w = who(e);
  switch (e.type) {
    case 'artefact.declared':
      return `${w} declared ${e.artefact.kind} "${e.artefact.title}"${e.artefact.expandedFrom ? ' (policy)' : ''}`;
    case 'artefact.version':
      return `${w} attached a version to ${artefactTitle(s, e.artefactId)}`;
    case 'artefact.accepted':
      return `${w} accepted ${artefactTitle(s, e.artefactId)}`;
    case 'artefact.rejected':
      return `${w} rejected ${artefactTitle(s, e.artefactId)}: ${e.reasons.map((r) => inlineText(r)).join('; ')}`;
    case 'artefact.invalidated':
      return `${w} invalidated ${artefactTitle(s, e.artefactId)}`;
    case 'action.proposed':
      return `${w} proposed ${e.action.expandedFrom ? '(policy) ' : ''}"${e.action.title}"${e.action.parent ? ` under ${actionTitle(s, e.action.parent)}` : ''}`;
    case 'action.evaluated':
      return `${w} judged ${actionTitle(s, e.actionId)}: ${e.judgement}${e.size ? ` (${e.size})` : ''}`;
    case 'action.amended':
      return `${w} amended ${actionTitle(s, e.actionId)}`;
    case 'action.claimed':
      return `${w} claimed ${actionTitle(s, e.actionId)}`;
    case 'action.released':
      return `${w} released ${actionTitle(s, e.actionId)}${e.reason ? `: ${inlineText(e.reason)}` : ''}`;
    case 'action.progressed':
      return `${w} on ${actionTitle(s, e.actionId)}: ${inlineText(e.note)}`;
    case 'action.completed':
      return `${w} completed ${actionTitle(s, e.actionId)}`;
    case 'action.abandoned':
      return `${w} abandoned ${actionTitle(s, e.actionId)}`;
    case 'action.restored':
      return `${w} restored ${actionTitle(s, e.actionId)}`;
    case 'action.reopened':
      return `${w} reopened ${actionTitle(s, e.actionId)}`;
    case 'comment.added':
      return `${w} ${e.replyTo ? 'replied' : 'commented'} on ${s.actions[e.targetId] ? actionTitle(s, e.targetId) : artefactTitle(s, e.targetId)}: ${inlineText(e.body) || 'attachments'}`;
  }
}
