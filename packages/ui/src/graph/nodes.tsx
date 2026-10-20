import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ActionState, ActionStatus, ArtefactState, ArtefactStatus, Seam, SeamStatus } from '@lamproom/core';
import { summary } from '@lamproom/core';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Token } from '@astryxdesign/core/Token';
import {
  ArrowsInLineVertical,
  Broom,
  Trash,
  X,
  CaretDown,
  CaretRight,
  ChatCircle,
  CheckCircle,
  CircleHalf,
  CornersOut,
  Cube,
  DotsSixVertical,
  DotsThree,
  FileText,
  Flag,
  GitPullRequest,
  Kanban,
  Lightning,
  Minus,
  ListChecks,
  Moon,
  Plus,
  PushPin,
  Scales,
  Question,
  Sun,
  Target,
  TreeStructure,
  User,
  type Icon as PhosphorIcon,
  type IconWeight,
  GithubLogo,
  SignOut,
  FolderSimple,
  ChatText,
  File as FileIcon,
  Image as ImageIcon,
  FlowArrow,
} from '@phosphor-icons/react';
import React, { createContext, useContext, useRef, type ReactNode } from 'react';
import { CanvasHint } from '../hint';
import { portHandle, type Port } from './build';

export interface ActionData extends Record<string, unknown> {
  action: ActionState;
  collapsed: boolean;
  childCount: number;
  doneCount: number;
  /** Ports view: the artefacts this card takes in and puts out. */
  ports?: { inputs: Port[]; outputs: Port[] };
  entering?: boolean;
}
export interface ArtefactData extends Record<string, unknown> {
  artefact: ArtefactState;
  finish?: boolean;
  entering?: boolean;
}
export interface SeamData extends Record<string, unknown> {
  seam: Seam;
  collapsed: boolean;
  pinned: boolean;
  dim: boolean;
  entering?: boolean;
}
export type ActionNodeT = Node<ActionData, 'action'>;
export type GroupNodeT = Node<ActionData, 'group'>;
export type ArtefactNodeT = Node<ArtefactData, 'artefact'>;
export type SeamNodeT = Node<SeamData, 'seam'>;

export const GraphContext = createContext<{
  selected?: string;
  focused: string[];
  onToggle: (id: string) => void;
  onToggleFrame: (id: string) => void;
  onPinFrame: (id: string) => void;
  onFocus: (id: string | undefined, additive?: boolean) => void;
  onSelect: (id: string | undefined) => void;
}>({ focused: [], onToggle: () => {}, onToggleFrame: () => {}, onPinFrame: () => {}, onFocus: () => {}, onSelect: () => {} });

export const SEAM_LABEL: Record<SeamStatus, string> = {
  done: 'Done',
  abandoned: 'Abandoned',
  active: 'In progress',
  waiting: 'Needs you',
  ready: 'Ready',
  blocked: 'Blocked',
};

export const STATUS_LABEL: Record<ActionStatus, string> = {
  ready: 'Ready',
  rework: 'Rework',
  active: 'Active',
  submitted: 'Awaiting review',
  blocked: 'Blocked',
  decomposed: 'In progress',
  done: 'Done',
  abandoned: 'Abandoned',
};

export const ARTEFACT_LABEL: Record<ArtefactStatus, string> = {
  declared: 'Not yet produced',
  produced: 'Produced',
  accepted: 'Accepted',
  rejected: 'Rejected',
  invalidated: 'Invalidated',
};

/** The Astryx/Boxops hue each state is painted in. Matches the --c-* variables in styles.css. */
export type Hue = 'default' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'cyan' | 'blue' | 'purple' | 'pink' | 'gray';

export const STATUS_HUE: Record<ActionStatus, Hue> = {
  ready: 'orange',
  rework: 'red',
  active: 'blue',
  submitted: 'purple',
  blocked: 'gray',
  decomposed: 'teal',
  done: 'green',
  abandoned: 'gray',
};

export const SEAM_HUE: Record<SeamStatus, Hue> = {
  done: 'green',
  abandoned: 'gray',
  active: 'blue',
  waiting: 'pink',
  ready: 'orange',
  blocked: 'gray',
};

export const ARTEFACT_HUE: Record<ArtefactStatus, Hue> = {
  declared: 'gray',
  produced: 'blue',
  accepted: 'green',
  rejected: 'red',
  invalidated: 'gray',
};

export function actionHue(t: ActionState): Hue {
  if ((t.status === 'ready' || t.status === 'rework') && t.requires?.actorKind === 'human') return 'pink';
  return STATUS_HUE[t.status];
}

export function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---- icons ---------------------------------------------------------------

