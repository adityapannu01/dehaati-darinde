// The ghost / proposal store (TECHNICAL_REVIEW.md §2.4).
//
// A proposal is inferred from overheard engineer speech. It is NOT canvas
// state: it never enters CanvasStore, never appears in the oracle's expected
// *committed* state, and is only promoted to a real mutation when a human
// confirms it or the agent narrates it aloud — at which point the promotion
// goes through CommitGate like any other mutation.
//
//   Safety invariant (README verbatim): overheard speech can only ever CREATE
//   or DESTROY proposals. Committed state is changed only by addressed speech.
//   A misheard disagreement costs a ghost. Nothing a judge says to a colleague
//   can destroy the diagram.
//
// Pure TypeScript, no LiveKit — the benchmark drives it directly.

import { randomUUID } from 'node:crypto';
import type { GhostElement, MutationOp, NodeKind } from '@repo/protocol';

export interface ProposalInput {
  element: 'node' | 'edge';
  label: string;
  kind?: NodeKind;
  source?: string;
  target?: string;
  proposedBy: string;
  confidence: number;
}

export interface ProposalStoreOptions {
  /** How long a ghost survives without promotion. Default 45s. */
  ttlMs?: number;
  now?: () => number;
}

export class ProposalStore {
  private ghosts = new Map<string, GhostElement>();
  private ttlMs: number;
  private now: () => number;

  constructor(opts: ProposalStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 45_000;
    this.now = opts.now ?? Date.now;
  }

  /** Create a ghost. A near-duplicate (same element + label) refreshes the existing one instead. */
  propose(input: ProposalInput): GhostElement {
    const existing = [...this.ghosts.values()].find(
      (g) => g.element === input.element && g.label.toLowerCase() === input.label.toLowerCase()
    );
    if (existing) {
      existing.expiresAt = this.now() + this.ttlMs;
      existing.confidence = Math.max(existing.confidence, input.confidence);
      return existing;
    }
    const ghost: GhostElement = {
      id: `ghost-${randomUUID().slice(0, 8)}`,
      element: input.element,
      label: input.label,
      kind: input.kind,
      source: input.source,
      target: input.target,
      proposedBy: input.proposedBy,
      confidence: input.confidence,
      expiresAt: this.now() + this.ttlMs,
    };
    this.ghosts.set(ghost.id, ghost);
    return ghost;
  }

  list(): GhostElement[] {
    return [...this.ghosts.values()];
  }

  get(id: string): GhostElement | undefined {
    return this.ghosts.get(id);
  }

  /**
   * Promote a ghost to a real mutation. Removes the ghost and returns the
   * MutationOp the caller must stage through CommitGate — promotion is NOT a
   * direct canvas write. Returns undefined for an unknown id.
   */
  promote(id: string): MutationOp | undefined {
    const g = this.ghosts.get(id);
    if (!g) return undefined;
    this.ghosts.delete(id);
    if (g.element === 'node') {
      return {
        op: 'addNode',
        node: { id: slug(g.label), label: g.label, kind: g.kind ?? 'service', x: 0, y: 0 },
      };
    }
    return {
      op: 'addEdge',
      edge: { id: `${g.source}-${g.target}`, source: g.source ?? '', target: g.target ?? '' },
    };
  }

  /** Remove one ghost (explicit rejection). */
  reject(id: string): boolean {
    return this.ghosts.delete(id);
  }

  /**
   * Remove ghosts a disagreement utterance refers to. Matches the ghost's label
   * as a full phrase OR by a shared significant token ("no Kafka" removes the
   * "Kafka queue" ghost). Returns the removed ghosts.
   */
  rejectMatching(text: string): GhostElement[] {
    const removed: GhostElement[] = [];
    for (const g of [...this.ghosts.values()]) {
      if (mentions(text, g.label)) {
        this.ghosts.delete(g.id);
        removed.push(g);
      }
    }
    return removed;
  }

  /** Drop every ghost past its TTL. Returns what was removed. */
  expire(): GhostElement[] {
    const now = this.now();
    const removed: GhostElement[] = [];
    for (const g of [...this.ghosts.values()]) {
      if (g.expiresAt <= now) {
        this.ghosts.delete(g.id);
        removed.push(g);
      }
    }
    return removed;
  }

  clear(): void {
    this.ghosts.clear();
  }
}

function slug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

const STOP_TOKENS = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'my', 'our', 'service', 'db']);

/** True if `text` names `label` — full phrase, or a shared significant (≥3-char, non-stop) token. */
function mentions(text: string, label: string): boolean {
  const lower = text.toLowerCase();
  if (label.length >= 3 && lower.includes(label.toLowerCase())) return true;
  const textTokens = new Set(lower.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean));
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t))
    .some((t) => textTokens.has(t));
}
