import { type ModelSettings, voice } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, TransformStream } from 'node:stream/web';

export interface SpokenWord {
  text: string;
  startTime?: number | undefined;
  endTime?: number | undefined;
}

/**
 * Taps two points in the pipeline:
 *   - transcriptionNode: Rime's word-level timestamps (TimedString) as audio
 *     is actually delivered — the only source of real delivery evidence, fed
 *     into CommitGate (see DeliveryTracker / CommitGate).
 *   - ttsNode: the generated text on its way INTO the TTS, ahead of audio —
 *     what the heard/pending sentence strip (spoken-line.tsx) ghosts in as
 *     "not yet heard" text.
 * Neither tap alters what reaches its downstream node.
 *
 * Needs `node:stream/web`'s ReadableStream/TransformStream, not the DOM
 * globals: the SDK's stream signatures don't structurally match those.
 */
export class CanvasAgent extends voice.Agent {
  private onSpokenWord: (w: SpokenWord) => void;
  private onGeneratedChunk: (text: string) => void;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Agent's own default UserData = any
    opts: voice.AgentOptions<any>,
    onSpokenWord: (w: SpokenWord) => void,
    onGeneratedChunk: (text: string) => void,
  ) {
    super(opts);
    // NOT parameter properties — erasableSyntaxOnly forbids them.
    this.onSpokenWord = onSpokenWord;
    this.onGeneratedChunk = onGeneratedChunk;
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

  override async ttsNode(
    text: ReadableStream<string> | AsyncIterable<string>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<AudioFrame> | null> {
    const tap = new TransformStream<string, string>({
      transform: (chunk, controller) => {
        this.onGeneratedChunk(chunk);
        controller.enqueue(chunk);
      },
    });

    const source =
      text instanceof ReadableStream
        ? (text as ReadableStream<string>)
        : new ReadableStream<string>({
            async start(controller) {
              for await (const c of text as AsyncIterable<string>) controller.enqueue(c);
              controller.close();
            },
          });

    return voice.Agent.default.ttsNode(this, source.pipeThrough(tap), modelSettings);
  }
}
