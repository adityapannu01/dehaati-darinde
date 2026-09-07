import type { Room } from '@livekit/rtc-node';
import { logger } from '@repo/logger';
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
    try {
      await this.room.localParticipant?.publishData(this.encoder.encode(JSON.stringify(msg)), {
        topic: CARTOGRAPH_TOPIC,
        reliable: true,
      });
      logger.info(`[publisher] sent ${msg.kind} (lp=${this.room.localParticipant ? 'yes' : 'no'})`);
    } catch (err) {
      logger.error(`[publisher] send ${msg.kind} failed: ${String(err)}`);
    }
  }
}
