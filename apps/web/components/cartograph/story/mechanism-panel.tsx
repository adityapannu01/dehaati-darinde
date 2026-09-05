'use client';

import { useEffect, useRef, useState } from 'react';
import type { LedgerEvent } from '@repo/protocol';
import { SpokenLine } from '@/components/cartograph/spoken-line';

// A scripted, looping replay of the exact mechanic — staged, then delivered,
// then interrupted — using a canned transcript instead of a live session.
const SPOKEN_1 = "I'm adding a Redis cache.";
const PENDING_1 = 'Now connecting it to the API gateway';
const CYCLE = [
  { atMs: 0, phase: 'idle' },
  { atMs: 600, phase: 'speaking' },
  { atMs: 3200, phase: 'interrupted' },
  { atMs: 4400, phase: 'reset' },
  { atMs: 4900, phase: 'idle' },
] as const;
const CYCLE_LENGTH_MS = 5600;

export function MechanismPanel() {
  const [phase, setPhase] = useState<(typeof CYCLE)[number]['phase']>('idle');
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const seqRef = useRef(0);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    const scheduleCycle = (baseAt: number) => {
      for (const step of CYCLE) {
        timers.push(
          setTimeout(() => {
            setPhase(step.phase);
            if (step.phase === 'interrupted') {
              seqRef.current += 1;
              setEvents((e) =>
                [
                  ...e,
                  {
                    seq: seqRef.current,
                    t: Date.now(),
                    generation: 1,
                    type: 'speech_interrupted' as const,
                    detail: undefined,
                  },
                ].slice(-5)
              );
            }
          }, baseAt + step.atMs)
        );
      }
    };

    scheduleCycle(0);
    const interval = setInterval(() => scheduleCycle(0), CYCLE_LENGTH_MS);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(interval);
    };
  }, []);

  const spokenText = phase === 'idle' || phase === 'reset' ? '' : SPOKEN_1;
  const pendingText = phase === 'speaking' ? PENDING_1 : '';

  return (
    <div className="story-panel mx-auto max-w-3xl px-6 py-24 text-center">
      <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
        The mechanism
      </p>
      <h2 className="text-foreground mt-3 text-2xl font-bold md:text-3xl">
        Staged. Delivered. Committed. Or dropped.
      </h2>
      <p className="text-muted-foreground mx-auto mt-4 max-w-xl leading-7">
        A canned replay of the exact thing that happens live: the second sentence starts appearing
        before it&apos;s spoken, ghosted — then the user cuts in, and it dissolves instead of
        landing on the diagram.
      </p>
      <div className="mt-10 flex h-24 items-center justify-center">
        <SpokenLine spokenText={spokenText} pendingText={pendingText} events={events} />
      </div>
    </div>
  );
}
