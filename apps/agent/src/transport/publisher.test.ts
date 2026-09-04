import type { Room } from '@livekit/rtc-node';
import { CARTOGRAPH_TOPIC, type ServerMessage } from '@repo/protocol';
import { describe, expect, it, vi } from 'vitest';
import { CanvasPublisher } from './publisher.ts';

function fakeRoom() {
  const publishData = vi.fn().mockResolvedValue(undefined);
  const room = { localParticipant: { publishData } } as unknown as Room;
  return { room, publishData };
}

describe('CanvasPublisher', () => {
  it('encodes the message as JSON and publishes it reliably on the cartograph topic', async () => {
    const { room, publishData } = fakeRoom();
    const publisher = new CanvasPublisher(room);

    const msg: ServerMessage = {
      kind: 'snapshot',
      snapshot: { version: 1, generation: 1, nodes: [], edges: [] },
    };
    await publisher.send(msg);

    expect(publishData).toHaveBeenCalledTimes(1);
    const [bytes, options] = publishData.mock.calls[0] as [Uint8Array, Record<string, unknown>];
    expect(options).toEqual({ topic: CARTOGRAPH_TOPIC, reliable: true });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(msg);
  });

  it('does not throw when localParticipant is not yet available', async () => {
    const room = {} as Room;
    const publisher = new CanvasPublisher(room);
    await expect(
      publisher.send({ kind: 'events', events: [] }),
    ).resolves.toBeUndefined();
  });
});
