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
  const pick = (name: string) => {
    const t = tools.find((tool) => tool.name === name);
    if (!t || t.type !== 'function') throw new Error(`${name} not found`);
    return t;
  };
  const published: unknown[] = [];
  const toolsWithPublish = createCanvasTools({
    gm,
    commitGate,
    ledger,
    canvas,
    slowMs,
    publish: (m) => published.push(m),
  });
  const pickP = (name: string) => {
    const t = toolsWithPublish.find((tool) => tool.name === name);
    if (!t || t.type !== 'function') throw new Error(`${name} not found`);
    return t;
  };
  return {
    gm,
    staging,
    ledger,
    canvas,
    published,
    addService: pick('addService'),
    connectServices: pick('connectServices'),
    clearCanvas: pick('clearCanvas'),
    describeArchitecture: pick('describeArchitecture'),
    undoLast: pick('undoLast'),
    groupComponents: pick('groupComponents'),
    arrangeLayout: pick('arrangeLayout'),
    exportDiagram: pickP('exportDiagram'),
  };
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

  it('carries edge semantics (flow / bidirectional) onto the staged addEdge (§3.2)', async () => {
    const { gm, staging, connectServices } = setup(1);
    const g1 = gm.start('wire the queue');
    const sig = new AbortController().signal;

    await callExecute(
      connectServices,
      { sourceLabel: 'Orders', targetLabel: 'Kafka', flow: 'async', bidirectional: true },
      { abortSignal: sig },
    );

    const edge = staging.pendingFor(g1.id)[0]?.mutation;
    expect(edge).toMatchObject({ op: 'addEdge', edge: { flow: 'async', bidirectional: true } });
  });

  it('omits flow/bidirectional when not supplied — a plain sync edge', async () => {
    const { gm, staging, connectServices } = setup(1);
    const g1 = gm.start('connect them');
    await callExecute(
      connectServices,
      { sourceLabel: 'A', targetLabel: 'B' },
      { abortSignal: new AbortController().signal },
    );
    const edge = staging.pendingFor(g1.id)[0]?.mutation as { edge: Record<string, unknown> };
    expect(edge.edge).not.toHaveProperty('flow');
    expect(edge.edge).not.toHaveProperty('bidirectional');
  });

  it('resolves a paraphrased sourceLabel/targetLabel against the canvas instead of dangling — the observed live bug', async () => {
    const { gm, canvas, staging, connectServices } = setup(1);
    const sig = new AbortController().signal;
    const g1 = gm.start('add and connect');

    // The nodes are already committed on the canvas by the time the user asks
    // to connect them — addService's own staging delay is irrelevant here.
    canvas.apply({ op: 'addNode', node: { id: 'api-gateway', label: 'API Gateway', kind: 'gateway', x: 0, y: 0 } });
    canvas.apply({
      op: 'addNode',
      node: { id: 'auth-service', label: 'auth service', kind: 'service', x: 0, y: 0 },
    });

    // Live transcript: "connect the gateway to the auth service" — the LLM
    // paraphrases the node it just named "API Gateway" down to "gateway".
    await callExecute(
      connectServices,
      { sourceLabel: 'gateway', targetLabel: 'auth service' },
      { abortSignal: sig },
    );

    const edge = staging.pendingFor(g1.id)[0]?.mutation as { edge: { source: string; target: string } };
    expect(edge.edge.source).toBe('api-gateway');
    expect(edge.edge.target).toBe('auth-service');
  });

  it('resolves "the database" to the sole datastore even with zero textual overlap with its real label', async () => {
    const { gm, canvas, staging, connectServices } = setup(1);
    const sig = new AbortController().signal;
    const g1 = gm.start('add and connect');

    canvas.apply({ op: 'addNode', node: { id: 'api-gateway', label: 'API Gateway', kind: 'gateway', x: 0, y: 0 } });
    canvas.apply({ op: 'addNode', node: { id: 'postgres', label: 'Postgres', kind: 'datastore', x: 0, y: 0 } });

    await callExecute(
      connectServices,
      { sourceLabel: 'API Gateway', targetLabel: 'database' },
      { abortSignal: sig },
    );

    const edge = staging.pendingFor(g1.id)[0]?.mutation as { edge: { target: string } };
    expect(edge.edge.target).toBe('postgres');
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

describe('clearCanvas (B6)', () => {
  it('stages exactly one atomic clear op, not one removal per node', async () => {
    const { gm, staging, canvas, clearCanvas } = setup(1);
    canvas.apply({ op: 'addNode', node: { id: 'a', label: 'A', kind: 'service', x: 0, y: 0 } });
    canvas.apply({ op: 'addNode', node: { id: 'b', label: 'B', kind: 'service', x: 0, y: 0 } });
    const g1 = gm.start('clear the board');

    const result = await callExecute(clearCanvas, {}, { abortSignal: new AbortController().signal });

    expect(result).toContain('Staged');
    const pending = staging.pendingFor(g1.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.mutation).toEqual({ op: 'clear' });
    expect(pending[0]?.anchorPhrase).toBe('clear');
  });

  it('stages against the commit gate — the wipe does not touch the canvas until its sentence is heard', async () => {
    const { gm, canvas, clearCanvas } = setup(1);
    canvas.apply({ op: 'addNode', node: { id: 'a', label: 'A', kind: 'service', x: 0, y: 0 } });
    gm.start('clear the board');

    await callExecute(clearCanvas, {}, { abortSignal: new AbortController().signal });

    // Staged only — the board still has its node until CommitGate commits.
    expect(canvas.nodeCount).toBe(1);
  });
});

describe('arrangeLayout (ROUND3 A1)', () => {
  it('stages a setDirection mutation, whole-diagram or scoped, and touches no component', async () => {
    const { gm, staging, canvas, arrangeLayout } = setup(1);
    const g1 = gm.start('restructure this top to bottom');
    canvas.apply({ op: 'addNode', node: { id: 'a', label: 'A', kind: 'service', x: 0, y: 0 } });
    const sig = new AbortController().signal;

    const r = await callExecute(arrangeLayout, { direction: 'DOWN' }, { abortSignal: sig });
    expect(r).toContain('Staged');
    expect(staging.pendingFor(g1.id)[0]?.mutation).toEqual({ op: 'setDirection', direction: 'DOWN' });

    await callExecute(arrangeLayout, { direction: 'UP', scope: 'Workers' }, { abortSignal: sig });
    expect(staging.pendingFor(g1.id)[1]?.mutation).toEqual({
      op: 'setDirection',
      direction: 'UP',
      scope: 'Workers',
    });

    // No node/edge mutation was staged.
    expect(staging.pendingFor(g1.id).every((s) => s.mutation.op === 'setDirection')).toBe(true);
    expect(canvas.nodeCount).toBe(1);
  });

  it('stages against the commit gate — direction does not change until the sentence is heard', async () => {
    const { gm, canvas, arrangeLayout } = setup(1);
    canvas.apply({ op: 'addNode', node: { id: 'a', label: 'A', kind: 'service', x: 0, y: 0 } });
    gm.start('make it vertical');
    await callExecute(arrangeLayout, { direction: 'DOWN' }, { abortSignal: new AbortController().signal });
    // Staged only — the store's direction is still the default.
    expect(canvas.currentDirection).toBe('RIGHT');
  });
});

describe('undoLast + groupComponents + exportDiagram', () => {
  it('undoLast stages an undo op, or says nothing to undo when history is empty', async () => {
    const { gm, staging, canvas, undoLast } = setup(1);
    const g1 = gm.start('undo that');
    const sig = new AbortController().signal;

    expect(await callExecute(undoLast, {}, { abortSignal: sig })).toContain('nothing to undo');

    canvas.apply({ op: 'addNode', node: { id: 'a', label: 'A', kind: 'service', x: 0, y: 0 } });
    const res = await callExecute(undoLast, {}, { abortSignal: sig });
    expect(res).toContain('Staged');
    expect(staging.pendingFor(g1.id)[0]?.mutation).toEqual({ op: 'undo' });
  });

  it('groupComponents accepts an array or a comma/and string of members', async () => {
    const { gm, staging, groupComponents } = setup(1);
    const g1 = gm.start('draw a boundary');
    const sig = new AbortController().signal;

    await callExecute(groupComponents, { label: 'VPC', memberLabels: ['Orders', 'Payments'] }, { abortSignal: sig });
    await callExecute(
      groupComponents,
      { label: 'DMZ', memberLabels: 'API Gateway and Auth Service' },
      { abortSignal: sig },
    );

    const staged = staging.pendingFor(g1.id).map((s) => s.mutation);
    expect(staged[0]).toMatchObject({ op: 'addGroup', memberIds: ['orders', 'payments'] });
    expect(staged[1]).toMatchObject({ op: 'addGroup', memberIds: ['api-gateway', 'auth-service'] });
  });

  it('exportDiagram publishes a mermaid panel message and stages nothing', async () => {
    const { canvas, published, exportDiagram } = setup(1);
    canvas.apply({ op: 'addNode', node: { id: 'api', label: 'API', kind: 'gateway', x: 0, y: 0 } });

    const res = await callExecute(exportDiagram, {}, { abortSignal: new AbortController().signal });
    expect(res).toContain('on screen');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 'export', format: 'mermaid' });
    expect((published[0] as { content: string }).content).toContain('flowchart LR');
  });
});

describe('describeArchitecture (B7)', () => {
  it('returns the real structure — labels, kinds, edges — not a bare count', async () => {
    const { canvas, describeArchitecture } = setup(1);
    canvas.apply({ op: 'addNode', node: { id: 'api', label: 'API Gateway', kind: 'gateway', x: 0, y: 0 } });
    canvas.apply({ op: 'addNode', node: { id: 'redis', label: 'Redis', kind: 'datastore', x: 0, y: 0 } });
    canvas.apply({ op: 'addEdge', edge: { id: 'api-redis', source: 'api', target: 'redis' } });

    const result = String(await callExecute(describeArchitecture, {}, { abortSignal: new AbortController().signal }));

    expect(result).toContain('API Gateway (gateway)');
    expect(result).toContain('Redis (datastore)');
    expect(result).toContain('API Gateway -> Redis');
    expect(result).not.toMatch(/\d+ component/); // no "has 2 component(s)."
  });

  it('reports an empty diagram plainly', async () => {
    const { describeArchitecture } = setup(1);
    const result = await callExecute(describeArchitecture, {}, { abortSignal: new AbortController().signal });
    expect(result).toBe('The diagram is currently empty.');
  });
});
