// Multi-participant audio path for ambient meeting mode (TECHNICAL_REVIEW.md §2.2).
//
// LiveKit Agents 1.7.1 is single-participant by design: `AgentSession` binds to
// one participant (the first to join) and `UserInputTranscribedEvent.speakerId`
// is always null. To hear a SECOND engineer in the room we run our own STT
// stream per extra participant, off the raw subscribed track, and hand every
// final transcript to a classifier.
//
//   AgentSession  -> the addressed participant: STT + LLM + TTS + commit path
//   AmbientListener -> every other participant: STT only -> classifier -> ghosts
//
// ⚠️ This wiring has NOT been validated with two live browser tabs (the brief's
//   blocking gate). The room/track plumbing here is best-effort; the decision
//   logic (`shouldListen`) and everything downstream (addressivity.ts,
//   proposals.ts) is unit-tested and audio-independent.

import type { Room, RemoteParticipant, RemoteTrack, RemoteTrackPublication } from '@livekit/rtc-node';
import { AudioStream, RoomEvent, TrackKind } from '@livekit/rtc-node';
import type { stt as sttNs } from '@livekit/agents';

export interface AmbientUtterance {
  speaker: string;
  text: string;
  atMs: number;
}

/**
 * Whether we should run an ambient STT stream for this participant's track.
 * Pure — the audio-independent half of §2.2, unit-tested.
 */
export function shouldListen(opts: {
  trackKind: TrackKind;
  participantIdentity: string;
  agentIdentity: string;
  /** The identity AgentSession is already bound to (it handles that STT itself). */
  primaryIdentity: string | undefined;
  /** Identities already being listened to. */
  active: ReadonlySet<string>;
}): boolean {
  if (opts.trackKind !== TrackKind.KIND_AUDIO) return false;
  if (opts.participantIdentity === opts.agentIdentity) return false;
  if (opts.participantIdentity === opts.primaryIdentity) return false;
  if (opts.participantIdentity.startsWith('agent-')) return false;
  if (opts.active.has(opts.participantIdentity)) return false;
  return true;
}

export interface AmbientListenerOptions {
  room: Room;
  agentIdentity: string;
  /** AgentSession's bound participant — resolved lazily since it may join after us. */
  primaryIdentity: () => string | undefined;
  /** One fresh STT stream per participant. */
  makeSttStream: () => sttNs.SpeechStream;
  onUtterance: (u: AmbientUtterance) => void;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

const FINAL_TRANSCRIPT = 2; // stt.SpeechEventType.FINAL_TRANSCRIPT

export class AmbientListener {
  private opts: AmbientListenerOptions;
  private active = new Map<string, AbortController>();
  private started = false;

  constructor(opts: AmbientListenerOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { room } = this.opts;
    room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
    // Catch tracks already subscribed before we attached.
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.track) this.onTrackSubscribed(pub.track, pub, p);
      }
    }
  }

  stop(): void {
    for (const ctl of this.active.values()) ctl.abort();
    this.active.clear();
    this.opts.room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    this.opts.room.off(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
  }

  private onTrackSubscribed = (
    track: RemoteTrack,
    _pub: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    if (
      !shouldListen({
        trackKind: track.kind ?? TrackKind.KIND_UNKNOWN,
        participantIdentity: participant.identity,
        agentIdentity: this.opts.agentIdentity,
        primaryIdentity: this.opts.primaryIdentity(),
        active: new Set(this.active.keys()),
      })
    ) {
      return;
    }
    const ctl = new AbortController();
    this.active.set(participant.identity, ctl);
    this.opts.logger?.info(`[ambient] listening to ${participant.identity}`);
    void this.pump(track, participant.identity, ctl.signal);
  };

  private onTrackUnsubscribed = (
    _track: RemoteTrack,
    _pub: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void => {
    this.active.get(participant.identity)?.abort();
    this.active.delete(participant.identity);
  };

  private async pump(track: RemoteTrack, speaker: string, signal: AbortSignal): Promise<void> {
    const sttStream = this.opts.makeSttStream();
    const audio = new AudioStream(track);

    const feed = (async () => {
      for await (const frame of audio) {
        if (signal.aborted) break;
        sttStream.pushFrame(frame);
      }
      sttStream.endInput();
    })();

    try {
      for await (const ev of sttStream) {
        if (signal.aborted) break;
        if (ev.type === FINAL_TRANSCRIPT) {
          const text = ev.alternatives?.[0]?.text?.trim();
          if (text) this.opts.onUtterance({ speaker, text, atMs: Date.now() });
        }
      }
    } catch (err) {
      this.opts.logger?.warn(`[ambient] STT stream for ${speaker} ended: ${String(err)}`);
    } finally {
      sttStream.close();
      await feed.catch(() => undefined);
    }
  }
}
