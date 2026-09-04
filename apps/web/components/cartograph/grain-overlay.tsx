// Static film-grain texture over the whole app. Flat dark UIs read as
// cheap; a couple of percent of noise is the highest looks-expensive-per-
// minute ratio available here. Self-authored inline SVG (feTurbulence),
// not animated, so it carries no reduced-motion or perf cost.
const GRAIN_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

export function GrainOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 opacity-[0.03] mix-blend-overlay"
      style={{ backgroundImage: `url("${GRAIN_SVG}")` }}
    />
  );
}
