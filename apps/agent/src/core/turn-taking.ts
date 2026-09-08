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
 *
 * ROUND3 B3: this also carries the single-word COMMAND vocabulary — "undo",
 * "clear", "vertical", "left". Without it those do nothing until the user adds
 * words (a real UX regression from the round-1 minWords floor). Kept in sync
 * with the tool surface by `turn-taking.test.ts`, which asserts every
 * `arrangeLayout` direction and every zero-arg-tool verb is present. Do NOT
 * fix B3 by lowering minWords — the grunt filter was expensive to get right.
 */
const HARD_INTERRUPT_WORDS = new Set([
  // conversational corrections
  'no',
  'nope',
  'stop',
  'wait',
  'cancel',
  'scratch',
  'actually',
  'hold',
  'hang',
  // tool verbs — undoLast / clearCanvas / (re-run)
  'undo',
  'redo',
  'again',
  'clear',
  'reset',
  'wipe',
  'remove',
  'delete',
  'change',
  // arrangeLayout directions + the natural synonyms
  'left',
  'up',
  'down',
  'vertical',
  'horizontal',
  'restructure',
  'rearrange',
  'reorient',
  'flip',
]);

/**
 * Command words that are ALSO plausible backchannels ("right" = "correct" or
 * "go right"). Resolved by context in `isBackchannel`: a command only when the
 * agent is not mid-sentence, so it can't be an acknowledgement of ongoing speech.
 */
const AMBIGUOUS_COMMAND_WORDS = new Set(['right']);

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
  /**
   * Whether the agent is currently speaking. Disambiguates AMBIGUOUS_COMMAND_WORDS
   * ("right"): a bare "right" while the agent talks is an acknowledgement; while
   * it is silent (e.g. just finished, or asked a question) it is "go right".
   */
  agentSpeaking?: boolean;
}

/** The single-word command vocabulary — for a test to check nothing drifted from the tools. */
export const SINGLE_WORD_COMMANDS: readonly string[] = [
  ...HARD_INTERRUPT_WORDS,
  ...AMBIGUOUS_COMMAND_WORDS,
];

// ROUND3 B2: the instant acknowledgement spoken the moment a real interruption
// fences, while the LLM plans the reply. It carries no mutation, so it stages
// nothing. It MUST NOT end in a sentence terminator — DeliveryTracker would
// count it as sentence 0 and commit the reply's first mutation before its
// describing sentence is spoken. Enforced by turn-taking.test.ts.
export const ACK_TOKENS = ['Okay,', 'Right,', 'Sure,', 'Mm, okay,', 'Got it,'] as const;

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
  // B3: a bare ambiguous command ("right") is a command only when the agent
  // isn't mid-sentence — otherwise it's an acknowledgement of ongoing speech.
  if (w.length === 1 && AMBIGUOUS_COMMAND_WORDS.has(w[0]!)) return opts.agentSpeaking ?? true;
  if (w.length < minWords) return true; // "mm", "yeah", "okay"
  if (w.length <= 3 && w.every((token) => BACKCHANNEL_WORDS.has(token))) return true;

  return false;
}
