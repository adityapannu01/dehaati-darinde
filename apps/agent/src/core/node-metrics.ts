// The one place the agent-side node box size lives (ROUND3 A5).
//
// `layout.ts` feeds these to ELK as each node's width/height; `canvas.ts`
// derives every group's boundary rectangle from the same footprint. If the two
// ever disagreed, a group box would clip its own members on one edge, or ELK
// would space a dense diagram too tightly. One constant, imported by both.
//
// It is an approximation of what the browser actually measures
// (architecture-canvas.tsx renders a content-sized box, ~168×46 with the A5
// icon + shape padding). Exact pixel parity is not required — ELK only needs
// the relative sizing to look right — but keep it close as the renderer changes.

export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 46;
