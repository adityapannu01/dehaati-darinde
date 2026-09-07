'use client';

import { useEffect, useRef, useState } from 'react';
import rough from 'roughjs';

/**
 * §3.4 "good stretch": the hand-drawn look without a renderer rewrite —
 * rough.js draws the node border as a sketchy rectangle over the existing
 * component. Opt-in and fully reversible: add `?sketch=1` to the URL (or set
 * `localStorage.cartograph_sketch = '1'`). Off by default.
 */
export function useSketchMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const param = url.searchParams.get('sketch');
      if (param === '1' || param === 'true') {
        setOn(true);
        return;
      }
      if (param === '0' || param === 'false') {
        setOn(false);
        return;
      }
      setOn(localStorage.getItem('cartograph_sketch') === '1');
    } catch {
      setOn(false);
    }
  }, []);
  return on;
}

interface SketchRectProps {
  width: number;
  height: number;
  color: string;
  /** Re-roll the sketch when this changes (e.g. the label), so it doesn't look static. */
  seed?: string;
}

/** A rough.js rounded rectangle sized to fill its positioned parent. */
export function SketchRect({ width, height, color, seed }: SketchRectProps) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!svg || width <= 0 || height <= 0) return;
    svg.replaceChildren();
    const rc = rough.svg(svg);
    const pad = 3;
    const node = rc.rectangle(pad, pad, width - pad * 2, height - pad * 2, {
      stroke: color,
      strokeWidth: 1.6,
      roughness: 1.4,
      bowing: 1.2,
      seed: hash(seed ?? `${width}x${height}`),
    });
    svg.appendChild(node);
  }, [width, height, color, seed]);

  return (
    <svg
      ref={ref}
      width={width}
      height={height}
      style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}
      aria-hidden
    />
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 100000;
}
