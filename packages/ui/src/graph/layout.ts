import type { Node } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import {
  FRAME_COLLAPSED_H,
  FRAME_COLLAPSED_W,
  FRAME_MIN_W,
  frameId,
  type Built,
  type BuiltComponent,
  type FrameState,
  type VisualMeta,
} from './build';

const elk = new ELK();
const GAP = 56;

export interface Placed {
  id: string;
  type: 'action' | 'artefact' | 'group' | 'seam';
  parentId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function walk(node: ElkNode, parentId: string, meta: Map<string, VisualMeta>, out: Placed[]): void {
  for (const c of node.children ?? []) {
    const m = meta.get(c.id)!;
    out.push({ id: c.id, type: m.type, parentId, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 });
    walk(c, c.id, meta, out);
  }
}

/** Where the user put a frame, if they have dragged or pinned it. */
function placedAt(frames: Record<string, FrameState>, id: string): { x: number; y: number } | undefined {
  const st = frames[id];
  return st && st.x !== undefined && st.y !== undefined ? { x: st.x, y: st.y } : undefined;
}

/**
 * Lay out every seam independently, then place the frames: ones the user
 * has positioned stay exactly where they are, the rest stack top to bottom in
 * creation order, pushed clear of any positioned frame they would overlap.
 */
export async function layoutAll(built: Built, frames: Record<string, FrameState>): Promise<Placed[]> {
  const sized: { c: BuiltComponent; w: number; h: number; children: Placed[] }[] = [];
  for (const c of built.components) {
    if (c.collapsed || !c.elk) {
      sized.push({ c, w: FRAME_COLLAPSED_W, h: FRAME_COLLAPSED_H, children: [] });
      continue;
    }
    const res = await elk.layout(c.elk);
    const children: Placed[] = [];
    walk(res, frameId(c.seam.id), c.meta, children);
    sized.push({ c, w: Math.max(res.width ?? 0, FRAME_MIN_W), h: res.height ?? 0, children });
  }

  const obstacles: { x: number; y: number; w: number; h: number }[] = [];
  for (const f of sized) {
    const at = placedAt(frames, f.c.seam.id);
    if (at) obstacles.push({ ...at, w: f.w, h: f.h });
  }

  const out: Placed[] = [];
  let nextY = 0;
  for (const f of sized) {
    const at = placedAt(frames, f.c.seam.id);
    let x: number;
    let y: number;
    if (at) {
      x = at.x;
      y = at.y;
    } else {
      x = 0;
      y = nextY;
      let moved = true;
      while (moved) {
        moved = false;
        for (const r of obstacles) {
          const overlapX = x < r.x + r.w + GAP && r.x < x + f.w + GAP;
          const overlapY = y < r.y + r.h + GAP && r.y < y + f.h + GAP;
          if (overlapX && overlapY) {
            y = r.y + r.h + GAP;
            moved = true;
          }
        }
      }
      nextY = y + f.h + GAP;
    }
    out.push({ id: frameId(f.c.seam.id), type: 'seam', x, y, w: f.w, h: f.h });
    out.push(...f.children);
  }
  return out;
}

/**
 * React Flow node for a placed entity. `entering` plays the arrival animation
 * on the inner card; the wrapper itself must never be animated, because its
 * inline transform is what positions the node and a CSS animation outranks it.
 */
export function toNode(p: Placed, built: Built, entering: boolean): Node {
  const base = {
    id: p.id,
    position: { x: p.x, y: p.y },
    parentId: p.parentId,
    width: p.w,
    height: p.h,
    style: { width: p.w, height: p.h },
    connectable: false,
    selectable: true,
  };
  if (p.type === 'seam') {
    const c = built.frames.get(p.id)!;
    return {
      ...base,
      type: 'seam',
      data: { seam: c.seam, collapsed: c.collapsed, pinned: c.pinned, dim: c.dim, entering },
      // Pinned frames are locked where they are.
      draggable: !c.pinned,
      dragHandle: '.lr-frame-head',
      className: c.dim ? 'lr-dim' : undefined,
    };
  }
  const m = built.meta.get(p.id)!;
  const dim = !!built.frames.get(built.frameOf.get(p.id) ?? '')?.dim;
  const data =
    m.type === 'artefact'
      ? { artefact: m.artefact, finish: m.finish, entering }
      : { action: m.action, collapsed: m.collapsed, childCount: m.childCount, doneCount: m.doneCount, entering };
  return { ...base, type: m.type, data, draggable: false, className: dim ? 'lr-dim' : undefined };
}
