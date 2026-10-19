// State -> one ELK graph per workflow plus React Flow edges. Each workflow
// (connected component) lays out independently inside a frame, so adding a
// goal never reshuffles another. Decomposed actions become compound nodes;
// collapsed groups and frames fold their contents onto a single node.

import type { Edge } from '@xyflow/react';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import {
  containerOf,
  workflows,
  type ActionState,
  type ArtefactState,
  type State,
  type Workflow,
} from '@coalface/core';

export const ACTION_W = 236;
export const ACTION_H = 88;
export const ARTEFACT_W = 224;
export const ARTEFACT_H = 46;
export const FRAME_HEAD = 56;
export const FRAME_MIN_W = 460;
export const FRAME_COLLAPSED_W = 360;
export const FRAME_COLLAPSED_H = 112;

export const frameId = (wfId: string): string => `wf:${wfId}`;
export const isFrameId = (id: string): boolean => id.startsWith('wf:');
export const unframe = (id: string): string => (isFrameId(id) ? id.slice(3) : id);

export interface FrameState {
  /** Where the user put it; a frame without a position stacks automatically. */
  x?: number;
  y?: number;
  /** Pinned frames are locked: they cannot be dragged. */
  pinned?: boolean;
  collapsed?: boolean;
}

export interface BuildOptions {
  collapsedGroups: Set<string>;
  frames: Record<string, FrameState>;
  /** Workflow ids in focus; empty means all. */
  focus: string[];
}

export type VisualType = 'action' | 'artefact' | 'group';

export interface VisualMeta {
  type: VisualType;
  container?: string;
  action?: ActionState;
  artefact?: ArtefactState;
  collapsed: boolean;
  childCount: number;
  doneCount: number;
  finish: boolean;
}

export interface BuiltComponent {
  wf: Workflow;
  collapsed: boolean;
  pinned: boolean;
  dim: boolean;
  elk?: ElkNode;
  meta: Map<string, VisualMeta>;
  edges: Edge[];
}

export interface Built {
  components: BuiltComponent[];
  /** Frame node id -> component. */
  frames: Map<string, BuiltComponent>;
  /** Entity id -> frame node id. */
  frameOf: Map<string, string>;
  meta: Map<string, VisualMeta>;
  edges: Edge[];
}

const LAYER_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.nodeNode': '22',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.componentComponent': '40',
  // Model order (creation order, with outputs placed after their producers)
  // breaks ties deterministically so additions do not reshuffle the graph.
  // Real cycles are rare because loops are version advances, so greedy
  // cycle breaking keeps every edge flowing left to right.
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.layered.thoroughness': '10',
};

const FRAME_OPTIONS: Record<string, string> = {
  ...LAYER_OPTIONS,
  'elk.padding': `[top=${FRAME_HEAD + 18},left=24,bottom=24,right=24]`,
};

const GROUP_OPTIONS: Record<string, string> = {
  'elk.padding': '[top=52,left=22,bottom=22,right=22]',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '20',
};

