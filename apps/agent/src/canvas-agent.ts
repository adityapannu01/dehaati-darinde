import { llm, type ModelSettings, voice } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, TransformStream } from 'node:stream/web';
import { resolveLLMEngine, resolveStructuredMethod } from './graph/config.ts';
import { isPostToolStep, lastUserText, toLangChainMessages } from './graph/messages.ts';
import { makeModel } from './graph/model.ts';
import { chatStream } from './graph/nodes/chat.ts';
import { planProgressive } from './graph/nodes/plan.ts';
import { routeNode } from './graph/nodes/route.ts';
import type { CanvasStateT } from './graph/state.ts';
import { applyLexicon } from './core/lexicon.ts';
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
  private onSpokenWord: (generation: number, w: SpokenWord) => void;
  private onGeneratedChunk: (generation: number, text: string) => void;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Agent's own default UserData = any
    opts: voice.AgentOptions<any>,
    deps: CanvasToolsDeps,
    persona: string,
    onSpokenWord: (generation: number, w: SpokenWord) => void,
    onGeneratedChunk: (generation: number, text: string) => void,
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

    const gen = this.deps.gm.currentId;
    const signal = this.deps.gm.get(gen)?.abort.signal;
    const history = toLangChainMessages(chatCtx, this.persona);
    const userInput = lastUserText(chatCtx);
    const canvasSummary = this.deps.canvas.summary();
    const model = await makeModel();
    const structuredMethod = resolveStructuredMethod();
    const config = { ...(signal ? { signal } : {}), configurable: { model, structuredMethod } };
    const state: CanvasStateT = { userInput, history, canvasSummary, route: 'chat', plan: null, reply: '' };
    const ledger = this.deps.ledger;

    // Cheap, on the critical path of every turn — decided once, up front, not
    // inside the stream, so it can drive the graph_route ledger event
    // (§5.1) synchronously with the rest of llmNode's setup.
    const { route = 'chat' } = await routeNode(state, config);
    ledger.push('graph_route', gen, `route=${route}`);

    return new ReadableStream<llm.ChatChunk | string>({
      async start(controller) {
        // NO canned lead-in here — a terminated filler sentence spoken before
        // the plan's first sentence would advance DeliveryTracker and commit
        // mutations[0] before its describing sentence has been heard (§4.7).
        if (route === 'chat') {
          // §4.2: stream tokens directly instead of awaiting the full reply.
          for await (const token of chatStream(state, config)) {
            controller.enqueue(token);
          }
          controller.close();
          return;
        }

        // §4.1: progressive JSON parsing — a mutation's sentence is spoken
        // (and its tool call handed to LiveKit) the instant that mutation is
        // complete, while later ones in the plan are still generating.
        const { plan, valid } = await planProgressive(state, config, (m, i) => {
          // Tool call first, sentence second (F4): the tool then starts a few
          // milliseconds *before* the text it narrates begins synthesising,
          // rather than after — biasing the stage-vs-delivery race the right
          // way so the mutation lands with its sentence, not a beat behind.
          controller.enqueue({
            id: `plan-${i}`,
            delta: {
              role: 'assistant',
              toolCalls: [
                llm.FunctionCall.create({
                  callId: `call-${i}`,
                  name: m.tool,
                  // sentenceIndex (F2): the planner already knows the true
                  // sentence<->mutation pairing — send it so the tool doesn't
                  // fall back to a completion-order counter.
                  args: JSON.stringify({ ...m.args, anchorPhrase: m.anchorPhrase, sentenceIndex: i }),
                }),
              ],
            },
          } satisfies llm.ChatChunk); // executed by LiveKit -> fenced
          controller.enqueue(`${m.sentence} `); // spoken -> drives CommitGate
        });

        // A validation failure here means mutations may already have been
        // spoken and staged — there is nothing to un-say, so just log it and
        // let CommitGate (unaffected) handle whatever was actually staged.
        if (valid) {
          ledger.push('graph_plan', gen, `${plan.mutations.length} mutation(s)`);
        } else {
          ledger.push('graph_plan_invalid', gen, 'plan failed schema validation after streaming');
        }
        controller.close();
      },
    });
  }

  override async transcriptionNode(
    text: ReadableStream<string | voice.TimedString> | AsyncIterable<string | voice.TimedString>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<string | voice.TimedString> | null> {
    // B1 fix (a): bind every word from this stream to the generation that
    // produced the speech, captured now — NOT read live when the word arrives.
    // A backchannel (or a real interruption's tail audio) can roll gm.currentId
    // forward while this stream is still draining; crediting those words to the
    // new generation is what silently orphaned the old one's staged mutation.
    const streamGeneration = this.deps.gm.currentId;
    const tap = new TransformStream<string | voice.TimedString, string | voice.TimedString>({
      transform: (chunk, controller) => {
        if (voice.isTimedString(chunk)) {
          this.onSpokenWord(streamGeneration, {
            text: chunk.text,
            startTime: chunk.startTime,
            endTime: chunk.endTime,
          });
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
    const streamGeneration = this.deps.gm.currentId;
    // §3.2: the pronunciation lexicon is applied HERE — after the model has
    // produced correct text, before Rime sees it. onGeneratedChunk still gets
    // the ORIGINAL text (the transcript/ledger/pending-strip keep real
    // spellings); only the audio-bound branch is respelled.
    //
    // The tap sees chunks, not sentences, and a term can straddle a chunk
    // boundary ("ngi"+"nx"), so buffer to a sentence terminator before
    // applying the lexicon and releasing — this also matches how the commit
    // gate already thinks (in sentences).
    let buffer = '';
    const SENTENCE_END = /[.!?।॥。？！؟]/;
    const tap = new TransformStream<string, string>({
      transform: (chunk, controller) => {
        this.onGeneratedChunk(streamGeneration, chunk);
        buffer += chunk;
        let m: RegExpMatchArray | null;
        while ((m = buffer.match(SENTENCE_END)) && m.index !== undefined) {
          const end = m.index + 1;
          const sentence = buffer.slice(0, end);
          buffer = buffer.slice(end);
          controller.enqueue(applyLexicon(sentence));
        }
      },
      flush: (controller) => {
        if (buffer) controller.enqueue(applyLexicon(buffer));
        buffer = '';
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
