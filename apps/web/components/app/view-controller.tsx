'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { useSessionContext } from '@livekit/components-react';
import type { AppConfig } from '@/app-config';
import { WelcomeView } from '@/components/app/welcome-view';
import { ArchitectureCanvas } from '@/components/cartograph/architecture-canvas';
import { EventLedger } from '@/components/cartograph/event-ledger';
import { GenerationHud } from '@/components/cartograph/generation-hud';
import { MermaidExport } from '@/components/cartograph/mermaid-export';
import { SessionChrome } from '@/components/cartograph/session-chrome';
import { SpokenLine } from '@/components/cartograph/spoken-line';
import { useCartograph } from '@/hooks/use-cartograph';

const MotionWelcomeView = motion.create(WelcomeView);

const VIEW_MOTION_PROPS = {
  variants: {
    visible: {
      opacity: 1,
    },
    hidden: {
      opacity: 0,
    },
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
  transition: {
    duration: 0.5,
    ease: 'linear' as const,
  },
};

interface ViewControllerProps {
  appConfig: AppConfig;
}

export function ViewController({ appConfig }: ViewControllerProps) {
  const { isConnected, start } = useSessionContext();
  const { nodes, edges, groups, direction, events, status, forming, ghosts, mermaid, clearMermaid } =
    useCartograph();
  const lastToastedSeq = useRef(0);

  // A stale tool result being rejected in real time is the money shot —
  // impossible to miss on a recording, styled with the same --state-stale
  // token as its ledger line and canvas dissolve.
  useEffect(() => {
    const fresh = events.filter(
      (e) => e.type === 'tool_stale_discarded' && e.seq > lastToastedSeq.current
    );
    if (fresh.length === 0) return;
    lastToastedSeq.current = events.at(-1)?.seq ?? lastToastedSeq.current;
    for (const e of fresh) {
      toast('Stale result discarded', {
        description: e.detail,
        style: {
          borderColor: 'var(--state-stale)',
          borderLeftWidth: 4,
        },
      });
    }
  }, [events]);

  return (
    <AnimatePresence mode="wait">
      {/* Welcome view */}
      {!isConnected && (
        <MotionWelcomeView
          key="welcome"
          {...VIEW_MOTION_PROPS}
          startButtonText={appConfig.startButtonText}
          onStartCall={start}
        />
      )}
      {/* Session view: the architecture canvas fills the viewport; the voice
          chrome (state pill + control bar + transcript drawer) floats over it,
          and the generation HUD + event ledger sit in the corners. */}
      {isConnected && (
        <motion.div key="session-view" {...VIEW_MOTION_PROPS} className="fixed inset-0">
          <ArchitectureCanvas
            nodes={nodes}
            edges={edges}
            groups={groups}
            direction={direction}
            forming={forming}
            ghosts={ghosts}
            className="absolute inset-0"
          />
          {status?.baselineMode && (
            <div
              aria-hidden
              className="pointer-events-none fixed inset-0 z-40"
              style={{ boxShadow: 'inset 0 0 0 2px var(--state-baseline)' }}
            />
          )}
          <SpokenLine
            spokenText={status?.spokenText ?? ''}
            pendingText={status?.pendingText ?? ''}
            events={events}
            className="fixed top-6 left-1/2 z-20 w-full max-w-2xl -translate-x-1/2 px-4"
          />
          {/* top-16, not top-4: clears the fixed page header, which paints
              "Built with LiveKit Agents" in the same top-right corner (B8). */}
          <GenerationHud status={status} className="fixed top-16 right-4 z-20" />
          <EventLedger events={events} className="fixed right-4 bottom-28 z-20" />
          <MermaidExport
            mermaid={mermaid}
            onClose={clearMermaid}
            className="fixed bottom-28 left-4 z-30"
          />
          <SessionChrome
            supportsChatInput={appConfig.supportsChatInput}
            supportsVideoInput={appConfig.supportsVideoInput}
            supportsScreenShare={appConfig.supportsScreenShare}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
