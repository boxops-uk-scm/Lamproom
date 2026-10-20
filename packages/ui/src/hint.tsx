// Every hover hint in the UI is an Astryx tooltip, never the browser's title
// bubble. Wrap an element, or anchor to one by ref where wrapping is awkward.

import { Tooltip } from '@astryxdesign/core/Tooltip';
import { useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

type Placement = 'above' | 'below' | 'start' | 'end';

/** How long the pointer rests before a hint opens; Astryx's own 200ms felt eager. */
const DELAY = 600;

export function Hint({
  content,
  placement = 'above',
  anchorRef,
  children,
}: {
  content: ReactNode;
  placement?: Placement;
  anchorRef?: RefObject<HTMLElement | null>;
  children?: ReactElement;
}) {
  if (!content) return children ?? null;
  return (
    <Tooltip content={content} placement={placement} delay={DELAY} hasHoverIndication={false} anchorRef={anchorRef as RefObject<HTMLElement> | undefined}>
      {children}
    </Tooltip>
  );
}

/**
 * A hint for elements inside the React Flow canvas. Astryx positions its
 * layers with CSS anchor positioning, which reads an anchor's layout box and
 * ignores the transforms React Flow places nodes with, so every canvas
 * tooltip would land at the viewport origin. This measures the element on
 * hover and anchors the tooltip to a fixed ghost outside the canvas instead.
 *
 * `exclude` names the parts of the element that carry hints of their own;
 * while the pointer is over one of them this hint stays closed.
 */
export function CanvasHint({
  content,
  placement = 'above',
  anchorRef,
  exclude,
}: {
  content: ReactNode;
  placement?: Placement;
  anchorRef: RefObject<HTMLElement | null>;
  exclude?: string;
}) {
  const ghost = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    let timer: number | undefined;
    // Waiting out the delay, or open: moving between children leaves it be.
    let armed = false;
    const hide = () => {
      window.clearTimeout(timer);
      armed = false;
      setRect(null);
    };
    const show = (e: PointerEvent) => {
      if (exclude && e.target instanceof Element && e.target.closest(exclude)) return hide();
      if (armed) return;
      armed = true;
      timer = window.setTimeout(() => setRect(el.getBoundingClientRect()), DELAY);
    };
    el.addEventListener('pointerover', show);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('pointerdown', hide);
    window.addEventListener('wheel', hide, { passive: true });
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener('pointerover', show);
      el.removeEventListener('pointerleave', hide);
      el.removeEventListener('pointerdown', hide);
      window.removeEventListener('wheel', hide);
    };
  }, [anchorRef, exclude]);
  if (!content) return null;
  return (
    <>
      {createPortal(
        <span
          ref={ghost}
          aria-hidden="true"
          style={{ position: 'fixed', left: rect?.left ?? 0, top: rect?.top ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0, pointerEvents: 'none' }}
        />,
        document.body,
      )}
      <Tooltip
        anchorRef={ghost as RefObject<HTMLElement>}
        content={content}
        placement={placement}
        isOpen={rect !== null}
        hasHoverIndication={false}
        focusTrigger="never"
        touchTrigger="none"
      />
    </>
  );
}
