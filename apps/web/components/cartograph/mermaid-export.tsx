'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/shadcn/utils';

interface MermaidExportProps {
  mermaid: string | null;
  onClose: () => void;
  className?: string;
}

/**
 * §3.4: Mermaid is a fine *export* target — the user can paste it into a doc or
 * a wiki. It is NOT a renderer (it re-draws the whole graph on every change,
 * incompatible with per-sentence incremental commits). This panel just shows
 * the text with a copy button.
 */
export function MermaidExport({ mermaid, onClose, className }: MermaidExportProps) {
  const [copied, setCopied] = useState(false);

  return (
    <AnimatePresence>
      {mermaid && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className={cn(
            'bg-card/95 text-card-foreground w-96 rounded-lg border p-3 font-mono text-xs shadow-lg backdrop-blur',
            className
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-muted-foreground tracking-wide uppercase">Mermaid export</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="hover:text-foreground text-muted-foreground underline underline-offset-2"
                onClick={() => {
                  navigator.clipboard?.writeText(mermaid).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    },
                    () => undefined
                  );
                }}
              >
                {copied ? 'copied' : 'copy'}
              </button>
              <button
                type="button"
                className="hover:text-foreground text-muted-foreground"
                onClick={onClose}
              >
                ✕
              </button>
            </div>
          </div>
          <pre className="text-foreground max-h-56 overflow-auto whitespace-pre rounded bg-black/5 p-2 dark:bg-white/5">
            {mermaid}
          </pre>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
