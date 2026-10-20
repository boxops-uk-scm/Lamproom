// State -> one ELK graph per seam plus React Flow edges. Each seam
// (connected component) lays out independently inside a frame, so adding a
// goal never reshuffles another. Decomposed actions become compound nodes;
// collapsed groups and frames fold their contents onto a single node.

import type { Edge } from '@xyflow/react';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import {
  containerOf,
  seams,
  type ActionState,
  type ArtefactState,
  type State,
  type Seam,
} from '@lamproom/core';

export const ACTION_W = 236;
export const ACTION_H = 88;
export const ARTEFACT_W = 224;
export const ARTEFACT_H = 46;
export const FRAME_HEAD = 56;
// Ports view: an action card is a head plus one row per port, inputs down the
// left and outputs down the right, like a node in a node editor.
export const PORT_W = 300;
export const PORT_MAX_W = 440;
/** Card width for its longest port label on either side: pad, icon, gap, text at ~6.6px a character, pad. */
const portWidth = (labels: string[]): number => {
  const longest = Math.max(0, ...labels.map((l) => l.length));
  return Math.round(Math.min(PORT_MAX_W, Math.max(PORT_W, 2 * (12 + 12 + 6 + longest * 6.4 + 14))));
};
/** Card padding, head, title, meta and the gaps between them, as styles.css lays them out. */
export const PORT_HEAD = 87;
export const PORT_ROW = 26;
export const PORT_PAD = 8;
export const FRAME_MIN_W = 460;
export const FRAME_COLLAPSED_W = 360;
export const FRAME_COLLAPSED_H = 112;

export const portHandle = (side: 'in' | 'out', artefactId: string): string => `${side}:${artefactId}`;
const elkPort = (node: string, side: 'in' | 'out', artefactId: string): string => `${node}|${side}|${artefactId}`;

const FRAME_PREFIX = 'seam:';
export const frameId = (wfId: string): string => `${FRAME_PREFIX}${wfId}`;
export const isFrameId = (id: string): boolean => id.startsWith(FRAME_PREFIX);
export const unframe = (id: string): string => (isFrameId(id) ? id.slice(FRAME_PREFIX.length) : id);

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
  /** Seam ids in focus; empty means all. */
  focus: string[];
  /** Artefacts become ports on the actions that produce and consume them, not nodes. */
  ports?: boolean;
}

export interface Port {
  /** The artefact the port carries. */
  id: string;
  artefact: ArtefactState;
  /** Some other visible node is wired to it. */
  wired: boolean;
  finish: boolean;
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
  /** Ports view only. */
  ports?: { inputs: Port[]; outputs: Port[] };
}

