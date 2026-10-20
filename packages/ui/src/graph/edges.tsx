// A wire in the ports view, drawn along the orthogonal route ELK computed,
// so it goes around cards instead of through them. The route is relative to
// its seam's frame; the frame moves rigidly when dragged, so the route is
// carried along by the source pin's live position, and its ends are snapped
// onto the pins React Flow measured.

import { BaseEdge, type EdgeProps } from '@xyflow/react';

export interface Point {
  x: number;
  y: number;
}

const RADIUS = 8;
/** The graph view's closed arrowhead at its stroke width: length and half-height. */
const HEAD_L = 6.4;
const HEAD_H = 5.1;

/** A polyline with rounded corners. */
function roundedPath(pts: Point[]): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const r = Math.min(RADIUS, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const inX = b.x - Math.sign(b.x - a.x) * r;
    const inY = b.y - Math.sign(b.y - a.y) * r;
    const outX = b.x + Math.sign(c.x - b.x) * r;
    const outY = b.y + Math.sign(c.y - b.y) * r;
    d += ` L ${inX} ${inY} Q ${b.x} ${b.y} ${outX} ${outY}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

export function RoutedEdge({ id, sourceX, sourceY, targetX, targetY, data, style, interactionWidth }: EdgeProps) {
  const route = (data as { route?: Point[] } | undefined)?.route;
  let pts: Point[];
  if (route && route.length >= 2) {
    const dx = sourceX - route[0]!.x;
    const dy = sourceY - route[0]!.y;
    const bends = route.slice(1, -1).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    // Keep the first and last legs horizontal onto the pins; the legs next to
    // them are vertical, so moving a bend's y only stretches them.
    if (bends.length) {
      bends[0]!.y = sourceY;
      bends[bends.length - 1]!.y = targetY;
      pts = [{ x: sourceX, y: sourceY }, ...bends, { x: targetX, y: targetY }];
    } else {
      pts = elbow(sourceX, sourceY, targetX, targetY);
    }
  } else {
    pts = elbow(sourceX, sourceY, targetX, targetY);
  }
  // Every wire arrives at an input pin heading right, so the head points right.
  const head = `M ${targetX} ${targetY} L ${targetX - HEAD_L} ${targetY - HEAD_H} L ${targetX - HEAD_L} ${targetY + HEAD_H} Z`;
  return (
    <>
      <BaseEdge id={id} path={roundedPath(pts)} style={style} interactionWidth={interactionWidth} />
      <path className="lr-edge-head" d={head} />
    </>
  );
}

/** No route: a straight wire, or one step at the midpoint when the pins are not level. */
function elbow(sx: number, sy: number, tx: number, ty: number): Point[] {
  if (Math.abs(sy - ty) < 1) return [{ x: sx, y: sy }, { x: tx, y: ty }];
  const mx = (sx + tx) / 2;
  return [{ x: sx, y: sy }, { x: mx, y: sy }, { x: mx, y: ty }, { x: tx, y: ty }];
}

export const edgeTypes = { routed: RoutedEdge };
