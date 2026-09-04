import { describe, expect, it } from 'vitest';
import { deriveExpectedCanvas, diff, isDiffEmpty } from './oracle.ts';
import type { Scenario } from './scenarios.ts';

function scenario(deliveredSentences: number): Scenario {
  return {
    id: 'test',
    toolDelayMs: 0,
    interruptAt: 'during_speech_s2',
    corrections: 1,
    turns: [
      {
        mutations: [
          {
            anchorPhrase: 'a',
            mutation: { op: 'addNode', node: { id: 'a', label: 'A', kind: 'service', x: 0, y: 0 } },
          },
          {
            anchorPhrase: 'b',
            mutation: { op: 'addEdge', edge: { id: 'a-b', source: 'a', target: 'b' } },
          },
        ],
        deliveredSentences,
        interrupted: deliveredSentences < 2,
      },
    ],
  };
}

describe('deriveExpectedCanvas', () => {
  it('a truncated transcript (1 of 2 sentences heard) yields the truncated canvas', () => {
    const expected = deriveExpectedCanvas(scenario(1));
    expect(expected.nodes.map((n) => n.id)).toEqual(['a']);
    expect(expected.edges).toHaveLength(0);
  });

  it('a fully-delivered transcript yields the full canvas', () => {
    const expected = deriveExpectedCanvas(scenario(2));
    expect(expected.nodes.map((n) => n.id)).toEqual(['a']);
    expect(expected.edges.map((e) => e.id)).toEqual(['a-b']);
  });

  it('nothing delivered yields an empty canvas', () => {
    const expected = deriveExpectedCanvas(scenario(0));
    expect(expected.nodes).toHaveLength(0);
    expect(expected.edges).toHaveLength(0);
  });
});

describe('diff / isDiffEmpty', () => {
  it('reports no difference for identical snapshots', () => {
    const snap = deriveExpectedCanvas(scenario(2));
    expect(isDiffEmpty(diff(snap, snap))).toBe(true);
  });

  it('reports extra nodes/edges present in actual but not expected', () => {
    const expected = deriveExpectedCanvas(scenario(1)); // only node 'a'
    const actual = deriveExpectedCanvas(scenario(2)); // node 'a' + edge 'a-b'
    const d = diff(expected, actual);
    expect(d.extraEdgeIds).toEqual(['a-b']);
    expect(d.missingNodeIds).toHaveLength(0);
    expect(isDiffEmpty(d)).toBe(false);
  });
});
