// Generational Conversation Control: every user turn gets a monotonically
// increasing generation id. Async work spawned by a turn (LLM calls, tools,
// TTS, canvas mutations) carries that id and must re-check `isCurrent` before
// it is allowed to touch user-visible state — see StagingBuffer / CommitGate.
//
// Pure TypeScript, no LiveKit imports, so the benchmark harness can drive it
// with a virtual clock and no audio or network.

export type GenStatus = 'active' | 'cancelled' | 'completed';

export interface Generation {
  id: number;
  status: GenStatus;
  userInput: string;
  generatedText: string;
  heardText: string;
  startedAt: number;
  cancelledAt?: number | undefined;
  abort: AbortController;
}

export interface GenerationManagerOptions {
  /** true disables fencing entirely: isCurrent() always returns true. This is the naive-agent comparison mode. */
  baselineMode?: boolean;
}

export class GenerationManager {
  private generations: Generation[] = [];
  private nextId = 1;
  private current: Generation | undefined;
  private baselineMode: boolean;

  constructor(opts?: GenerationManagerOptions) {
    this.baselineMode = opts?.baselineMode ?? false;
  }

  start(userInput: string): Generation {
    const gen: Generation = {
      id: this.nextId,
      status: 'active',
      userInput,
      generatedText: '',
      heardText: '',
      startedAt: Date.now(),
      abort: new AbortController(),
    };
    this.nextId += 1;
    this.generations.push(gen);
    this.current = gen;
    return gen;
  }

  get currentId(): number {
    return this.current?.id ?? 0;
  }

  /**
   * In baselineMode, every generation is treated as current — nothing is ever
   * fenced. Otherwise, a generation is current only while it is the newest
   * *and* still active: cancelling it fences it immediately, before any
   * later generation has opened.
   */
  isCurrent(id: number): boolean {
    if (this.baselineMode) return true;
    return id === this.currentId && this.current?.status === 'active';
  }

  get(id: number): Generation | undefined {
    return this.generations.find((g) => g.id === id);
  }

  cancelCurrent(): void {
    const gen = this.current;
    if (!gen || gen.status !== 'active') return;
    gen.status = 'cancelled';
    gen.cancelledAt = Date.now();
    gen.abort.abort();
    // Nothing further to "increment": nextId already points one past the
    // newest issued id, so the next start() naturally opens the next generation.
  }

  complete(id: number): void {
    const gen = this.get(id);
    if (gen && gen.status === 'active') gen.status = 'completed';
  }

  /**
   * Un-cancel a generation that was fenced on a suspected interruption which
   * LiveKit then classified as false (`AgentFalseInterruption`). Makes it
   * `current` and `active` again with a fresh AbortController (the old signal
   * already fired). No-op — returns false — if the generation is unknown or a
   * newer one has since started and genuinely superseded it.
   */
  restore(id: number): boolean {
    const gen = this.get(id);
    if (!gen) return false;
    // Only the most recent generation can be restored; if start() has been
    // called again since, that newer turn is real and this one stays dead.
    if (this.current && this.current.id > id && this.current.status === 'active') return false;
    gen.status = 'active';
    gen.cancelledAt = undefined;
    gen.abort = new AbortController();
    this.current = gen;
    return true;
  }

  history(): readonly Generation[] {
    return this.generations;
  }
}
