'use client';

import SplitFlapText from '@/components/SplitFlapText';
import type { CartographStatus } from '@/hooks/use-cartograph';
import { cn } from '@/lib/shadcn/utils';

interface GenerationHudProps {
  status: CartographStatus | undefined;
  className?: string;
}

/**
 * Top-right HUD: the active speech provider and baseline/fencing state must
 * be observable in the running product, not just documented in the README.
 */
export function GenerationHud({ status, className }: GenerationHudProps) {
  return (
    <div
      className={cn(
        'bg-card/90 text-card-foreground border-border w-72 rounded-lg border p-3 font-mono text-xs shadow-lg backdrop-blur',
        className
      )}
    >
      {status?.baselineMode && (
        <div className="mb-2 rounded bg-red-600 px-2 py-1 text-center text-[11px] font-bold tracking-wide text-white">
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

        <dt className="text-muted-foreground">speaking</dt>
        <dd>
          <span
            className={cn(
              'mr-1 inline-block h-2 w-2 rounded-full',
              status?.speaking ? 'bg-emerald-500' : 'bg-neutral-500'
            )}
          />
          {status?.speaking ? 'yes' : 'no'}
        </dd>

        <dt className="text-muted-foreground">tool</dt>
        <dd>
          <span
            className={cn(
              'mr-1 inline-block h-2 w-2 rounded-full',
              status?.toolRunning ? 'bg-amber-500' : 'bg-neutral-500'
            )}
          />
          {status?.toolRunning ? 'running' : 'idle'}
        </dd>
      </dl>
      <div className="text-muted-foreground mt-2 border-t pt-2">
        <div className="mb-1">heard</div>
        <div className="text-foreground max-h-16 overflow-y-auto break-words">
          {status?.heardText || '—'}
        </div>
      </div>
    </div>
  );
}
