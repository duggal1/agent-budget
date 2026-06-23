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

/**
 * An error returned by the provider inside the chat completion response.
 * This happens when OpenRouter returns HTTP 200 but `choices[0].error`
 * contains a provider-level error (e.g., 402 insufficient credits,
 * guardrail block, provider outage, etc.).
 */
export class UpstreamError extends Error {
  public readonly code: number;
  public readonly metadata?: Record<string, unknown>;
  public readonly statusCode: number;

  constructor(code: number, message: string, metadata?: Record<string, unknown>) {
    super(message ? `[agent-budget] Provider error ${code}: ${message}` : `[agent-budget] Provider error ${code}`);
    this.name = 'UpstreamError';
    this.code = code;
    this.metadata = metadata;
    // Map known OpenRouter error codes to HTTP-like status
    this.statusCode = code;
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
