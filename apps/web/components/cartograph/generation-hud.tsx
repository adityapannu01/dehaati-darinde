'use client';

import { motion } from 'motion/react';
import SplitFlapText from '@/components/SplitFlapText';
import type { CartographStatus } from '@/hooks/use-cartograph';
import { DUR } from '@/lib/motion';
import { cn } from '@/lib/shadcn/utils';

interface GenerationHudProps {
  status: CartographStatus | undefined;
  className?: string;
}

/**
 * Top-right HUD: the active speech provider and baseline/fencing state must
 * be observable in the running product, not just documented in the README.
 * The border glow while speaking turns the chrome itself into an activity
 * readout instead of static furniture.
 */
export function GenerationHud({ status, className }: GenerationHudProps) {
  return (
    <motion.div
      animate={{
        boxShadow: status?.speaking
          ? '0 0 0 1.5px var(--state-committed), 0 0 16px 2px color-mix(in oklch, var(--state-committed) 45%, transparent)'
          : '0 0 0 1px var(--border)',
      }}
      transition={{ duration: DUR.base }}
      className={cn(
        'bg-card/90 text-card-foreground w-72 rounded-lg p-3 font-mono text-xs shadow-lg backdrop-blur',
        className
      )}
    >
      {status?.baselineMode && (
        <div className="bg-state-baseline mb-2 rounded px-2 py-1 text-center text-[11px] font-bold tracking-wide text-white">
          BASELINE MODE — fencing disabled
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
        <dt className="text-muted-foreground">generation</dt>
        <dd>
          <SplitFlapText
            text={String(status?.generation ?? 0)}
            charset="numeric"
            padTo={2}
            fontSize={16}
            flipDuration={280}
            stagger={40}
            gap={2}
            tileRadius={3}
            tileColor="var(--card)"
            textColor="var(--state-committed)"
            loop={false}
          />
        </dd>

        <dt className="text-muted-foreground">tts</dt>
        <dd className="truncate" title={status?.ttsProvider}>
          {status?.ttsProvider ?? '—'}
        </dd>

        <dt className="text-muted-foreground">llm</dt>
        <dd className="truncate">{status?.llmEngine ?? '—'}</dd>

        <dt className="text-muted-foreground">speaking</dt>
        <dd className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              backgroundColor: status?.speaking
                ? 'var(--state-committed)'
                : 'var(--muted-foreground)',
            }}
          />
          {status?.speaking ? 'yes' : 'no'}
        </dd>

        <dt className="text-muted-foreground">tool</dt>
        <dd className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              backgroundColor: status?.toolRunning
                ? 'var(--state-staged)'
                : 'var(--muted-foreground)',
            }}
          />
          {status?.toolRunning ? 'running' : 'idle'}
        </dd>

        {status?.addressivity?.enabled && (
          <>
            <dt className="text-muted-foreground">ambient</dt>
            <dd className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: 'var(--state-staged)' }}
              />
              τ={status.addressivity.threshold.toFixed(2)} · {status.addressivity.ghostCount} ghost
              {status.addressivity.ghostCount === 1 ? '' : 's'}
            </dd>
          </>
        )}
      </dl>
      <div className="text-muted-foreground mt-2 border-t pt-2">
        <div className="mb-1">heard</div>
        <div className="text-foreground max-h-16 overflow-y-auto break-words">
          {status?.heardText || '—'}
        </div>
      </div>
    </motion.div>
  );
}
