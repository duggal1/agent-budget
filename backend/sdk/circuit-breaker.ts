import type { BudgetUsage } from './types.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  repetitionWindow?: number;    // default 3 — consecutive steps to check
  repetitionThreshold?: number; // default 0.85 — Jaccard similarity to trip
  stagnationWindow?: number;    // default 4
  stagnationMinLength?: number; // default 50 chars
}

// ─── Trip result ─────────────────────────────────────────────────────────────

export interface CircuitBreakerTrip {
  triggerMode: 'repetition' | 'stagnation';
  windowSize: number;
  similarity?: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS: Required<CircuitBreakerConfig> = {
  repetitionWindow: 3,
  repetitionThreshold: 0.85,
  stagnationWindow: 4,
  stagnationMinLength: 50,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeText(a).split(' '));
  const wordsB = new Set(normalizeText(b).split(' '));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── CircuitBreaker ──────────────────────────────────────────────────────────

/**
 * Stateless circuit breaker. Pulls stepHistory from BudgetUsage each time
 * it is checked. No internal data store across calls.
 */
export class CircuitBreaker {
  private readonly cfg: Required<CircuitBreakerConfig>;

  constructor(config?: CircuitBreakerConfig) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  /**
   * Analyze recent step history and return a trip if repetition or stagnation
   * is detected. Returns null if all clear.
   */
  check(usage: BudgetUsage): CircuitBreakerTrip | null {
    return this.checkRepetition(usage) ?? this.checkStagnation(usage);
  }

  private checkRepetition(usage: BudgetUsage): CircuitBreakerTrip | null {
    const history = usage.stepHistory;
    if (history.length < this.cfg.repetitionWindow) return null;

    // Look at the last N entries for consecutive similarity
    const recent = history.slice(-this.cfg.repetitionWindow);

    let checkedPairs = 0;
    let totalSim = 0;

    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1].outputContent;
      const curr = recent[i].outputContent;
      if (!prev || !curr) continue;

      checkedPairs++;
      const sim = jaccardSimilarity(prev, curr);
      totalSim += sim;

      if (sim < this.cfg.repetitionThreshold) {
        return null;
      }
    }

    // Need at least one valid pair to trip
    if (checkedPairs === 0) return null;

    return {
      triggerMode: 'repetition',
      windowSize: this.cfg.repetitionWindow,
      similarity: totalSim / checkedPairs,
    };
  }

  private checkStagnation(usage: BudgetUsage): CircuitBreakerTrip | null {
    const history = usage.stepHistory;
    if (history.length < this.cfg.stagnationWindow) return null;

    // Only consider steps that have outputContent set — steps recorded via
    // recordStep() or other non-LLM paths have no output content and skipping
    // them prevents false-positive stagnation trips.
    const recent = history.slice(-this.cfg.stagnationWindow).filter((s) => s.outputContent !== undefined);
    if (recent.length < this.cfg.stagnationWindow) return null;

    const allStagnant = recent.every(
      (s) => s.outputContent!.length < this.cfg.stagnationMinLength
    );

    if (!allStagnant) return null;

    return {
      triggerMode: 'stagnation',
      windowSize: this.cfg.stagnationWindow,
    };
  }
}
