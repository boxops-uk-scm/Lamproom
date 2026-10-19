// Core vocabulary of the coalface workflow algebra.
// Artefacts are nodes, actions are hyperedges (inputs -> outputs), and
// everything is derived from an append-only event log.

/**
 * Rich text is Markdown (CommonMark with GFM lists, task lists and tables).
 * It is the primitive for every piece of prose in the log: descriptions,
 * criteria, questions and answers, notes and reasons. Agents write it
 * directly, the UI edits it with a rich text editor and renders it, and the
 * terminal sees it flattened (see richtext.ts). Titles are plain text.
 */
export type RichText = string;

export type Rung = 'owned' | 'verified' | 'reported' | 'inferred';
export type ActorKind = 'human' | 'agent';

export interface Actor {
  id: string;
  kind: ActorKind;
  name?: string;
  /** For agents: the human on whose behalf they act. */
  principal?: string;
}

export const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type Size = (typeof SIZES)[number];

export const JUDGEMENTS = ['implement', 'decompose', 'yield', 'abandon'] as const;
export type Judgement = (typeof JUDGEMENTS)[number];

export interface Requirement {
  actorKind: ActorKind;
  count?: number;
}

export interface ArtefactDecl {
  id: string;
  kind: string;
  title: string;
  criteria?: RichText[];
  /** Grouping action this artefact was declared under. */
  parent?: string;
  /** Terminal artefact produced by this artefact's policy atom, if any. */
  closedTo?: string;
  /** Artefact whose declaration expanded into this one. */
  expandedFrom?: string;
}

export interface ActionDecl {
  id: string;
  title: string;
  description?: RichText;
  parent?: string;
  inputs: string[];
  outputs: string[];
  size?: Size;
  requires?: Requirement;
  expandedFrom?: string;
}

export interface Evaluation {
  judgement: Judgement;
  size?: Size;
  criteria?: RichText[];
  unknowns?: RichText[];
  rationale?: RichText;
}

export type EventPayload =
  | { type: 'artefact.declared'; artefact: ArtefactDecl }
  | { type: 'artefact.version'; artefactId: string; ref: string; note?: RichText }
  | { type: 'artefact.accepted'; artefactId: string; ref?: string; note?: RichText }
  | { type: 'artefact.rejected'; artefactId: string; ref?: string; reasons: RichText[] }
  | { type: 'artefact.invalidated'; artefactId: string; reason: RichText }
  | { type: 'action.proposed'; action: ActionDecl }
  | ({ type: 'action.evaluated'; actionId: string } & Evaluation)
  | {
      type: 'action.amended';
      actionId: string;
      addInputs?: string[];
      removeInputs?: string[];
      addOutputs?: string[];
      removeOutputs?: string[];
      size?: Size;
      title?: string;
    }
  | { type: 'action.claimed'; actionId: string }
  | { type: 'action.released'; actionId: string; reason?: RichText }
  | { type: 'action.progressed'; actionId: string; note: RichText }
  | { type: 'action.completed'; actionId: string; note?: RichText }
  | { type: 'action.abandoned'; actionId: string; reason?: RichText }
  /** Undoes an abandonment: the action is workable again as its inputs allow. */
  | { type: 'action.restored'; actionId: string; note?: RichText }
  /** Undoes a completion: the action is workable again; its outputs keep their versions. */
  | { type: 'action.reopened'; actionId: string; note?: RichText };

export type EventType = EventPayload['type'];

export type Event = EventPayload & {
  id: string;
  ts: string;
  /** Who wrote the event. */
  actor: Actor;
  /** Whose decision it records, when an agent relays a human's answer or verdict. */
  onBehalfOf?: Actor;
  rung: Rung;
  /** Event schema version (SCHEMA_VERSION when written); readers upcast older shapes. */
  v?: number;
  /** Global position, assigned by the store at commit. Orders events across streams. */
  seq?: number;
  /** The workflow stream this event belongs to, assigned by the store at commit. */
  stream?: string;
  /** Position within its stream, dense from 1, assigned by the store at commit. */
  rev?: number;
};

/** Bumped when the event shape changes; see upcast.ts. */
export const SCHEMA_VERSION = 1;
/** Bumped when the projection changes; stored snapshots with another version are rebuilt. */
export const PROJECTION_VERSION = 2;

// ---- Policy -------------------------------------------------------------

/**
 * An atom replaces a naked artefact kind with a small workflow fragment:
 * naked -> action (typed to an actor kind) -> terminal artefact.
 * Expansion fires on declaration, never on version advance.
 */
export interface Atom {
  terminal: string;
  terminalTitle?: string;
  /** May an agent relay the human's decision from chat? Default false. */
  relay?: boolean;
  action: {
    title: string;
    description?: RichText;
    requires: Requirement;
    size?: Size;
  };
}

export interface Policy {
  atoms: Record<string, Atom>;
}

// ---- Derived state ------------------------------------------------------

export type ArtefactStatus = 'declared' | 'produced' | 'accepted' | 'rejected' | 'invalidated';

export interface Version {
  ref: string;
  ts: string;
  seq: number;
  by: Actor;
  /** The relaying agent, when `by` is a human who answered in chat. */
  via?: Actor;
  note?: RichText;
}

export interface ArtefactState extends ArtefactDecl {
  seq: number;
  versions: Version[];
  acceptedRef?: string;
  acceptedBy: Actor[];
  rejectedRef?: string;
  rejections: RichText[];
  invalidated?: RichText;
  status: ArtefactStatus;
  /** Produced or accepted, i.e. usable as an input. */
  valid: boolean;
  /** Valid, and if there is a terminal, the terminal is accepted. */
  closed: boolean;
}

export type ActionStatus =
  | 'blocked'
  | 'ready'
  | 'active'
  | 'submitted'
  | 'rework'
  | 'decomposed'
  | 'done'
  | 'abandoned';

export interface LogEntry {
  seq: number;
  ts: string;
  type: EventType;
  actor: Actor;
  via?: Actor;
  note?: RichText;
}

export interface ActionState extends ActionDecl {
  seq: number;
  children: string[];
  claimedBy?: Actor;
  evaluation?: Evaluation;
  evaluations: (Evaluation & { seq: number; actor: Actor })[];
  completed: boolean;
  abandoned?: RichText;
  log: LogEntry[];
  status: ActionStatus;
  enabled: boolean;
  blockedOn: string[];
}

export interface State {
  artefacts: Record<string, ArtefactState>;
  actions: Record<string, ActionState>;
  /** Node ids in creation order. Drives deterministic layout. */
  order: string[];
  events: Event[];
  warnings: string[];
}
