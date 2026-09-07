// Two-axis classifier for ambient meeting mode (TECHNICAL_REVIEW.md §2.3/§2.6).
//
// Two INDEPENDENT questions per utterance:
//   - addressivity — is this directed at the agent?  -> controls whether it SPEAKS
//   - salience     — does it contain architecture content?  -> controls whether it DRAWS
//
// The design finding that shapes this (SAS work): removing short-horizon
// conversational context drops F1 from 0.95 to 0.57. "make that Postgres" is
// lexically identical whether aimed at a machine or a colleague — only the last
// few seconds of interaction history disambiguates. So the classifier input is
// NEVER the bare utterance; it always carries a rolling context window.
//
// Layer 1 here is a FREE prefilter (0 ms, pure string work): confident cases
// never reach a model. Layer 2 (a ~100-200 ms structured LLM call) is optional
// and injected — see graph/nodes/address.ts. Nothing is trained.
//
// Pure TypeScript, no LiveKit — the benchmark drives it directly.

export type Stance = 'agree' | 'disagree' | 'neutral';

export interface RecentUtterance {
  speaker: string;
  text: string;
  atMs: number;
}

export interface AddressivityContext {
  /** Rolling window, newest last, already trimmed to ~8s by the caller. */
  recent: RecentUtterance[];
  /** The agent's most recent spoken text, if it was within the window. */
  agentRecentlySaid?: string | undefined;
  /** True if the agent's last utterance ended with a question. */
  agentAskedQuestion: boolean;
  /** Labels currently on the committed canvas — "the cache" resolves against these. */
  canvasVocabulary: string[];
  /** Classification threshold τ — HUD-exposed. A score at/above it counts as positive. */
  threshold: number;
}

export interface AddressivityScore {
  /** 0..1 — is this directed at the agent. */
  addressed: number;
  /** 0..1 — does this contain architecture content. */
  salient: number;
  stance: Stance;
  /** Where the score came from. */
  by: 'prefilter' | 'model';
  /** Short strings for the ledger / HUD. */
  reasons: string[];
}

const AGENT_NAMES = ['cartograph', 'cartographer', 'hey agent', 'okay agent', 'computer'];

const SECOND_PERSON = /\b(you|your|you're|youre|y'?all)\b/i;

// Verbs/phrasings that describe a diagram change.
const ARCH_VERBS =
  /\b(add|adding|put|need|want|connect|connects?|wire|wires?|link|links?|draw|drops?|remove|delete|replace|swap|rename|call it|make (it|that)|use|uses?|route|send|publish(es)?|subscribe|talks? to|sits? behind|in front of|point (it|that) (to|at)|hang off|feeds? into)\b/i;

// Common infra nouns — a rough salience signal independent of the live canvas.
const INFRA_NOUNS =
  /\b(service|gateway|api|database|db|datastore|cache|queue|bus|broker|load balancer|proxy|cdn|bucket|worker|cluster|node|endpoint|topic|stream|lambda|function|frontend|backend|redis|postgres|kafka|mongo|mysql|dynamo|nginx|s3|rabbitmq|sqs|sns|elasticsearch|clickhouse|grpc|graphql|rest|websocket)\b/i;

const DISAGREE =
  /\b(no|nope|not|don'?t|won'?t work|isn'?t right|scratch that|forget (it|that)|never mind|we'?re not (using|doing)|instead of|rather than|actually no|drop that|take (it|that) (out|off)|remove that|bad idea|wrong)\b/i;

const AGREE =
  /\b(yes|yeah|yep|yup|exactly|right|correct|agreed|sounds good|let'?s do (it|that)|do (it|that)|good (call|idea)|perfect|makes sense|that works|go for it|ship it)\b/i;

// Verbs that, leading an utterance, make it an imperative — which could be
// aimed at the agent. Never treat an imperative as a confident "aside".
const IMPERATIVE_LEAD = new Set([
  'add', 'put', 'connect', 'wire', 'link', 'draw', 'remove', 'delete', 'replace',
  'swap', 'rename', 'make', 'use', 'move', 'change', 'do', 'try', 'give', 'show',
  'undo', 'redo', 'clear', 'wipe', 'name', 'call', 'route', 'send', 'point', 'set',
]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Significant tokens of a label — for "the cache" ↔ "Redis cache" matching. */
function significantTokens(s: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'my', 'our', 'service', 'db']);
  return words(s).filter((w) => w.length >= 3 && !stop.has(w));
}

/** True if `text` mentions `label` — full phrase, or a shared significant token. */
function mentions(text: string, label: string): boolean {
  const lower = text.toLowerCase();
  if (label.length >= 3 && lower.includes(label.toLowerCase())) return true;
  const textTokens = new Set(words(text));
  return significantTokens(label).some((t) => textTokens.has(t));
}

function isImperative(text: string): boolean {
  const w = words(text);
  if (w.length === 0) return false;
  if (w[0] === 'let' && w[1] === 's') return true; // "let's ..."
  return IMPERATIVE_LEAD.has(w[0]!);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function salienceOf(utterance: string, ctx: AddressivityContext): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (ARCH_VERBS.test(utterance)) {
    score += 0.45;
    reasons.push('arch-verb');
  }
  if (INFRA_NOUNS.test(utterance)) {
    score += 0.35;
    reasons.push('infra-noun');
  }
  const vocabHit = ctx.canvasVocabulary.find((v) => mentions(utterance, v));
  if (vocabHit) {
    score += 0.4;
    reasons.push(`names "${vocabHit}"`);
  }
  // Very short utterances ("yeah", "no", "mm") carry no architecture content on
  // their own, even if a keyword grazes.
  if (words(utterance).length < 2) {
    score = Math.min(score, 0.15);
    reasons.push('too-short');
  }
  return { score: clamp01(score), reasons };
}

