import { llm, type ModelSettings, voice } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, TransformStream } from 'node:stream/web';
import { resolveLLMEngine, resolveStructuredMethod } from './graph/config.ts';
import { cartographGraph } from './graph/index.ts';
import { isPostToolStep, lastUserText, toLangChainMessages } from './graph/messages.ts';
import { makeModel } from './graph/model.ts';
import type { CanvasToolsDeps } from './tools/canvas-tools.ts';

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
  private deps: CanvasToolsDeps;
  private persona: string;
  private onSpokenWord: (w: SpokenWord) => void;
  private onGeneratedChunk: (text: string) => void;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Agent's own default UserData = any
    opts: voice.AgentOptions<any>,
    deps: CanvasToolsDeps,
    persona: string,
    onSpokenWord: (w: SpokenWord) => void,
    onGeneratedChunk: (text: string) => void,
  ) {
    super(opts);
    // NOT parameter properties — erasableSyntaxOnly forbids them.
    this.deps = deps;
    this.persona = persona;
    this.onSpokenWord = onSpokenWord;
    this.onGeneratedChunk = onGeneratedChunk;
  }

  /**
   * LLM_ENGINE=graph override (LANGGRAPH_PLAN.md §3.2). The graph only ever
   * emits tool calls in ChatChunk.delta.toolCalls for LiveKit's own tool
   * pipeline to execute — never calls a canvas tool itself — so
   * opts.abortSignal, gm.isCurrent() and CommitGate all keep working
   * untouched (§1).
   */
  override async llmNode(
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<llm.ChatChunk | string> | null> {
    if (resolveLLMEngine() !== 'graph') {
      return voice.Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings);
    }
    // LiveKit re-invokes llmNode after executing the tool calls emitted on
    // the previous step (maxToolSteps defaults to 3). Re-planning here would
    // re-emit and re-stage the same mutations up to four times per turn; let
    // the default node speak the tool results instead — this is also what
    // makes the read-only describeArchitecture tool work.
    if (isPostToolStep(chatCtx)) {
      return voice.Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings);
    }

    const signal = this.deps.gm.get(this.deps.gm.currentId)?.abort.signal;
    const history = toLangChainMessages(chatCtx, this.persona);
    const userInput = lastUserText(chatCtx);
    const canvasSummary = this.deps.canvas.summary();
    const model = await makeModel();
    const structuredMethod = resolveStructuredMethod();

    return new ReadableStream<llm.ChatChunk | string>({
      async start(controller) {
        // NO canned lead-in here — a terminated filler sentence spoken before
        // the plan's first sentence would advance DeliveryTracker and commit
        // mutations[0] before its describing sentence has been heard (§4.7).
        const result = await cartographGraph.invoke(
          { userInput, history, canvasSummary },
          { ...(signal ? { signal } : {}), configurable: { model, structuredMethod } },
        );

        if (result.route === 'chat') {
          controller.enqueue(result.reply);
          controller.close();
          return;
        }

        for (const [i, m] of (result.plan?.mutations ?? []).entries()) {
          controller.enqueue(`${m.sentence} `); // spoken -> drives CommitGate
          controller.enqueue({
            id: `plan-${i}`,
            delta: {
              role: 'assistant',
              toolCalls: [
                llm.FunctionCall.create({
                  callId: `call-${i}`,
                  name: m.tool,
                  args: JSON.stringify({ ...m.args, anchorPhrase: m.anchorPhrase }),
                }),
              ],
            },
          } satisfies llm.ChatChunk); // executed by LiveKit -> fenced
        }
        controller.close();
      },
    });
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