export function build(s: State, opts: BuildOptions): Built {
  const wfs = workflows(s);
  const finish = new Set(wfs.list.flatMap((w) => w.deliverables));
  const isGroup = (id: string): boolean => (s.actions[id]?.children.length ?? 0) > 0;

  // Model order: an artefact sits right after the first action that produces
  // it, so a deliverable declared inline with its action lays out downstream.
  const producerSeq = new Map<string, number>();
  for (const t of Object.values(s.actions)) {
    for (const o of t.outputs) {
      const cur = producerSeq.get(o);
      if (cur === undefined || t.seq < cur) producerSeq.set(o, t.seq);
    }
  }
  const orderKey = (id: string): number => {
    const t = s.actions[id];
    if (t) return t.seq;
    const p = producerSeq.get(id);
    return p !== undefined ? p + 0.5 : (s.artefacts[id]?.seq ?? 0);
  };
  const ordered = [...s.order].sort((x, y) => orderKey(x) - orderKey(y));

  const components: BuiltComponent[] = [];
  const frames = new Map<string, BuiltComponent>();
  const frameOf = new Map<string, string>();
  const allMeta = new Map<string, VisualMeta>();
  const allEdges: Edge[] = [];

  for (const wf of wfs.list) {
    const fid = frameId(wf.id);
    const frame = opts.frames[wf.id];
    const collapsed = !!frame?.collapsed;
    const pinned = !!frame?.pinned;
    const dim = opts.focus.length > 0 && !opts.focus.includes(wf.id);
    const members = new Set([...wf.actions, ...wf.artefacts]);
    for (const m of members) frameOf.set(m, fid);

    const c: BuiltComponent = { wf, collapsed, pinned, dim, meta: new Map(), edges: [] };
    components.push(c);
    frames.set(fid, c);
    if (collapsed) continue;

    // A decomposed goal is represented by the frame itself: its children lay
    // out directly inside, and its status lives in the frame header.
    const goalGroup = wf.goal && isGroup(wf.goal.id) ? wf.goal.id : undefined;
    const collapsible = (id: string): boolean => isGroup(id) && id !== goalGroup && opts.collapsedGroups.has(id);

    /** Topmost collapsed group among an action's ancestors, starting at `from` inclusive. */
    const topCollapsed = (from: string | undefined): string | undefined => {
      let top: string | undefined;
      let cur = from;
      while (cur) {
        if (collapsible(cur)) top = cur;
        cur = s.actions[cur]?.parent;
      }
      return top;
    };
    /** The visible node that stands for an entity (itself, or a collapsed ancestor). */
    const visibleId = (id: string): string => {
      const t = s.actions[id];
      if (t) return topCollapsed(t.parent) ?? id;
      const a = s.artefacts[id];
      if (a) return topCollapsed(containerOf(s, a.parent)) ?? id;
      return id;
    };
    /** Container node id, with the goal group mapping to the frame root. */
    const containerIn = (parent: string | undefined): string | undefined => {
      const cId = containerOf(s, parent);
      return cId === goalGroup ? undefined : cId;
    };

    const elkNodes = new Map<string, ElkNode>();
    for (const id of ordered) {
      if (!members.has(id)) continue;
      if (id === goalGroup) continue; // the frame stands in for it
      if (visibleId(id) !== id) continue; // hidden inside a collapsed group
      const t = s.actions[id];
      if (t) {
        const group = isGroup(id);
        const isCollapsed = collapsible(id);
        const type: VisualType = group && !isCollapsed ? 'group' : 'action';
        const kids = t.children.map((k) => s.actions[k]!);
        c.meta.set(id, {
          type,
          container: containerIn(t.parent),
          action: t,
          collapsed: isCollapsed,
          childCount: kids.length,
          doneCount: kids.filter((k) => k.status === 'done').length,
          finish: false,
        });
        elkNodes.set(id, {
          id,
          width: ACTION_W,
          height: ACTION_H,
          ...(type === 'group' ? { children: [], layoutOptions: GROUP_OPTIONS } : {}),
        });
        continue;
      }
      const a = s.artefacts[id];
      if (a) {
        c.meta.set(id, {
          type: 'artefact',
          container: containerIn(a.parent),
          artefact: a,
          collapsed: false,
          childCount: 0,
          doneCount: 0,
          finish: finish.has(id),
        });
        elkNodes.set(id, { id, width: ARTEFACT_W, height: ARTEFACT_H });
      }
    }

    const root: ElkNode = { id: fid, layoutOptions: FRAME_OPTIONS, children: [], edges: [] };
    for (const [id, m] of c.meta) {
      const node = elkNodes.get(id)!;
      const parent = m.container ? elkNodes.get(m.container) : undefined;
      if (parent && parent.children) parent.children.push(node);
      else root.children!.push(node);
    }

    const seen = new Set<string>();
    const elkEdges: ElkExtendedEdge[] = [];
    const addEdge = (src: string, dst: string, input: boolean) => {
      if (src === dst) return;
      const id = `${src}->${dst}`;
      if (seen.has(id)) return;
      seen.add(id);
      c.edges.push({ id, source: src, target: dst, type: 'smoothstep', data: { input } });
      elkEdges.push({ id, sources: [src], targets: [dst] });
    };
    for (const id of ordered) {
      if (!members.has(id)) continue;
      const t = s.actions[id];
      if (!t) continue;
      if (id === goalGroup) continue; // its children carry the flow
      if (c.meta.get(id)?.type === 'group') continue; // expanded group: children carry the flow
      const me = visibleId(id);
      for (const i of t.inputs) if (s.artefacts[i]) addEdge(visibleId(i), me, true);
      for (const o of t.outputs) if (s.artefacts[o]) addEdge(me, visibleId(o), false);
    }
    root.edges = elkEdges;
    c.elk = root;
    for (const [id, m] of c.meta) allMeta.set(id, m);
    allEdges.push(...c.edges);
  }

  return { components, frames, frameOf, meta: allMeta, edges: allEdges };
}
