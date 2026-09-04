'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { LedgerEvent } from '@repo/protocol';
import { DUR, EASE_OUT } from '@/lib/motion';
import { cn } from '@/lib/shadcn/utils';

interface SpokenLineProps {
  spokenText: string;
  pendingText: string;
  events: LedgerEvent[];
  className?: string;
}

function toWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * The thesis as typography: delivered words solid, generated-but-not-yet-heard
 * words ghosted. Interrupt mid-sentence and the ghosted tail visibly comes
 * apart instead of just vanishing — the moment the whole product is built to
 * prove ("the canvas only knows what you actually heard").
 */
export function SpokenLine({ spokenText, pendingText, events, className }: SpokenLineProps) {
  const [dissolving, setDissolving] = useState<string[]>([]);
  const lastSeenSeq = useRef(0);

  useEffect(() => {
    const latestSeq = events.at(-1)?.seq ?? lastSeenSeq.current;
    const freshInterrupt = events.some(
      (e) => e.type === 'speech_interrupted' && e.seq > lastSeenSeq.current
    );
    lastSeenSeq.current = latestSeq;
    if (!freshInterrupt || pendingText.length === 0) return;

    setDissolving(toWords(pendingText));
    const timer = setTimeout(() => setDissolving([]), 500);
    return () => clearTimeout(timer);
    // Only re-run when new events arrive, not on every pendingText tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const spoken = toWords(spokenText);
  const pending = dissolving.length > 0 ? dissolving : toWords(pendingText);

  if (spoken.length === 0 && pending.length === 0) return null;

  return (
    <div
      className={cn(
        'flex flex-wrap justify-center gap-x-2 gap-y-1 text-center text-2xl tracking-wide text-balance md:text-3xl',
        className
      )}
    >
      <AnimatePresence mode="popLayout">
        {spoken.map((w, i) => (
          <motion.span
            key={`spoken-${i}-${w}`}
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={EASE_OUT}
            className="text-foreground"
          >
            {w}
          </motion.span>
        ))}
        {pending.map((w, i) => (
          <motion.span
            key={`pending-${i}-${w}`}
            layout
            initial={{ opacity: 0.25, y: 0, filter: 'blur(0px)' }}
            animate={
              dissolving.length > 0
                ? { opacity: 0, y: -8, filter: 'blur(6px)', color: 'var(--state-stale)' }
                : { opacity: 0.25, y: 0, filter: 'blur(0px)' }
            }
            exit={{ opacity: 0 }}
            transition={{ duration: DUR.slow }}
            className="text-state-staged"
          >
            {w}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
