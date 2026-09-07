import { describe, expect, it } from 'vitest';
import {
  type AddressivityContext,
  classifyUtterance,
  prefilterScore,
  route,
} from './addressivity.ts';

function ctx(over: Partial<AddressivityContext> = {}): AddressivityContext {
  return {
    recent: [],
    agentAskedQuestion: false,
    canvasVocabulary: [],
    threshold: 0.6,
    ...over,
  };
}

describe('addressivity prefilter', () => {
  it('a direct address is confidently addressed', () => {
    const s = prefilterScore('Cartograph, add a Redis cache', ctx());
    expect(s?.addressed).toBeGreaterThan(0.9);
    expect(s?.salient).toBeGreaterThan(0.5);
  });

  it('architecture content with no address cue is salient but not addressed (draw a ghost, stay quiet)', () => {
    const s = prefilterScore('I think we need a Kafka queue between those two services', ctx());
    expect(s).not.toBeNull();
    expect(s!.addressed).toBeLessThan(0.5);
    expect(s!.salient).toBeGreaterThanOrEqual(0.6);
    expect(route(s!, 0.6)).toEqual({ speak: false, draw: true });
  });

  it('a short answer right after the agent asked a question is addressed', () => {
    const s = prefilterScore('use Postgres', ctx({ agentAskedQuestion: true }));
    expect(s?.addressed).toBeGreaterThan(0.6);
  });

  it('naming another person in the room reads as not addressed', () => {
    const s = prefilterScore('bob what do you think about the cache', ctx({
      recent: [{ speaker: 'bob', text: 'hm', atMs: 0 }],
    }));
    expect(s?.addressed).toBeLessThan(0.2);
  });

  it('a pure backchannel is not addressed and not salient', () => {
    const s = prefilterScore('yeah mm', ctx());
    expect(s?.addressed).toBeLessThan(0.2);
    expect(s?.salient).toBeLessThan(0.2);
    expect(route(s!, 0.6)).toEqual({ speak: false, draw: false });
  });

  it('detects a disagreement stance, and disagreement wins ties', () => {
    expect(prefilterScore("no, we're not using Kafka", ctx())?.stance).toBe('disagree');
    expect(prefilterScore('yeah but no', ctx())?.stance).toBe('disagree');
  });

  it('resolves "the cache" against the live canvas vocabulary for salience', () => {
    const s = prefilterScore('make the cache bigger', ctx({ canvasVocabulary: ['Redis cache', 'API Gateway'] }));
    expect(s).not.toBeNull();
    expect(s!.salient).toBeGreaterThanOrEqual(0.4);
  });

  it('returns null (route to model) for a genuinely ambiguous utterance', () => {
    expect(prefilterScore('do it again', ctx())).toBeNull();
  });
});

describe('classifyUtterance', () => {
  it('uses the model when the prefilter is unsure', async () => {
    const model = async () => ({
      addressed: 0.9,
      salient: 0.9,
      stance: 'neutral' as const,
      by: 'model' as const,
      reasons: ['model says addressed'],
    });
    const s = await classifyUtterance('do it again', ctx(), model);
    expect(s.by).toBe('model');
    expect(s.addressed).toBe(0.9);
  });

  it('falls back cautiously when unsure and no model is available', async () => {
    const s = await classifyUtterance('do it again', ctx());
    expect(s.addressed).toBeLessThan(0.5); // stay quiet rather than speak over the room
  });

  it('never calls the model when the prefilter is confident', async () => {
    let called = false;
    const model = async () => {
      called = true;
      return { addressed: 1, salient: 1, stance: 'neutral' as const, by: 'model' as const, reasons: [] };
    };
    await classifyUtterance('Cartograph, clear the board', ctx(), model);
    expect(called).toBe(false);
  });
});
