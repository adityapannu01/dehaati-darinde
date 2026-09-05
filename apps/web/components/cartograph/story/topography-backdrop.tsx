'use client';

import Topography from '@/components/Topography';

/**
 * Contour lines behind the pitch story — thematically exact for a product
 * about mapping systems, kept quiet enough to sit under text. The one WebGL
 * surface allowed on screen at a time; the hero's DotGrid (canvas 2D, not
 * WebGL, but still a render loop) unmounts while this is in view — see
 * welcome-view.tsx.
 */
export function TopographyBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 opacity-40">
      <Topography
        lowColor="var(--background)"
        midColor="var(--state-staged)"
        highColor="var(--state-committed)"
        colorMode="elevation"
        speed={0.15}
        morphSpeed={0.1}
        bands={10}
        thickness={0.015}
        opacity={0.5}
        mouseInteraction={false}
      />
    </div>
  );
}
