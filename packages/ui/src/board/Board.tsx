// Kanban view of the same state: every leaf action across all seams is a
// card, in columns by what the action is waiting for, merged across
// seams. Groups are not cards; their children are, each naming its
// seam and the chain of parents. Focus filters the board to the chosen
// seams.

import type { ActionState, State, Seam } from '@lamproom/core';
import { summary, seams } from '@lamproom/core';
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
  seam: Seam;
}
type Cells = Record<Column, Entry[]>;

/** Cards for every shown seam, in seam order then by age; the done column newest first. */
function classify(state: State, allSeams: Seam[]): Cells {
  const cells: Cells = { blocked: [], ready: [], human: [], active: [], submitted: [], done: [] };
  for (const seam of allSeams) {
    const acts = seam.actions.map((id) => state.actions[id]!).sort((a, b) => a.seq - b.seq);
    for (const t of acts) {
      const c = columnOf(t);
      if (c) cells[c].push({ action: t, seam });
    }
  }
  const finishedAt = (t: ActionState) => t.log[t.log.length - 1]?.seq ?? t.seq;
  cells.done.sort((a, b) => finishedAt(b.action) - finishedAt(a.action));
  return cells;
}

interface Props {
  state: State;
  /** Seam ids in focus; empty means all. */
  focus: string[];
  selected?: string;
  onSelect: (id: string | undefined) => void;
  onFocus: (id: string | undefined, additive?: boolean) => void;
}

export function Board({ state, focus, selected, onSelect, onFocus }: Props) {
  const allSeams = useMemo(() => seams(state), [state]);
  const shown = useMemo(() => (focus.length ? allSeams.list.filter((w) => focus.includes(w.id)) : allSeams.list), [allSeams, focus]);
  const cells = useMemo(() => classify(state, shown), [state, shown]);

  // A click on the background clears the selection only (a click outside is
  // how the picker's popup closes); a double-click clears the focus.
  return (
    <div className="lr-board" onClick={() => onSelect(undefined)} onDoubleClick={() => onFocus(undefined)}>
      <div className="lr-board-grid">
        {COLUMNS.map((c) => (
          <Hint key={c.id} content={c.hint} placement="below">
            <div className={cx('lr-col-head', `tone-${c.id}`)}>
              <span className="lr-dot" />
              {c.label}
              <span className="lr-col-n">{cells[c.id].length}</span>
            </div>
          </Hint>
        ))}
        {COLUMNS.map((c) => (
          <div key={c.id} className={cx('lr-cell', cells[c.id].length === 0 && 'is-empty')}>
            {cells[c.id].map(({ action, seam }) => (
              <Card
                key={action.id}
                action={action}
                seam={seam}
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
  seam,
  state,
  selected,
  onSelect,
  onFocus,
}: {
  action: ActionState;
  seam: Seam;
  state: State;
  selected: boolean;
  onSelect: (id: string) => void;
  onFocus: (id: string, additive: boolean) => void;
}) {
  const human = t.requires?.actorKind === 'human';
  const root = useRef<HTMLDivElement>(null);
  // The chain of parents below the goal; the goal itself is the seam line.
  const crumbs: string[] = [];
  let cur = t.parent ? state.actions[t.parent] : undefined;
  while (cur && cur.id !== seam.goal?.id) {
    crumbs.unshift(cur.title);
    cur = cur.parent ? state.actions[cur.parent] : undefined;
  }
  return (
    <>
    <div
      className={cx('lr-card', `st-${t.status}`, human && 'is-human', selected && 'is-selected')}
      ref={root}
      onDoubleClick={(e) => {
        // Double-click focuses the card's seam; with a modifier, adds it to the focus.
        e.stopPropagation();
        onFocus(seam.id, e.shiftKey || e.ctrlKey || e.metaKey);
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
        <span className="lr-card-body">
          <span className="lr-card-head">
            <span className="lr-dot" />
            <span className="lr-status">{human && t.status === 'ready' ? 'Needs you' : STATUS_LABEL[t.status]}</span>
            <span className="lr-spacer" />
            {human && <Icon name="person" size={12} className="lr-human-mark" />}
            {t.size && <span className="lr-size">{t.size}</span>}
          </span>
          <Hint content={`Seam: ${seam.title}`}>
            <span className={cx('lr-card-seam', `seam-${seam.status}`)}>
              <Icon name="flag" size={11} />
              <span className="lr-card-seam-title">{seam.title}</span>
            </span>
          </Hint>
          {crumbs.length > 0 && (
            <Hint content={crumbs.join(' / ')}>
              <span className="lr-card-crumbs">
                {crumbs.join(' / ')}
              </span>
            </Hint>
          )}
          <span className="lr-card-title">{t.title}</span>
          <span className="lr-card-meta">{actionMeta(t, { action: t, collapsed: false, childCount: 0, doneCount: 0 })}</span>
        </span>
      </ClickableCard>
    </div>
      <Hint anchorRef={root} content={summary(t.description) || t.title} />
    </>
  );
}
