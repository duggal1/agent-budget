import type { BudgetLimits, BudgetUsage, BudgetExceededError, ExceededReason } from './types.js';

// ─── Error ────────────────────────────────────────────────────────────────────

export class BudgetError extends Error {
  public readonly exceeded: BudgetExceededError;

  constructor(exceeded: BudgetExceededError) {
    const extra = exceeded.reason === 'preflightCostEstimate'
      ? ` — remaining: $${exceeded.remainingBudget?.toFixed(8)}, estimated: $${exceeded.estimatedCost?.toFixed(8)}`
      : '';
    super(
      `[agent-budget] Limit exceeded — reason: ${exceeded.reason}, ` +
      `limit: ${exceeded.limit}, actual: ${exceeded.actual.toFixed(6)}${extra}`
    );
    this.name = 'BudgetError';
    this.exceeded = exceeded;
  }
}

export class RateLimitError extends Error {
  public readonly retryAfter: number;
  public readonly statusCode: number;

  constructor(statusCode: number, retryAfter: number, message: string) {
    super(message);
    this.name = 'RateLimitError';
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

// ─── Checker ─────────────────────────────────────────────────────────────────

/**
 * Returns the first exceeded limit, or null if within budget.
 * Order of precedence: cost → steps → totalTokens → inputTokens → outputTokens → wallTime
 */
export function checkLimits(
  usage: BudgetUsage,
  limits: BudgetLimits
): BudgetExceededError | null {
  const checks: Array<{
    reason: ExceededReason;
    limit: number | undefined;
    actual: number;
  }> = [
    { reason: 'cost',         limit: limits.maxCostUSD,      actual: usage.totalCostUSD },
    { reason: 'steps',        limit: limits.maxSteps,        actual: usage.steps },
    { reason: 'totalTokens',  limit: limits.maxTotalTokens,  actual: usage.totalInputTokens + usage.totalOutputTokens },
    { reason: 'inputTokens',  limit: limits.maxInputTokens,  actual: usage.totalInputTokens },
    { reason: 'outputTokens', limit: limits.maxOutputTokens, actual: usage.totalOutputTokens },
    { reason: 'wallTime',     limit: limits.maxWallTimeMs,   actual: usage.elapsedMs },
  ];

  for (const { reason, limit, actual } of checks) {
    if (limit !== undefined && actual > limit) {
      return { reason, limit, actual, usage };
    }
  }

  return null;
}
