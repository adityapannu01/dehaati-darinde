'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import DotGrid from '@/components/DotGrid';
import { useLocalMicAmplitude } from '@/hooks/use-local-mic-amplitude';

/**
 * The pre-call backdrop: a dot field that reacts to the cursor — Discord's
 * login effect, by name — until the browser already has mic permission, at
 * which point it hands over to live mic amplitude instead. The field
 * breathing outward when you speak, before you've even clicked anything, is
 * the one thing here nobody in the room has seen before.
 */
export function WelcomeBackdrop() {
  const prefersReducedMotion = useReducedMotion();
  const amplitude = useLocalMicAmplitude();
  const [justWoke, setJustWoke] = useState(false);
  const wasAmplitudeDriven = useRef(false);

  useEffect(() => {
    const isNowDriven = amplitude !== undefined;
    if (isNowDriven && !wasAmplitudeDriven.current) {
      setJustWoke(true);
      const timer = setTimeout(() => setJustWoke(false), 600);
      wasAmplitudeDriven.current = true;
      return () => clearTimeout(timer);
    }
    wasAmplitudeDriven.current = isNowDriven;
  }, [amplitude]);

  if (prefersReducedMotion) return null;

  return (
    <motion.div
      className="pointer-events-none absolute inset-0"
      animate={justWoke ? { opacity: [0.6, 1] } : { opacity: 1 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
    >
      <DotGrid
        dotSize={3}
        gap={28}
        baseColor="var(--state-staged)"
        activeColor="var(--state-committed)"
        proximity={140}
        shockRadius={200}
        shockStrength={3}
        amplitude={amplitude}
        className="opacity-60"
      />
    </motion.div>
  );
}
