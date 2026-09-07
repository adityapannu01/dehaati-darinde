'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  BarVisualizer,
  useAgent,
  useSessionContext,
  useSessionMessages,
  useVoiceAssistant,
} from '@livekit/components-react';
import { AgentChatTranscript } from '@/components/agents-ui/agent-chat-transcript';
import {
  AgentControlBar,
  type AgentControlBarControls,
} from '@/components/agents-ui/agent-control-bar';
import { cn } from '@/lib/shadcn/utils';

interface SessionChromeProps {
  supportsChatInput?: boolean;
  supportsVideoInput?: boolean;
  supportsScreenShare?: boolean;
}

const STATE_LABEL: Record<string, string> = {
  initializing: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

/**
 * Cartograph's session UI. The architecture canvas owns the whole viewport;
 * everything here is chrome that floats over it: a compact voice-state pill and
 * control bar docked bottom-centre, and the transcript as a right-hand drawer.
 * Deliberately not AgentSessionView_01 — that block centres an opaque audio
 * tile over the canvas, which is exactly what we don't want here.
 */
export function SessionChrome({
  supportsChatInput = true,
  supportsVideoInput = true,
  supportsScreenShare = true,
}: SessionChromeProps) {
  const session = useSessionContext();
  const { messages } = useSessionMessages(session);
  const { state: agentState } = useAgent();
  const { audioTrack } = useVoiceAssistant();
  const [isChatOpen, setIsChatOpen] = useState(false);

  const controls: AgentControlBarControls = {
    leave: true,
    microphone: true,
    chat: supportsChatInput,
    camera: supportsVideoInput,
    screenShare: supportsScreenShare,
  };

  const label = STATE_LABEL[agentState] ?? '';

  return (
    <div className="pointer-events-none fixed inset-0 z-30">
      {/* Transcript drawer */}
      <AnimatePresence>
        {isChatOpen && (
          <motion.aside
            key="transcript"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            className={cn(
              'pointer-events-auto absolute top-0 right-0 bottom-0 z-40 w-full max-w-sm',
              'border-border/60 bg-background/85 border-l shadow-xl backdrop-blur-md'
            )}
          >
            <div className="flex h-12 items-center justify-between px-4">
              <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Transcript
              </span>
              <button
                onClick={() => setIsChatOpen(false)}
                className="text-muted-foreground hover:text-foreground text-sm"
                aria-label="Close transcript"
              >
                Close
              </button>
            </div>
            <AgentChatTranscript
              agentState={agentState}
              messages={messages}
              className="absolute inset-x-0 top-12 bottom-0 px-3 pb-3"
            />
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Bottom dock: voice-state pill + control bar */}
      <div className="absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-3 px-3 pb-4 md:pb-6">
        <AnimatePresence>
          {label && (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.18 }}
              className={cn(
                'pointer-events-auto flex items-center gap-2 rounded-full px-3 py-1.5',
                'border-border/60 bg-background/80 border text-xs font-medium shadow-sm backdrop-blur-md'
              )}
            >
              <BarVisualizer
                state={agentState}
                trackRef={audioTrack}
                barCount={5}
                options={{ minHeight: 4 }}
                className="flex h-4 w-10 items-center justify-center gap-0.5 [&>span]:w-1 [&>span]:rounded-full [&>span]:bg-current"
              />
              <span className="text-foreground/80">{label}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <AgentControlBar
          variant="livekit"
          controls={controls}
          isChatOpen={isChatOpen}
          isConnected={session.isConnected}
          onDisconnect={session.end}
          onIsChatOpenChange={setIsChatOpen}
          className="pointer-events-auto max-w-2xl"
        />
      </div>
    </div>
  );
}