// Phosphor, as Boxops uses. The names are Lamproom's own vocabulary.
const ICONS: Record<string, PhosphorIcon> = {
  person: User,
  bolt: Lightning,
  pr: GitPullRequest,
  check: CheckCircle,
  question: Question,
  answer: ChatCircle,
  doc: FileText,
  plan: ListChecks,
  decision: Scales,
  box: Cube,
  flag: Flag,
  chevron: CaretRight,
  down: CaretDown,
  plus: Plus,
  minus: Minus,
  sun: Sun,
  moon: Moon,
  auto: CircleHalf,
  fit: CornersOut,
  dots: DotsThree,
  grip: DotsSixVertical,
  pin: PushPin,
  pinned: PushPin,
  graph: TreeStructure,
  board: Kanban,
  tidy: Broom,
  target: Target,
  shrink: ArrowsInLineVertical,
  trash: Trash,
  x: X,
  github: GithubLogo,
  signout: SignOut,
  folder: FolderSimple,
  file: FileIcon,
  image: ImageIcon,
  comment: ChatText,
  ports: FlowArrow,
};

export function Icon({
  name,
  size = 14,
  className,
  weight,
}: {
  name: string;
  size?: number;
  className?: string;
  weight?: IconWeight;
}) {
  const Glyph = ICONS[name] ?? Cube;
  return (
    <Glyph
      size={size}
      weight={weight ?? (name === 'pinned' || name === 'flag' ? 'fill' : 'regular')}
      className={cx('lr-icon', className)}
      aria-hidden="true"
    />
  );
}

/** The glyph component behind an icon name, for components that render their own icons. */
export function iconFor(name: string): PhosphorIcon {
  return ICONS[name] ?? Cube;
}

export function kindIcon(kind: string): string {
  switch (kind) {
    case 'pull-request':
      return 'pr';
    case 'reviewed-pull-request':
      return 'check';
    case 'question':
      return 'question';
    case 'answer':
      return 'answer';
    case 'document':
      return 'doc';
    case 'plan':
      return 'plan';
    case 'decision':
      return 'decision';
    case 'goal':
      return 'flag';
    default:
      return 'box';
  }
}

// ---- shared bits ---------------------------------------------------------

/** A status chip: an Astryx Token in the state's hue, with the state dot. */
export function StatusToken({ label, hue, size = 'sm', icon }: { label: string; hue: Hue; size?: 'sm' | 'md'; icon?: ReactNode }) {
  return <Token size={size} color={hue} label={label} icon={icon ?? <span className="lr-dot" />} />;
}

/** Done-over-total as an Astryx progress bar with the count beside it. */
export function Progress({ done, total, width = 112 }: { done: number; total: number; width?: number }) {
  const root = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span ref={root} className="lr-progress">
        <span className="lr-progress-bar" style={{ width }}>
          <ProgressBar label={`${done} of ${total} done`} isLabelHidden value={done} max={Math.max(total, 1)} variant="success" />
        </span>
        <span className="lr-progress-n">
          {done}/{total}
        </span>
      </span>
      <CanvasHint anchorRef={root} content={`${done} of ${total} done`} />
    </>
  );
}

// ---- nodes ---------------------------------------------------------------

export function actionMeta(t: ActionState, data: ActionData): ReactNode {
  if (data.collapsed) {
    return (
      <span className="lr-meta-item">
        {data.doneCount}/{data.childCount} children done
      </span>
    );
  }
  if (t.status === 'active' && t.claimedBy) {
    return (
      <span className="lr-meta-item">
        <Icon name={t.claimedBy.kind === 'human' ? 'person' : 'bolt'} size={12} />
        {t.claimedBy.name ?? t.claimedBy.id}
      </span>
    );
  }
  if (t.status === 'blocked') {
    return (
      <span className="lr-meta-item">
        waiting on {t.blockedOn.length} input{t.blockedOn.length === 1 ? '' : 's'}
      </span>
    );
  }
  if (t.status === 'rework') return <span className="lr-meta-item">output rejected</span>;
  if (t.status === 'submitted') return <span className="lr-meta-item">waiting for review</span>;
  if (t.status === 'done' || t.status === 'abandoned') {
    const last = [...t.log].reverse().find((l) => l.type === 'action.completed' || l.type === 'action.abandoned');
    return (
      <span className="lr-meta-item">
        {last ? (
          <>
            <Icon name={last.actor.kind === 'human' ? 'person' : 'bolt'} size={12} />
            {last.actor.name ?? last.actor.id}
          </>
        ) : (
          'done'
        )}
      </span>
    );
  }
  // A human step has nothing to evaluate: its status line says it all.
  if (t.status === 'ready' && t.requires?.actorKind === 'human') return null;
  const criteria = t.evaluation?.criteria?.length ?? 0;
  if (criteria) {
    return (
      <span className="lr-meta-item">
        {criteria} criteria
      </span>
    );
  }
  return <span className="lr-meta-item">{t.evaluation ? t.evaluation.judgement : 'not yet evaluated'}</span>;
}

