import { TrackKind } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { shouldListen } from './ambient-listener.ts';

const base = {
  trackKind: TrackKind.KIND_AUDIO,
  participantIdentity: 'engineer-b',
  agentIdentity: 'DD_agent',
  primaryIdentity: 'engineer-a',
  active: new Set<string>(),
};

describe('shouldListen (§2.2 decision logic)', () => {
  it('listens to a second human participant', () => {
    expect(shouldListen(base)).toBe(true);
  });

  it('never listens to a video track', () => {
    expect(shouldListen({ ...base, trackKind: TrackKind.KIND_VIDEO })).toBe(false);
  });

  it('never listens to the agent itself or another agent worker', () => {
    expect(shouldListen({ ...base, participantIdentity: 'DD_agent' })).toBe(false);
    expect(shouldListen({ ...base, participantIdentity: 'agent-AJ_xyz' })).toBe(false);
  });

  it('never double-subscribes AgentSession\'s primary participant', () => {
    expect(shouldListen({ ...base, participantIdentity: 'engineer-a' })).toBe(false);
  });

  it('never double-subscribes someone already active', () => {
    expect(shouldListen({ ...base, active: new Set(['engineer-b']) })).toBe(false);
  });

  it('listens even before a primary is bound (primary undefined)', () => {
    expect(shouldListen({ ...base, primaryIdentity: undefined })).toBe(true);
  });
});
