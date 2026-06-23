import { EventEmitter } from 'node:events';
import type { BudgetExceededError, ExceededReason } from './types.js';

// ─── Event types (discriminated union) ───────────────────────────────────────

export type AgentBudgetEvent =
  | { type: 'step:start';         stepIndex: number; model: string; estimatedCostUSD?: number }
  | { type: 'step:token';         stepIndex: number; token: string }
  | { type: 'step:end';           stepIndex: number; model: string; inputTokens: number; outputTokens: number; costUSD: number; durationMs: number }
  | { type: 'budget:warning';     reason: ExceededReason; pctConsumed: number; remaining: number }
  | { type: 'budget:exceeded';    exceeded: BudgetExceededError }
  | { type: 'model:downgraded';   from: string; to: string; pctConsumed: number }
  | { type: 'circuit:tripped';    triggerMode: 'repetition' | 'stagnation'; stepIndex: number }
  | { type: 'compress:triggered'; messagesBefore: number; messagesAfter: number; tokensFreed: number }
  | { type: 'pricing:fetched';    modelCount: number; cachedUntil: number };

// ─── Event map for type-safe emit/on ─────────────────────────────────────────

export interface AgentBudgetEventMap {
  'step:start':         AgentBudgetEvent & { type: 'step:start' };
  'step:token':         AgentBudgetEvent & { type: 'step:token' };
  'step:end':           AgentBudgetEvent & { type: 'step:end' };
  'budget:warning':     AgentBudgetEvent & { type: 'budget:warning' };
  'budget:exceeded':    AgentBudgetEvent & { type: 'budget:exceeded' };
  'model:downgraded':   AgentBudgetEvent & { type: 'model:downgraded' };
  'circuit:tripped':    AgentBudgetEvent & { type: 'circuit:tripped' };
  'compress:triggered': AgentBudgetEvent & { type: 'compress:triggered' };
  'pricing:fetched':    AgentBudgetEvent & { type: 'pricing:fetched' };
}

// ─── Typed emitter ───────────────────────────────────────────────────────────

export class AgentEventEmitter {
  private readonly emitter = new EventEmitter();

  constructor(private readonly onEvent?: (event: AgentBudgetEvent) => void) {
    this.emitter.setMaxListeners(50);
  }

  emit(event: AgentBudgetEvent): void {
    this.emitter.emit(event.type, event);
    this.onEvent?.(event);
  }

  on<K extends keyof AgentBudgetEventMap>(
    type: K,
    handler: (event: AgentBudgetEventMap[K]) => void
  ): this {
    this.emitter.on(type, handler as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof AgentBudgetEventMap>(
    type: K,
    handler: (event: AgentBudgetEventMap[K]) => void
  ): this {
    this.emitter.off(type, handler as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

// ─── Warning threshold checker ───────────────────────────────────────────────

export class WarningChecker {
  private firedMetrics = new Set<string>();

  reset(): void {
    this.firedMetrics.clear();
  }

  check(
    usage: { totalCostUSD: number; totalInputTokens: number; totalOutputTokens: number; steps: number },
    limits: {
      maxCostUSD?: number;
      maxInputTokens?: number;
      maxOutputTokens?: number;
      maxTotalTokens?: number;
      maxSteps?: number;
    },
    warnPct: number,
    emit: (event: AgentBudgetEvent) => void,
  ): void {
    const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;

    const metrics: Array<{ key: string; reason: ExceededReason; limit: number | undefined; actual: number }> = [
      { key: 'cost',         reason: 'cost',         limit: limits.maxCostUSD,      actual: usage.totalCostUSD },
      { key: 'steps',        reason: 'steps',        limit: limits.maxSteps,        actual: usage.steps },
      { key: 'totalTokens',  reason: 'totalTokens',  limit: limits.maxTotalTokens,  actual: totalTokens },
      { key: 'inputTokens',  reason: 'inputTokens',  limit: limits.maxInputTokens,  actual: usage.totalInputTokens },
      { key: 'outputTokens', reason: 'outputTokens', limit: limits.maxOutputTokens, actual: usage.totalOutputTokens },
    ];

    for (const { key, reason, limit, actual } of metrics) {
      if (limit === undefined) continue;
      const pctConsumed = actual / limit;
      if (pctConsumed >= warnPct && !this.firedMetrics.has(key)) {
        this.firedMetrics.add(key);
        emit({
          type: 'budget:warning',
          reason,
          pctConsumed,
          remaining: limit - actual,
        });
      }
    }
  }
}
