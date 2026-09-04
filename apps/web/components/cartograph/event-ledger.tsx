'use client';

import { useEffect, useRef } from 'react';
import type { LedgerEvent, LedgerEventType } from '@repo/protocol';
import { cn } from '@/lib/shadcn/utils';

interface EventLedgerProps {
  events: LedgerEvent[];
  className?: string;
}

const COLOR_BY_TYPE: Partial<Record<LedgerEventType, string>> = {
  mutation_committed: 'text-emerald-400',
  tool_completed: 'text-emerald-400',
  tool_stale_discarded: 'text-red-400',
  mutation_dropped: 'text-red-400',
  tool_aborted: 'text-red-400',
  generation_cancelled: 'text-amber-400',
  speech_interrupted: 'text-amber-400',
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
        {events.map((e) => (
          <div key={e.seq} className={cn('truncate', COLOR_BY_TYPE[e.type] ?? 'text-foreground')}>
            [{e.generation}] {e.type}
            {e.detail ? ` ${e.detail}` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