export interface BuiltComponent {
  seam: Seam;
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

const PORT_OPTIONS: Record<string, string> = {
  'elk.json.edgeCoords': 'ROOT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  'elk.spacing.edgeEdge': '12',
  'elk.spacing.nodeNode': '28',
};

const GROUP_OPTIONS: Record<string, string> = {
  'elk.padding': '[top=52,left=22,bottom=22,right=22]',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '20',
};

export function build(s: State, opts: BuildOptions): Built {
  const allSeams = seams(s);
  const finish = new Set(allSeams.list.flatMap((w) => w.deliverables));
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

  for (const seam of allSeams.list) {
    const fid = frameId(seam.id);
    const frame = opts.frames[seam.id];
    const collapsed = !!frame?.collapsed;
    const pinned = !!frame?.pinned;
    const dim = opts.focus.length > 0 && !opts.focus.includes(seam.id);
    const members = new Set([...seam.actions, ...seam.artefacts]);
    for (const m of members) frameOf.set(m, fid);

    const c: BuiltComponent = { seam, collapsed, pinned, dim, meta: new Map(), edges: [] };
    components.push(c);
    frames.set(fid, c);
    if (collapsed) continue;

    // A decomposed goal is represented by the frame itself: its children lay
    // out directly inside, and its status lives in the frame header.
    const goalGroup = seam.goal && isGroup(seam.goal.id) ? seam.goal.id : undefined;
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

    if (opts.ports) {
      buildPorts(s, c, { ordered, members, goalGroup, finish, isGroup, collapsible, visibleId, containerIn, fid });
      for (const [id, m] of c.meta) allMeta.set(id, m);
      allEdges.push(...c.edges);
      continue;
    }

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

interface PortCtx {
  ordered: string[];
  members: Set<string>;
  goalGroup: string | undefined;
  finish: Set<string>;
  isGroup: (id: string) => boolean;
  collapsible: (id: string) => boolean;
  visibleId: (id: string) => string;
  containerIn: (parent: string | undefined) => string | undefined;
  fid: string;
}

/**
 * The ports view of one seam. Only actions are nodes; each artefact becomes
 * an output port on every visible action that produces it and an input port
 * on every one that consumes it, and a wire joins each producer's port to
 * each consumer's. A collapsed group shows only the ports that cross its
 * boundary. An artefact no visible action touches (declared but not yet
 * wired anywhere) stays a node, so nothing disappears.
 */
function buildPorts(s: State, c: BuiltComponent, x: PortCtx): void {
  // Leaf actions carry the flow; expanded groups and the goal group are frames.
  const isNode = (id: string) => id !== x.goalGroup && x.visibleId(id) === id && (!x.isGroup(id) || x.collapsible(id));
  const producers = new Map<string, Set<string>>();
  const consumers = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, a: string, n: string) => {
    const set = m.get(a);
    if (set) set.add(n);
    else m.set(a, new Set([n]));
  };
  const ins = new Map<string, string[]>();
  const outs = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, n: string, a: string) => {
    const list = m.get(n);
    if (!list) m.set(n, [a]);
    else if (!list.includes(a)) list.push(a);
  };
  for (const id of x.ordered) {
    const t = x.members.has(id) ? s.actions[id] : undefined;
    if (!t || t.children.length) continue;
    const me = x.visibleId(id);
    if (!isNode(me)) continue;
    for (const i of t.inputs) if (s.artefacts[i]) (add(consumers, i, me), push(ins, me, i));
    for (const o of t.outputs) if (s.artefacts[o]) (add(producers, o, me), push(outs, me, o));
  }
  // A collapsed group keeps only its boundary: an artefact made and used
  // entirely inside it is not a port, and one it makes for itself is an output, not an input.
  for (const [n, list] of ins) {
    ins.set(n, list.filter((a) => !producers.get(a)?.has(n)));
  }
  for (const [n, list] of outs) {
    const t = s.actions[n]!;
    outs.set(n, list.filter((a) => {
      const users = consumers.get(a);
      return !users || [...users].some((u) => u !== n) || t.outputs.includes(a);
    }));
  }

  const elkNodes = new Map<string, ElkNode>();
  for (const id of x.ordered) {
    if (!x.members.has(id)) continue;
    const t = s.actions[id];
    if (t) {
      if (id === x.goalGroup || x.visibleId(id) !== id) continue;
      const group = x.isGroup(id) && !x.collapsible(id);
      const kids = t.children.map((k) => s.actions[k]!);
      const port = (a: string, other: Map<string, Set<string>>): Port => ({
        id: a,
        artefact: s.artefacts[a]!,
        wired: [...(other.get(a) ?? [])].some((n) => n !== id),
        finish: x.finish.has(a),
      });
      const inputs = group ? [] : (ins.get(id) ?? []).map((a) => port(a, producers));
      const outputs = group ? [] : (outs.get(id) ?? []).map((a) => port(a, consumers));
      c.meta.set(id, {
        type: group ? 'group' : 'action',
        container: x.containerIn(t.parent),
        action: t,
        collapsed: x.collapsible(id),
        childCount: kids.length,
        doneCount: kids.filter((k) => k.status === 'done').length,
        finish: false,
        ports: group ? undefined : { inputs, outputs },
      });
      const rows = Math.max(inputs.length, outputs.length);
      const h = PORT_HEAD + (rows ? rows * PORT_ROW + PORT_PAD : 0);
      const w = group ? PORT_W : portWidth([...inputs, ...outputs].map((p) => p.artefact.title));
      elkNodes.set(id, {
        id,
        width: w,
        height: group ? ACTION_H : h,
        ...(group
          ? { children: [], layoutOptions: GROUP_OPTIONS }
          : {
              layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
              ports: [
                ...inputs.map((p, i) => ({ id: elkPort(id, 'in', p.id), x: 0, y: 1 + PORT_HEAD + i * PORT_ROW + PORT_ROW / 2, width: 1, height: 1 })),
                ...outputs.map((p, i) => ({ id: elkPort(id, 'out', p.id), x: w - 1, y: 1 + PORT_HEAD + i * PORT_ROW + PORT_ROW / 2, width: 1, height: 1 })),
              ],
            }),
      });
      continue;
    }
    const a = s.artefacts[id];
    if (a && !producers.has(id) && !consumers.has(id) && x.visibleId(id) === id) {
      c.meta.set(id, {
        type: 'artefact',
        container: x.containerIn(a.parent),
        artefact: a,
        collapsed: false,
        childCount: 0,
        doneCount: 0,
        finish: x.finish.has(id),
      });
      elkNodes.set(id, { id, width: ARTEFACT_W, height: ARTEFACT_H });
    }
  }

  // Every route in the frame's coordinates, whichever group its ends sit in.
  const root: ElkNode = { id: x.fid, layoutOptions: { ...FRAME_OPTIONS, ...PORT_OPTIONS }, children: [], edges: [] };
  for (const [id, m] of c.meta) {
    const node = elkNodes.get(id)!;
    const parent = m.container ? elkNodes.get(m.container) : undefined;
    if (parent && parent.children) parent.children.push(node);
    else root.children!.push(node);
  }

  const elkEdges: ElkExtendedEdge[] = [];
  for (const [a, from] of producers) {
    for (const p of from) {
      if (!c.meta.get(p)?.ports?.outputs.some((o) => o.id === a)) continue;
      for (const q of consumers.get(a) ?? []) {
        if (p === q || !c.meta.get(q)?.ports?.inputs.some((i) => i.id === a)) continue;
        const id = `${p}:${a}->${q}`;
        c.edges.push({
          id,
          source: p,
          target: q,
          sourceHandle: portHandle('out', a),
          targetHandle: portHandle('in', a),
          type: 'routed',
          data: { artefact: a, status: s.artefacts[a]!.status },
        });
        elkEdges.push({ id, sources: [elkPort(p, 'out', a)], targets: [elkPort(q, 'in', a)] });
      }
    }
  }
  root.edges = elkEdges;
  c.elk = root;
}