function PortRow({ port, side }: { port: Port; side: 'in' | 'out' }) {
  const { selected, onSelect } = useContext(GraphContext);
  const row = useRef<HTMLDivElement>(null);
  const a = port.artefact;
  return (
    <div
      ref={row}
      className={cx('lr-port', `is-${side}`, `as-${a.status}`, !port.wired && 'is-open', port.finish && 'is-finish', selected === a.id && 'is-selected')}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(a.id);
      }}
    >
      <Handle
        type={side === 'in' ? 'target' : 'source'}
        position={side === 'in' ? Position.Left : Position.Right}
        id={portHandle(side, a.id)}
        className="lr-port-pin"
      />
      <Icon name={port.finish && side === 'out' ? 'flag' : kindIcon(a.kind)} size={12} className="lr-port-kind" />
      <span className="lr-port-title">{a.title}</span>
      <CanvasHint anchorRef={row} content={`${port.finish ? 'Deliverable. ' : ''}${a.kind}: ${a.title} (${ARTEFACT_LABEL[a.status]})`} />
    </div>
  );
}

/** The ports area of a card: inputs down the left, outputs down the right, row for row. */
function Ports({ ports }: { ports: NonNullable<ActionData['ports']> }) {
  if (!ports.inputs.length && !ports.outputs.length) return null;
  return (
    <div className="lr-ports">
      <div className="lr-ports-col">
        {ports.inputs.map((p) => (
          <PortRow key={p.id} port={p} side="in" />
        ))}
      </div>
      <div className="lr-ports-col">
        {ports.outputs.map((p) => (
          <PortRow key={p.id} port={p} side="out" />
        ))}
      </div>
    </div>
  );
}

export function ActionNode({ id, data }: NodeProps<ActionNodeT>) {
  const { selected, onToggle } = useContext(GraphContext);
  const root = useRef<HTMLDivElement>(null);
  const commentsRef = useRef<HTMLSpanElement>(null);
  const t = data.action;
  const human = t.requires?.actorKind === 'human';
  const ports = data.ports;
  return (
    <>
    <div
      className={cx(
        'lr-node lr-action',
        `st-${t.status}`,
        human && 'is-human',
        selected === id && 'is-selected',
        data.collapsed && 'is-collapsed',
        ports && 'has-ports',
        data.entering && 'lr-enter',
      )}
      ref={root}
    >
      {!ports && <Handle type="target" position={Position.Left} className="lr-handle" />}
      <div className="lr-action-head">
        <span className="lr-dot" />
        <span className="lr-status">{human && t.status === 'ready' ? 'Needs you' : STATUS_LABEL[t.status]}</span>
        <span className="lr-spacer" />
        {human && <Icon name="person" size={13} className="lr-human-mark" />}
        {t.size && <span className="lr-size">{t.size}</span>}
      </div>
      <div className="lr-title">{t.title}</div>
      <div className="lr-meta">
        {actionMeta(t, data)}
        {t.comments.length > 0 && (
          <span ref={commentsRef} className="lr-meta-item lr-comment-count">
            <Icon name="comment" size={12} />
            {t.comments.length}
            <CanvasHint anchorRef={commentsRef} content={`${t.comments.length} comment${t.comments.length === 1 ? '' : 's'}`} />
          </span>
        )}
        {data.collapsed && (
          <span className="nodrag">
            <IconButton
              size="sm"
              variant="ghost"
              label="Expand"
              tooltip="Expand the children"
              icon={<Icon name="plus" size={14} />}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(id);
              }}
            />
          </span>
        )}
      </div>
      {ports ? <Ports ports={ports} /> : <Handle type="source" position={Position.Right} className="lr-handle" />}
    </div>
      {/* The ports, the comment count and the buttons have hints of their own. */}
      <CanvasHint anchorRef={root} content={summary(t.description) || t.title} exclude=".lr-port, .lr-comment-count, .nodrag" />
    </>
  );
}

export function GroupNode({ id, data }: NodeProps<GroupNodeT>) {
  const { selected, onToggle } = useContext(GraphContext);
  const t = data.action;
  return (
    <div className={cx('lr-group', `st-${t.status}`, selected === id && 'is-selected', data.entering && 'lr-enter')}>
      <div className="lr-group-head">
        <span className="nodrag">
          <IconButton
            size="sm"
            variant="ghost"
            label="Collapse"
            tooltip="Collapse the children"
            icon={<Icon name="chevron" size={14} className="is-down" />}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(id);
            }}
          />
        </span>
        <span className="lr-group-title">{t.title}</span>
        {t.size && <span className="lr-size">{t.size}</span>}
        <span className="lr-group-progress">
          <Progress done={data.doneCount} total={data.childCount} width={96} />
        </span>
      </div>
    </div>
  );
}

