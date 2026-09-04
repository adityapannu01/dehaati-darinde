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
  if (!addService || addService.type !== 'function') throw new Error('addService not found');
  return { gm, staging, ledger, canvas, addService };
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
});
