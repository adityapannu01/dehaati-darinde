import { describe, expect, it } from 'vitest';
import { DIRECTIONS, checkDirection, runFixture } from './layout-fixture.ts';

// ROUND3 Module C — the layout regression fixture. A fixed 12-node / 3-group
// graph run through the real CanvasStore + ELK pipeline in all four directions.
describe('layout regression fixture (ROUND3 Module C)', () => {
  it('holds every invariant in all four directions', async () => {
    const checks = await runFixture();
    expect(checks.map((c) => c.direction)).toEqual([...DIRECTIONS]);
    for (const c of checks) {
      expect(c.violations, `${c.direction}: ${c.violations.join('; ')}`).toEqual([]);
    }
  });

  it('places all 12 nodes and derives exactly 3 group boxes each way', async () => {
    for (const direction of DIRECTIONS) {
      const { snapshot } = await checkDirection(direction);
      expect(snapshot.nodes, direction).toHaveLength(12);
      expect(snapshot.groups, direction).toHaveLength(3);
      expect(snapshot.direction, direction).toBe(direction);
    }
  });

  it('keeps the ungrouped S3 archive out of every boundary box', async () => {
    for (const direction of DIRECTIONS) {
      const { snapshot } = await checkDirection(direction);
      const s3 = snapshot.nodes.find((n) => n.id === 's3')!;
      const cx = s3.x + 84;
      const cy = s3.y + 23;
      for (const g of snapshot.groups) {
        const inside = cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height;
        expect(inside, `${direction}: s3 centre fell inside ${g.label}`).toBe(false);
      }
    }
  });

  it('is deterministic — same placement on a re-run', async () => {
    const a = await checkDirection('RIGHT');
    const b = await checkDirection('RIGHT');
    expect(a.snapshot.nodes.map((n) => `${n.id}@${n.x},${n.y}`)).toEqual(
      b.snapshot.nodes.map((n) => `${n.id}@${n.x},${n.y}`),
    );
  });
});
