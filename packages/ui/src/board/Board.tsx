// Kanban view of the same state: every leaf action across all workflows is a
// card, in columns by what the action is waiting for, merged across
// workflows. Groups are not cards; their children are, each naming its
// workflow and the chain of parents. Focus filters the board to the chosen
// workflows.

import type { ActionState, State, Workflow } from '@coalface/core';
import { summary, workflows } from '@coalface/core';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { useMemo, useRef } from 'react';
import { Hint } from '../hint';
import { Icon, STATUS_LABEL, actionMeta, cx } from '../graph/nodes';

export type Column = 'blocked' | 'ready' | 'human' | 'active' | 'submitted' | 'done';

export const COLUMNS: { id: Column; label: string; hint: string }[] = [
  { id: 'blocked', label: 'Blocked', hint: 'Waiting on an input' },
  { id: 'ready', label: 'Ready', hint: 'The coal face: enabled and nobody holds it' },
  { id: 'human', label: 'Needs you', hint: 'Reviews and questions waiting on a human' },
  { id: 'active', label: 'In progress', hint: 'Claimed and being worked' },
  { id: 'submitted', label: 'Awaiting review', hint: 'Finished, outputs not yet accepted' },
  { id: 'done', label: 'Done', hint: 'Accepted, or abandoned' },
];

/** The column a leaf action belongs in. Groups have none: their children are the cards. */
export function columnOf(t: ActionState): Column | undefined {
  if (t.children.length) return undefined;
  switch (t.status) {
    case 'blocked':
      return 'blocked';
    case 'ready':
    case 'rework':
      return t.requires?.actorKind === 'human' ? 'human' : 'ready';
    case 'active':
      return 'active';
    case 'submitted':
      return 'submitted';
    case 'done':
    case 'abandoned':
      return 'done';
    default:
      return undefined;
  }
}

interface Entry {
  action: ActionState;
  wf: Workflow;
}
type Cells = Record<Column, Entry[]>;

/** Cards for every shown workflow, in workflow order then by age; the done column newest first. */
function classify(state: State, wfs: Workflow[]): Cells {
  const cells: Cells = { blocked: [], ready: [], human: [], active: [], submitted: [], done: [] };
  for (const wf of wfs) {
    const acts = wf.actions.map((id) => state.actions[id]!).sort((a, b) => a.seq - b.seq);
    for (const t of acts) {
      const c = columnOf(t);
      if (c) cells[c].push({ action: t, wf });
    }
  }
  const finishedAt = (t: ActionState) => t.log[t.log.length - 1]?.seq ?? t.seq;
  cells.done.sort((a, b) => finishedAt(b.action) - finishedAt(a.action));
  return cells;
}

interface Props {
  state: State;
  /** Workflow ids in focus; empty means all. */
  focus: string[];
  selected?: string;
  onSelect: (id: string | undefined) => void;
  onFocus: (id: string | undefined, additive?: boolean) => void;
}

export function Board({ state, focus, selected, onSelect, onFocus }: Props) {
  const wfs = useMemo(() => workflows(state), [state]);
  const shown = useMemo(() => (focus.length ? wfs.list.filter((w) => focus.includes(w.id)) : wfs.list), [wfs, focus]);
  const cells = useMemo(() => classify(state, shown), [state, shown]);

  // A click on the background clears the selection only (a click outside is
  // how the picker's popup closes); a double-click clears the focus.
  return (
    <div className="cf-board" onClick={() => onSelect(undefined)} onDoubleClick={() => onFocus(undefined)}>
      <div className="cf-board-grid">
        {COLUMNS.map((c) => (
          <Hint key={c.id} content={c.hint} placement="below">
            <div className={cx('cf-col-head', `tone-${c.id}`)}>
              <span className="cf-dot" />
              {c.label}
              <span className="cf-col-n">{cells[c.id].length}</span>
            </div>
          </Hint>
        ))}
        {COLUMNS.map((c) => (
          <div key={c.id} className={cx('cf-cell', cells[c.id].length === 0 && 'is-empty')}>
            {cells[c.id].map(({ action, wf }) => (
              <Card
                key={action.id}
                action={action}
                wf={wf}
                state={state}
                selected={selected === action.id}
                onSelect={onSelect}
                onFocus={onFocus}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The card's tint: the actionable states carry their colour, blocked is muted, the rest are plain. */
function cardVariant(t: ActionState): 'default' | 'muted' | 'orange' | 'pink' | 'red' {
  const human = t.requires?.actorKind === 'human';
  if (t.status === 'blocked') return 'muted';
  if (t.status === 'ready') return human ? 'pink' : 'orange';
  if (t.status === 'rework') return human ? 'pink' : 'red';
  return 'default';
}

function Card({
  action: t,
  wf,
  state,
  selected,
  onSelect,
  onFocus,
}: {
  action: ActionState;
  wf: Workflow;
  state: State;
  selected: boolean;
  onSelect: (id: string) => void;
  onFocus: (id: string, additive: boolean) => void;
}) {
  const human = t.requires?.actorKind === 'human';
  const root = useRef<HTMLDivElement>(null);
  // The chain of parents below the goal; the goal itself is the workflow line.
  const crumbs: string[] = [];
  let cur = t.parent ? state.actions[t.parent] : undefined;
  while (cur && cur.id !== wf.goal?.id) {
    crumbs.unshift(cur.title);
    cur = cur.parent ? state.actions[cur.parent] : undefined;
  }
  return (
    <>
    <div
      className={cx('cf-card', `st-${t.status}`, human && 'is-human', selected && 'is-selected')}
      ref={root}
      onDoubleClick={(e) => {
        // Double-click focuses the card's workflow; with a modifier, adds it to the focus.
        e.stopPropagation();
        onFocus(wf.id, e.shiftKey || e.ctrlKey || e.metaKey);
      }}
    >
      <ClickableCard
        label={t.title}
        padding={2}
        variant={cardVariant(t)}
        elevation="none"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(t.id);
        }}
      >
        <span className="cf-card-body">
          <span className="cf-card-head">
            <span className="cf-dot" />
            <span className="cf-status">{human && t.status === 'ready' ? 'Needs you' : STATUS_LABEL[t.status]}</span>
            <span className="cf-spacer" />
            {human && <Icon name="person" size={12} className="cf-human-mark" />}
            {t.size && <span className="cf-size">{t.size}</span>}
          </span>
          <Hint content={`Workflow: ${wf.title}`}>
            <span className={cx('cf-card-wf', `wf-${wf.status}`)}>
              <Icon name="flag" size={11} />
              <span className="cf-card-wf-title">{wf.title}</span>
            </span>
          </Hint>
          {crumbs.length > 0 && (
            <Hint content={crumbs.join(' / ')}>
              <span className="cf-card-crumbs">
                {crumbs.join(' / ')}
              </span>
            </Hint>
          )}
          <span className="cf-card-title">{t.title}</span>
          <span className="cf-card-meta">{actionMeta(t, { action: t, collapsed: false, childCount: 0, doneCount: 0 })}</span>
        </span>
      </ClickableCard>
    </div>
      <Hint anchorRef={root} content={summary(t.description) || t.title} />
    </>
  );
}
