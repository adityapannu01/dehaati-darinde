import type { Transition } from 'motion/react';

// One spring, one ease, three durations — import from here, use nothing else,
// so every Cartograph animation moves with the same hand.
export const SPRING: Transition = { type: 'spring', stiffness: 420, damping: 34, mass: 0.7 };
export const EASE_OUT: Transition = { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const };
export const DUR = { fast: 0.12, base: 0.22, slow: 0.45 } as const;
