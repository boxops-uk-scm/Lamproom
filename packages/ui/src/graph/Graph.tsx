import {
  Background,
  BackgroundVariant,
  Panel,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import type { State } from '@lamproom/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { build, frameId, isFrameId, unframe, type Built, type FrameState } from './build';
import { layoutAll, toNode, type Placed } from './layout';
import { IconButton } from '@astryxdesign/core/IconButton';
import { GraphContext, Icon, nodeTypes, type ActionData } from './nodes';

interface Props {
  state: State;
  collapsedGroups: Set<string>;
  frames: Record<string, FrameState>;
  /** Seam ids in focus; empty means all. */
  focus: string[];
  selected?: string;
  theme: 'light' | 'dark';
  /** Increment to force a fit and re-enable auto-fit. */
  fitKey: number;
  /** Scrubbing history: each change jumps into place instead of animating. */
  replaying: boolean;
  onSelect: (id: string | undefined) => void;
  onToggleGroup: (id: string) => void;
  onToggleFrame: (id: string) => void;
  onPinFrame: (id: string, position?: { x: number; y: number }) => void;
  onMoveFrame: (id: string, position: { x: number; y: number }) => void;
  onFocus: (id: string | undefined, additive?: boolean) => void;
}

const PALETTE = {
  light: {
    ready: '#d97706', rework: '#dc2626', active: '#2563eb', submitted: '#7c3aed', blocked: '#b4bac4',
    decomposed: '#0e7490', done: '#16a34a', abandoned: '#c4c8cf', artefact: '#8e96a3', group: '#e4e8ee', frame: '#eef0f4',
  },
  dark: {
    ready: '#f59e0b', rework: '#f87171', active: '#60a5fa', submitted: '#a78bfa', blocked: '#4b5563',
    decomposed: '#22d3ee', done: '#4ade80', abandoned: '#4b5563', artefact: '#6b7280', group: '#262b35', frame: '#1b1f27',
  },
};

const DURATION = 460;
const FIT = { padding: 0.18, duration: 350 };
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export function Graph({
  state, collapsedGroups, frames, focus, selected, theme, fitKey, replaying,
  onSelect, onToggleGroup, onToggleFrame, onPinFrame, onMoveFrame, onFocus,
}: Props) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const nodesRef = useRef<Node[]>([]);
  /** Where the last layout put everything; the transition starts from here. */
  const prev = useRef<Map<string, Placed>>(new Map());
  /** The layout being transitioned to, and its final nodes, so a drag can snap to it. */
  const target = useRef<{ to: Map<string, Placed>; nodes: Node[] } | null>(null);
  const raf = useRef(0);
  const gen = useRef(0);
  const dragging = useRef(false);
  const layoutDeferred = useRef(false);
  const [bump, setBump] = useState(0);
  /** Auto-fit the viewport after each layout until the user pans or zooms. */
  const autoFit = useRef(true);
  const hasFit = useRef(false);
  const pendingFocusFit = useRef(false);
  const rf = useReactFlow();
  // A layout animates only when neither it nor the one before was a replay,
  // so scrubbing, and the jump back to live, never animate.
  const replayingRef = useRef(replaying);
  replayingRef.current = replaying;
  const wasReplaying = useRef(replaying);
  // Focus is read through a ref by the layout callbacks; its key drives the effects.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const focusKey = focus.join('|');

  // Frame positions are read at layout time but never trigger a layout while
  // dragging: the frame moves directly. Collapsing, pinning, and whether a
  // frame has a position at all are structural, because they change how the
  // other frames stack; a drop re-stacks explicitly.
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const structureKey = useMemo(
    () =>
      Object.entries(frames)
        .map(([id, f]) => `${id}:${f.collapsed ? 1 : 0}${f.pinned ? 1 : 0}${f.x !== undefined ? 1 : 0}`)
        .sort()
        .join('|'),
    [frames],
  );

  const fitFocus = useCallback(
    (ids: string[], instant = false) => {
      rf.fitView({ nodes: ids.map((id) => ({ id: frameId(id) })), padding: 0.2, duration: instant ? 0 : 400 });
    },
    [rf],
  );

  const settle = useCallback(
    (finals: Node[], to: Map<string, Placed>, instant: boolean) => {
      nodesRef.current = finals;
      setNodes(finals);
      prev.current = to;
      target.current = null;
      const f = focusRef.current;
      const framed = f.length > 0 && f.every((id) => to.has(frameId(id)));
      if (pendingFocusFit.current && framed) {
        pendingFocusFit.current = false;
        window.setTimeout(() => fitFocus(f, instant), 30);
      } else if (autoFit.current && to.size) {
        const jump = instant || !hasFit.current;
        hasFit.current = true;
        window.setTimeout(() => {
          if (framed) fitFocus(f, jump);
          else rf.fitView(jump ? { ...FIT, duration: 0 } : FIT);
        }, 30);
      }
    },
    [fitFocus, rf],
  );

  const applyLayout = useCallback(
    (placed: Placed[], built: Built) => {
      cancelAnimationFrame(raf.current);
      const from = prev.current;
      const to = new Map(placed.map((p) => [p.id, p]));
      const instant = replayingRef.current || wasReplaying.current;
      wasReplaying.current = replayingRef.current;
      const animate = from.size > 0 && !instant;
      const finals = placed.map((p) => toNode(p, built, animate && !from.has(p.id)));
      setEdges(built.edges);
      // Only nodes that actually move get fresh objects during the transition;
      // everything else keeps its identity and does not re-render.
      const movers = placed.filter((p) => {
        const a = from.get(p.id);
        return a && a.parentId === p.parentId && (a.x !== p.x || a.y !== p.y);
      });
      if (!animate || movers.length === 0) {
        settle(finals, to, instant);
        return;
      }
      target.current = { to, nodes: finals };
      const start = performance.now();
      const step = (now: number) => {
        const k = ease(Math.min(1, (now - start) / DURATION));
        if (k >= 1) {
          settle(finals, to, false);
          return;
        }
        const moved = new Map(
          movers.map((p) => {
            const a = from.get(p.id)!;
            return [p.id, { x: lerp(a.x, p.x, k), y: lerp(a.y, p.y, k) }];
          }),
        );
        const next = finals.map((n) => {
          const m = moved.get(n.id);
          return m ? { ...n, position: m } : n;
        });
        nodesRef.current = next;
        setNodes(next);
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    },
    [settle],
  );

  useEffect(() => {
    const built = build(state, { collapsedGroups, frames: framesRef.current, focus: focusRef.current });
    const g = ++gen.current;
    let cancelled = false;
    layoutAll(built, framesRef.current)
      .then((placed) => {
        if (cancelled || g !== gen.current) return;
        if (dragging.current) {
          // Never fight a drag in progress; lay out again after the drop.
          layoutDeferred.current = true;
          return;
        }
        applyLayout(placed, built);
      })
      .catch((e) => console.error('layout failed', e));
    return () => {
      cancelled = true;
    };
  }, [state, collapsedGroups, structureKey, focusKey, bump, applyLayout]);

  useEffect(() => {
    if (fitKey === 0) return;
    autoFit.current = true;
    const f = focusRef.current;
    if (f.length) fitFocus(f);
    else rf.fitView(FIT);
  }, [fitKey, rf, focusKey, fitFocus]);

  // Focusing seams brings them into view, now or after the next layout.
  useEffect(() => {
    const f = focusRef.current;
    if (!f.length) return;
    if (f.every((id) => nodesRef.current.some((n) => n.id === frameId(id)))) fitFocus(f);
    else pendingFocusFit.current = true;
  }, [focusKey, fitFocus]);

  const styledEdges = useMemo(
    () =>
      edges.map((e) => {
        const hot = !!selected && (e.source === selected || e.target === selected);
        return {
          ...e,
          className: hot ? 'lr-edge is-hot' : 'lr-edge',
          zIndex: hot ? 1000 : 0,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          pathOptions: { borderRadius: 14 },
        } as Edge;
      }),
    [edges, selected],
  );

  const pin = useCallback(
    (id: string) => {
      const n = nodesRef.current.find((x) => x.id === frameId(id));
      onPinFrame(id, n ? { x: n.position.x, y: n.position.y } : undefined);
    },
    [onPinFrame],
  );

  const ctx = useMemo(
    () => ({ selected, focused: focus, onToggle: onToggleGroup, onToggleFrame, onPinFrame: pin, onFocus }),
    [selected, focus, onToggleGroup, onToggleFrame, pin, onFocus],
  );
  const colours = PALETTE[theme];

  return (
    <GraphContext.Provider value={ctx}>
      <ReactFlow
        className={replaying ? 'is-replaying' : undefined}
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => {
          // Keep the transition's starting positions in step with user drags.
          for (const ch of changes) {
            if (ch.type === 'position' && ch.position) {
              const p = prev.current.get(ch.id);
              if (p) prev.current.set(ch.id, { ...p, x: ch.position.x, y: ch.position.y });
            }
          }
          setNodes((ns) => {
            const next = applyNodeChanges(changes, ns);
            nodesRef.current = next;
            return next;
          });
        }}
        onNodeDragStart={() => {
          dragging.current = true;
          // Arranging frames by hand ends automatic fitting.
          autoFit.current = false;
          // Snap any running transition to its end so the drag owns the node.
          if (target.current) {
            cancelAnimationFrame(raf.current);
            const { to, nodes: finals } = target.current;
            nodesRef.current = finals;
            setNodes(finals);
            prev.current = to;
            target.current = null;
          }
        }}
        onNodeDragStop={(_, n) => {
          dragging.current = false;
          layoutDeferred.current = false;
          if (isFrameId(n.id)) onMoveFrame(unframe(n.id), { x: n.position.x, y: n.position.y });
          // The dropped frame stays put; the automatic ones re-stack around it.
          setBump((b) => b + 1);
        }}
        onNodeClick={(_, n) => onSelect(n.id)}
        onNodeDoubleClick={(e, n) => {
          // Double-click expands anything collapsed; on an open frame it focuses
          // (with a modifier, adds to the focus).
          if (isFrameId(n.id)) {
            const id = unframe(n.id);
            if (framesRef.current[id]?.collapsed) onToggleFrame(id);
            else onFocus(id, e.shiftKey || e.ctrlKey || e.metaKey);
          } else if (n.type === 'action' && (n.data as ActionData).collapsed) {
            onToggleGroup(n.id);
          }
        }}
        onPaneClick={(e) => {
          // A click on the canvas clears the selection; a double-click clears the focus.
          onSelect(undefined);
          if (e.detail === 2) onFocus(undefined);
        }}
        onMoveStart={(event) => {
          // A user gesture carries an event; programmatic fits do not.
          if (event) autoFit.current = false;
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2.2}
        proOptions={{ hideAttribution: true }}
        colorMode={theme}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.1} />
        {/* Zoom controls as Astryx buttons, so their hints are Astryx tooltips. */}
        <Panel position="bottom-right" className="lr-controls">
          <IconButton size="sm" variant="secondary" label="Zoom in" tooltip="Zoom in" icon={<Icon name="plus" size={14} />} onClick={() => rf.zoomIn({ duration: 200 })} />
          <IconButton size="sm" variant="secondary" label="Zoom out" tooltip="Zoom out" icon={<Icon name="minus" size={14} />} onClick={() => rf.zoomOut({ duration: 200 })} />
          <IconButton size="sm" variant="secondary" label="Fit view" tooltip="Fit view" icon={<Icon name="fit" size={14} />} onClick={() => rf.fitView({ padding: 0.2, duration: 300 })} />
        </Panel>
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeStrokeWidth={0}
          nodeBorderRadius={4}
          nodeColor={(n) => {
            if (n.type === 'seam') return colours.frame;
            if (n.type === 'artefact') return colours.artefact;
            if (n.type === 'group') return colours.group;
            const st = (n.data as ActionData).action?.status ?? 'blocked';
            return colours[st];
          }}
        />
      </ReactFlow>
    </GraphContext.Provider>
  );
}
