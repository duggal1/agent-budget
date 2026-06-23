import type { BudgetUsage } from './types.js';

// ─── Default thresholds ─────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = [0.6, 0.85];

// ─── Router ────────────────────────────────────────────────────────────────

export interface RoutingDecision {
  model: string;
  index: number;
}

/**
 * Resolves which model to use from the fallback chain based on current
 * budget consumption. Returns the model and its index in the chain.
 */
export function resolveModel(
  fallbackChain: string[],
  thresholds: number[] | undefined,
  usage: BudgetUsage,
  maxCostUSD: number | undefined,
): RoutingDecision {
  if (!maxCostUSD || maxCostUSD <= 0) {
    return { model: fallbackChain[0], index: 0 };
  }

  const pct = usage.totalCostUSD / maxCostUSD;
  const t = thresholds ?? DEFAULT_THRESHOLDS;

  // Find the appropriate tier
  let tier = 0;
  for (let i = 0; i < t.length; i++) {
    if (pct >= t[i]) {
      tier = i + 1;
    }
  }

  // Clamp to chain length
  const idx = Math.min(tier, fallbackChain.length - 1);
  return { model: fallbackChain[idx], index: idx };
}

/**
 * Checks if a downgrade occurred and returns logging info.
 */
export function shouldLogDowngrade(
  prevIndex: number,
  currentIndex: number,
): boolean {
  return currentIndex > prevIndex;
}
