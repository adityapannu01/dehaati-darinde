'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { LedgerEvent, LedgerEventType } from '@repo/protocol';
import { DUR } from '@/lib/motion';
import { cn } from '@/lib/shadcn/utils';

interface EventLedgerProps {
  events: LedgerEvent[];
  className?: string;
}

// Same five-state vocabulary as the canvas and HUD — a colour means the same
// thing everywhere it appears, which is most of what reads as "designed".
const COLOR_BY_TYPE: Partial<Record<LedgerEventType, string>> = {
  mutation_committed: 'text-state-committed',
  tool_completed: 'text-state-committed',
  tool_stale_discarded: 'text-state-stale',
  mutation_dropped: 'text-state-stale',
  tool_aborted: 'text-state-stale',
  generation_cancelled: 'text-state-cancelled',
  speech_interrupted: 'text-state-cancelled',
  graph_plan_invalid: 'text-state-stale',
};

/**
 * Bottom-right, auto-scrolling event stream. The red lines — a stale tool
 * result arriving late and getting rejected — are the money shot: a judge
 * watches the fencing actually happen in real time.
 */
export function EventLedger({ events, className }: EventLedgerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div
      className={cn(
        'bg-card/90 text-card-foreground border-border flex h-56 w-80 flex-col rounded-lg border shadow-lg backdrop-blur',
        className
      )}
    >
      <div className="border-border text-muted-foreground border-b px-3 py-1.5 font-mono text-[11px] tracking-wide uppercase">
        event ledger
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
      >
        {events.length === 0 && <div className="text-muted-foreground">Waiting for events…</div>}
        <AnimatePresence initial={false}>
          {events.map((e) => (
            <motion.div
              key={e.seq}
              layout
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: DUR.fast }}
              className={cn('truncate', COLOR_BY_TYPE[e.type] ?? 'text-foreground')}
            >
              [{e.generation}] {e.type}
              {e.detail ? ` ${e.detail}` : ''}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
