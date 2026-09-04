import { type ModelSettings, voice } from '@livekit/agents';
import { ReadableStream, TransformStream } from 'node:stream/web';

export interface SpokenWord {
  text: string;
  startTime?: number | undefined;
  endTime?: number | undefined;
}

/**
 * Taps the transcription stream to observe Rime's word-level timestamps
 * (TimedString) as they flow past, without altering what reaches the
 * transcript. This is the only way to feed CommitGate real delivery
 * evidence — see docs on DeliveryTracker / CommitGate.
 *
 * Needs `node:stream/web`'s ReadableStream/TransformStream, not the DOM
 * globals: the SDK's stream signatures don't structurally match those.
 */
export class CanvasAgent extends voice.Agent {
  private onSpokenWord: (w: SpokenWord) => void;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Agent's own default UserData = any
  constructor(opts: voice.AgentOptions<any>, onSpokenWord: (w: SpokenWord) => void) {
    super(opts);
    this.onSpokenWord = onSpokenWord; // NOT a parameter property — erasableSyntaxOnly
  }

  override async transcriptionNode(
    text: ReadableStream<string | voice.TimedString> | AsyncIterable<string | voice.TimedString>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<string | voice.TimedString> | null> {
    const tap = new TransformStream<string | voice.TimedString, string | voice.TimedString>({
      transform: (chunk, controller) => {
        if (voice.isTimedString(chunk)) {
          this.onSpokenWord({ text: chunk.text, startTime: chunk.startTime, endTime: chunk.endTime });
        }
        controller.enqueue(chunk);
      },
    });

    const source =
      text instanceof ReadableStream
        ? (text as ReadableStream<string | voice.TimedString>)
        : new ReadableStream<string | voice.TimedString>({
            async start(controller) {
              for await (const c of text as AsyncIterable<string | voice.TimedString>) controller.enqueue(c);
              controller.close();
            },
          });

    return voice.Agent.default.transcriptionNode(this, source.pipeThrough(tap), modelSettings);
  }
}