export function ArtefactNode({ id, data }: NodeProps<ArtefactNodeT>) {
  const { selected } = useContext(GraphContext);
  const root = useRef<HTMLDivElement>(null);
  const a = data.artefact;
  const human = a.kind === 'question' || a.kind === 'answer';
  return (
    <>
    <div
      className={cx(
        'lr-node lr-artefact',
        `as-${a.status}`,
        `kind-${a.kind}`,
        human && 'is-human',
        data.finish && 'is-finish',
        selected === id && 'is-selected',
        data.entering && 'lr-enter',
      )}
      ref={root}
    >
      <Handle type="target" position={Position.Left} className="lr-handle" />
      <Icon name={data.finish ? 'flag' : kindIcon(a.kind)} size={14} className="lr-kind" />
      <span className="lr-artefact-title">{a.title}</span>
      <span className="lr-adot" />
      <Handle type="source" position={Position.Right} className="lr-handle" />
    </div>
      <CanvasHint anchorRef={root} content={`${data.finish ? 'Deliverable. ' : ''}${a.kind}: ${a.title} (${ARTEFACT_LABEL[a.status]})`} />
    </>
  );
}

export function SeamNode({ id, data }: NodeProps<SeamNodeT>) {
  const { selected, focused, onToggleFrame, onPinFrame, onFocus } = useContext(GraphContext);
  const titleRef = useRef<HTMLSpanElement>(null);
  const seam = data.seam;
  const isFocused = focused.includes(seam.id);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const tools = (
    <span className="lr-frame-tools nodrag">
      <IconButton
        size="sm"
        variant={isFocused ? 'primary' : 'ghost'}
        label={isFocused ? 'Unfocus this seam' : 'Focus this seam'}
        tooltip={isFocused ? 'Unfocus this seam' : 'Focus this seam. Shift-click to add it to the current focus'}
        icon={<Icon name="target" size={14} />}
        onClick={(e) => {
          stop(e);
          onFocus(seam.id, e.shiftKey || e.ctrlKey || e.metaKey);
        }}
      />
      <IconButton
        size="sm"
        variant={data.pinned ? 'primary' : 'ghost'}
        label={data.pinned ? 'Unpin' : 'Pin in place'}
        tooltip={data.pinned ? 'Pinned: locked in place. Click to unpin and allow dragging' : 'Pin in place so it cannot be dragged'}
        icon={<Icon name={data.pinned ? 'pinned' : 'pin'} size={14} />}
        onClick={(e) => {
          stop(e);
          onPinFrame(seam.id);
        }}
      />
      <IconButton
        size="sm"
        variant="ghost"
        label={data.collapsed ? 'Expand seam' : 'Collapse seam'}
        tooltip={data.collapsed ? 'Expand seam' : 'Collapse seam'}
        icon={<Icon name={data.collapsed ? 'plus' : 'shrink'} size={14} />}
        onClick={(e) => {
          stop(e);
          onToggleFrame(seam.id);
        }}
      />
    </span>
  );
  const grip = <Icon name={data.pinned ? 'pinned' : 'grip'} size={16} className="lr-grip" />;
  const status = (
    <>
      {seam.goal?.size && <span className="lr-size">{seam.goal.size}</span>}
      <StatusToken label={SEAM_LABEL[seam.status]} hue={SEAM_HUE[seam.status]} />
      <Progress done={seam.done} total={seam.total} />
    </>
  );
  const className = cx(
    'lr-frame',
    `seam-${seam.status}`,
    isFocused && 'is-focused',
    data.pinned && 'is-pinned',
    data.collapsed && 'is-collapsed',
    selected === id && 'is-selected',
    data.entering && 'lr-enter',
  );
  if (data.collapsed) {
    return (
      <div className={className}>
        <div className={cx('lr-frame-head', data.pinned && 'nopan')}>
          {grip}
          <span ref={titleRef} className="lr-frame-title">
            {seam.title}
          </span>
          <CanvasHint anchorRef={titleRef} content={seam.title} placement="below" />
          {tools}
        </div>
        <div className="lr-frame-body">
          {status}
          <span className="lr-muted">
            {seam.actions.length} action{seam.actions.length === 1 ? '' : 's'}
          </span>
          {seam.humanQueue > 0 && (
            <span className="lr-needs-you">
              <Icon name="person" size={12} /> {seam.humanQueue} waiting on you
            </span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={className}>
      <div className={cx('lr-frame-head', data.pinned && 'nopan')}>
        {grip}
        <span ref={titleRef} className="lr-frame-title">
          {seam.title}
        </span>
        <CanvasHint anchorRef={titleRef} content={seam.title} placement="below" />
        {status}
        {tools}
      </div>
    </div>
  );
}

export const nodeTypes = { action: ActionNode, group: GroupNode, artefact: ArtefactNode, seam: SeamNode };
