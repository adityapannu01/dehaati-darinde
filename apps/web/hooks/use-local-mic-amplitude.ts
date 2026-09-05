'use client';

import { useEffect, useState } from 'react';
import { type LocalAudioTrack, createLocalAudioTrack } from 'livekit-client';
import { useTrackVolume } from '@livekit/components-react';

/**
 * Live local-mic amplitude (0-1), but only ever if the browser's Permissions
 * API already reports microphone access as granted — this hook never itself
 * triggers a permission prompt. An unprompted mic-permission dialog on page
 * load, before any user action, is not something to spring on a visitor.
 *
 * Returns `undefined` (meaning: stay cursor-driven) until/unless that's true.
 */
export function useLocalMicAmplitude(): number | undefined {
  const [track, setTrack] = useState<LocalAudioTrack | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let createdTrack: LocalAudioTrack | undefined;

    async function attachIfAlreadyGranted() {
      if (!navigator.permissions?.query) return;
      try {
        const status = await navigator.permissions.query({
          name: 'microphone' as PermissionName,
        });
        if (status.state !== 'granted' || cancelled) return;
        createdTrack = await createLocalAudioTrack();
        if (cancelled) {
          createdTrack.stop();
          return;
        }
        setTrack(createdTrack);
      } catch {
        // Permissions API unsupported in this browser, or capture failed — stay cursor-driven.
      }
    }

    void attachIfAlreadyGranted();
    return () => {
      cancelled = true;
      createdTrack?.stop();
    };
  }, []);

  const volume = useTrackVolume(track);
  return track ? volume : undefined;
}
