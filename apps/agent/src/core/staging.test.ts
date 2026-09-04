import type { MutationOp } from '@repo/protocol';
import { describe, expect, it } from 'vitest';
import { StagingBuffer } from './staging.ts';

function addNode(id: string, label: string): MutationOp {
  return { op: 'addNode', node: { id, label, kind: 'service', x: 0, y: 0 } };
}

describe('StagingBuffer', () => {
  it('commitThrough commits only mutations up to the given sentence index', () => {
    const staging = new StagingBuffer();
    staging.stage(1, 0, 'Redis', addNode('redis', 'Redis'));
    staging.stage(1, 1, 'API', addNode('api', 'API'));

    const applied: MutationOp[] = [];
    const committed = staging.commitThrough(1, 0, (m) => applied.push(m));

    expect(committed).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(committed[0]?.anchorPhrase).toBe('Redis');
    expect(staging.pendingFor(1)).toHaveLength(1);
    expect(staging.pendingFor(1)[0]?.anchorPhrase).toBe('API');
  });

  it('dropAll returns the remainder and empties the buffer', () => {
    const staging = new StagingBuffer();
    staging.stage(1, 0, 'Redis', addNode('redis', 'Redis'));
    staging.stage(1, 1, 'API', addNode('api', 'API'));

    const dropped = staging.dropAll(1);

    expect(dropped).toHaveLength(2);
    expect(staging.pendingFor(1)).toHaveLength(0);
  });

  it('generations are isolated from each other', () => {
    const staging = new StagingBuffer();
    staging.stage(41, 0, 'Old', addNode('old', 'Old'));
    staging.stage(42, 0, 'New', addNode('new', 'New'));

    staging.dropAll(42);

    expect(staging.pendingFor(41)).toHaveLength(1);
    expect(staging.pendingFor(42)).toHaveLength(0);
  });

  it('commitThrough on an empty/unknown generation commits nothing', () => {
    const staging = new StagingBuffer();
    const committed = staging.commitThrough(99, 5, () => {
      throw new Error('should not be called');
    });
    expect(committed).toHaveLength(0);
  });
});
