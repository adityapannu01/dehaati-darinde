import type { Room } from '@livekit/rtc-node';
import { CARTOGRAPH_TOPIC, type ServerMessage } from '@repo/protocol';

/**
 * Pushes CanvasSnapshot / LedgerEvent / status messages to every participant
 * in the room over LiveKit's reliable data channel. No second transport, no
 * Go backend — the room the browser is already connected to carries this.
 */
export class CanvasPublisher {
  private room: Room;
  private encoder = new TextEncoder();

  constructor(room: Room) {
    this.room = room;
  }

  async send(msg: ServerMessage): Promise<void> {
    await this.room.localParticipant?.publishData(this.encoder.encode(JSON.stringify(msg)), {
      topic: CARTOGRAPH_TOPIC,
      reliable: true,
    });
  }
}
