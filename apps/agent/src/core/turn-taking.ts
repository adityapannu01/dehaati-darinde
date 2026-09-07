// Whether a user's final transcript, arriving while the agent is mid-narration,
// is a *backchannel* ("mm-hmm", "yeah", "right") rather than a real interruption
// or a new instruction.
//
// Why this matters (TECHNICAL_REVIEW.md B1): the generation fence in main.ts
// fires on every final transcript. LiveKit's adaptive interruption correctly
// decides NOT to stop the agent for a backchannel, but our fence had already
// rolled the generation counter and reset the delivery tracker — orphaning the
// staged mutation whose sentence the agent is still speaking, with no ledger
// event. A *silent* violation of the core invariant.
//
// The fix: run every final transcript past `isBackchannel` before the fence.
// A backchannel is acknowledged on the ledger and otherwise ignored, exactly
// as adaptive interruption ignores it one layer down.
//
// Pure TypeScript, no LiveKit imports, so the benchmark can drive it directly.

/**
 * Single-word utterances that are always a real interruption even though they
 * fall under `minWords`. "no", "wait", "stop" mid-narration is a correction,
 * not a backchannel — never swallow them.
 */
const HARD_INTERRUPT_WORDS = new Set([
  'no',
  'nope',
  'stop',
  'wait',
  'cancel',
  'scratch',
  'actually',
  'hold',
  'hang',
  'undo',
  'redo',
  'remove',
  'delete',
  'change',
]);

/**
 * Acknowledgement tokens. A short transcript made up entirely of these is a
 * backchannel even if it clears `minWords` ("yeah okay", "got it", "makes sense").
 */
const BACKCHANNEL_WORDS = new Set([
  'mm',
  'mmm',
  'mhm',
  'mmhm',
  'mmhmm',
  'mhmm',
  'hm',
  'hmm',
  'uh',
  'um',
  'uhhuh',
  'huh',
  'ah',
  'aha',
  'oh',
  'yeah',
  'yep',
  'yup',
  'yes',
  'ok',
  'okay',
  'kay',
  'right',
  'sure',
  'nice',
  'cool',
  'good',
  'great',
  'gotcha',
  'got',
  'it',
  'i',
  'see',
  'exactly',
  'totally',
  'true',
  'makes',
  'sense',
  'agreed',
  'word',
]);

export interface BackchannelOptions {
  /**
   * A transcript shorter than this many words is treated as a backchannel.
   * Mirrors `turnHandling.interruption.minWords` in main.ts so the two layers
   * agree. Default 2.
   */
  minWords?: number;
}

/** Tokenise for classification: lowercase, letters only, split on non-letters. */
function words(transcript: string): string[] {
  return transcript
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/**
 * True when `transcript` should NOT roll the generation / fence the current
 * turn. See the file header for why.
 */
export function isBackchannel(transcript: string, opts: BackchannelOptions = {}): boolean {
  const minWords = opts.minWords ?? 2;
  const w = words(transcript);

  if (w.length === 0) return true; // empty final transcript — nothing was said
  if (w.some((token) => HARD_INTERRUPT_WORDS.has(token))) return false;
  if (w.length < minWords) return true; // "mm", "yeah", "okay"
  if (w.length <= 3 && w.every((token) => BACKCHANNEL_WORDS.has(token))) return true;

  return false;
}
