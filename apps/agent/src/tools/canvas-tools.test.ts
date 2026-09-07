import { describe, expect, it } from 'vitest';
import { CanvasStore } from '../core/canvas.ts';
import { CommitGate } from '../core/commit-gate.ts';
import { GenerationManager } from '../core/generation.ts';
import { EventLedger } from '../core/ledger.ts';
import { StagingBuffer } from '../core/staging.ts';
import { createCanvasTools } from './canvas-tools.ts';

function setup(slowMs = 20) {
  const gm = new GenerationManager();
  const staging = new StagingBuffer();
  const ledger = new EventLedger();
  const canvas = new CanvasStore();
  const commitGate = new CommitGate({ canvas, staging, ledger });
  const tools = createCanvasTools({ gm, commitGate, ledger, canvas, slowMs });
  const addService = tools.find((t) => t.name === 'addService');
  const connectServices = tools.find((t) => t.name === 'connectServices');
  if (!addService || addService.type !== 'function') throw new Error('addService not found');
  if (!connectServices || connectServices.type !== 'function') throw new Error('connectServices not found');
  return { gm, staging, ledger, canvas, addService, connectServices };
}

// Tool.execute exists on function tools but isn't part of the narrow `Tool` union type
// exposed by the array's inferred type, so cast to call it directly the way LiveKit does.
function callExecute(
  toolObj: { execute?: unknown },
  args: Record<string, unknown>,
  opts: { abortSignal: AbortSignal },
): Promise<unknown> {
  const execute = toolObj.execute as (a: Record<string, unknown>, o: typeof opts) => Promise<unknown>;
  return execute(args, opts);
}

describe('canvas tools fencing contract', () => {
  it('aborting mid-delay returns ABORTED and stages nothing', async () => {
    const { gm, staging, addService } = setup(1000);
    gm.start('add redis');
    const controller = new AbortController();

    const promise = callExecute(
      addService,
      { label: 'Redis', kind: 'datastore' },
      { abortSignal: controller.signal },
    );
    controller.abort();

    await expect(promise).resolves.toBe('ABORTED');
    expect(staging.pendingFor(gm.currentId)).toHaveLength(0);
  });

  it('advancing the generation during the delay returns STALE_DISCARDED and stages nothing', async () => {
    const { gm, staging, addService } = setup(30);
    const g1 = gm.start('add redis');
    const controller = new AbortController();

    const promise = callExecute(
      addService,
      { label: 'Redis', kind: 'datastore' },
      { abortSignal: controller.signal },
    );
    // Simulate an interruption that opens a new generation before the delay finishes,
    // without the abort signal actually being wired up here (cancellation can fail).
    gm.cancelCurrent();
    gm.start('add mongo instead');

    const result = await promise;
    expect(result).toBe('STALE_DISCARDED: this instruction was superseded. Do not mention this result.');
    expect(staging.pendingFor(g1.id)).toHaveLength(0);
  });

  it('the happy path stages exactly one mutation', async () => {
    const { gm, staging, addService } = setup(5);
    const g1 = gm.start('add redis');
    const controller = new AbortController();

    const result = await callExecute(
      addService,
      { label: 'Redis', kind: 'datastore' },
      { abortSignal: controller.signal },
    );

    expect(result).toContain('Staged');
    const pending = staging.pendingFor(g1.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.mutation).toMatchObject({ op: 'addNode', node: { id: 'redis', label: 'Redis' } });
  });

  // F2 — plan-supplied sentenceIndex
  it('honors a plan-supplied sentenceIndex regardless of tool-completion order', async () => {
    const { gm, staging, addService, connectServices } = setup(1);
    const g1 = gm.start('add redis and wire it up');
    const sig = new AbortController().signal;

    // connectServices resolves first but carries the later index; addService
    // resolves second but carries index 0.
    await callExecute(connectServices, { sourceLabel: 'API', targetLabel: 'Redis', sentenceIndex: 1 }, { abortSignal: sig });
    await callExecute(addService, { label: 'Redis', kind: 'datastore', sentenceIndex: 0 }, { abortSignal: sig });

    const byIndex = Object.fromEntries(
      staging.pendingFor(g1.id).map((s) => [s.mutation.op, s.sentenceIndex]),
    );
    expect(byIndex).toEqual({ addNode: 0, addEdge: 1 });
  });

  it('falls back to the internal counter when sentenceIndex is absent', async () => {
    const { gm, staging, addService } = setup(1);
    const g1 = gm.start('add two');
    const sig = new AbortController().signal;

    await callExecute(addService, { label: 'Redis', kind: 'datastore' }, { abortSignal: sig });
    await callExecute(addService, { label: 'Mongo', kind: 'datastore' }, { abortSignal: sig });

    expect(staging.pendingFor(g1.id).map((s) => s.sentenceIndex)).toEqual([0, 1]);
  });
});