function stanceOf(utterance: string): Stance {
  // Disagreement wins ties — a misread "agree" costs a spurious ghost; a
  // misread "disagree" only removes a ghost (§2.4 safety).
  if (DISAGREE.test(utterance)) return 'disagree';
  if (AGREE.test(utterance)) return 'agree';
  return 'neutral';
}

/**
 * Layer 1: the free prefilter. Returns a confident score, or `null` when the
 * utterance is genuinely ambiguous and should go to the model.
 */
export function prefilterScore(utterance: string, ctx: AddressivityContext): AddressivityScore | null {
  const reasons: string[] = [];
  const lower = utterance.toLowerCase();
  const w = words(utterance);
  const { score: salient, reasons: salReasons } = salienceOf(utterance, ctx);
  const stance = stanceOf(utterance);

  // --- confident ADDRESSED ---
  if (AGENT_NAMES.some((n) => lower.includes(n))) {
    return { addressed: 0.98, salient, stance, by: 'prefilter', reasons: ['direct-address', ...salReasons] };
  }
  // A short, clear answer right after the agent asked a question.
  if (ctx.agentAskedQuestion && w.length <= 6 && (stance !== 'neutral' || /\b(the|a|use|make)\b/i.test(utterance))) {
    return {
      addressed: 0.85,
      salient,
      stance,
      by: 'prefilter',
      reasons: ['answers-agent-question', ...salReasons],
    };
  }
  // Imperative + second person, directed at something that can act.
  if (SECOND_PERSON.test(utterance) && ARCH_VERBS.test(utterance)) {
    return { addressed: 0.8, salient, stance, by: 'prefilter', reasons: ['2nd-person + arch-verb', ...salReasons] };
  }

  // --- confident NOT ADDRESSED ---
  // A reaction to a proposal ("no, we're not using Kafka", "yeah let's do that")
  // with architecture content but no address cue: someone responding to a
  // colleague, not commanding the agent. Surfaces the stance so ambient mode can
  // add/remove a ghost, and keeps the agent quiet.
  if (stance !== 'neutral' && salient >= 0.25 && !SECOND_PERSON.test(utterance) && !ctx.agentAskedQuestion) {
    return {
      addressed: 0.12,
      salient,
      stance,
      by: 'prefilter',
      reasons: [`reaction to a proposal (${stance})`, ...salReasons],
    };
  }
  // Two engineers talking to each other: names another person, or is clearly
  // conversational with no imperative and no address cue.
  const mentionsOtherSpeaker = ctx.recent.some(
    (u) => u.speaker !== 'agent' && u.speaker.length > 1 && lower.includes(u.speaker.toLowerCase())
  );
  if (mentionsOtherSpeaker) {
    return { addressed: 0.05, salient, stance, by: 'prefilter', reasons: ['names another speaker', ...salReasons] };
  }
  // Pure backchannel / musing: short, no architecture content, no imperative
  // (an imperative like "do it again" could be aimed at the agent — route it).
  if (w.length <= 3 && salient < 0.2 && !SECOND_PERSON.test(utterance) && !isImperative(utterance)) {
    return { addressed: 0.1, salient, stance, by: 'prefilter', reasons: ['short non-salient aside', ...salReasons] };
  }
  // A statement of architecture content with no address cue at all — likely
  // thinking out loud to a colleague. Salient (so it can draw a ghost) but not
  // addressed (so the agent stays quiet).
  if (salient >= 0.5 && !SECOND_PERSON.test(utterance) && !ctx.agentAskedQuestion && w.length >= 4) {
    return {
      addressed: 0.2,
      salient,
      stance,
      by: 'prefilter',
      reasons: ['architecture content, no address cue', ...salReasons],
    };
  }

  reasons.push(...salReasons);
  return null; // ambiguous — hand to the model
}

/**
 * Full classification: prefilter, then the optional model. When no model is
 * supplied and the prefilter is unsure, fall back to a deliberately cautious
 * guess (low addressed, salience as measured) — better to stay quiet and draw a
 * ghost than to speak over a conversation.
 */
export async function classifyUtterance(
  utterance: string,
  ctx: AddressivityContext,
  model?: (utterance: string, ctx: AddressivityContext) => Promise<AddressivityScore>
): Promise<AddressivityScore> {
  const pre = prefilterScore(utterance, ctx);
  if (pre) return pre;
  if (model) {
    try {
      return await model(utterance, ctx);
    } catch {
      /* fall through to the cautious guess */
    }
  }
  const { score: salient, reasons } = salienceOf(utterance, ctx);
  return {
    addressed: 0.3,
    salient,
    stance: stanceOf(utterance),
    by: 'prefilter',
    reasons: ['ambiguous — cautious fallback', ...reasons],
  };
}

/** The 2x2 routing decision from §2.3. */
export interface UtteranceRouting {
  speak: boolean;
  draw: boolean;
}

export function route(score: AddressivityScore, threshold: number): UtteranceRouting {
  const addressed = score.addressed >= threshold;
  const salient = score.salient >= threshold;
  return {
    // Addressed -> speak (answer or commit). Not addressed -> never speak.
    speak: addressed,
    // Addressed + salient -> commit path (handled elsewhere). Not addressed +
    // salient -> draw a silent ghost proposal. Not salient -> draw nothing.
    draw: salient,
  };
}
