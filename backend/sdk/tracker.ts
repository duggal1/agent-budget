import type { BudgetUsage, StepUsage } from './types.js';

export class UsageTracker {
  private startTime: number;
  private stepHistory: StepUsage[] = [];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUSD = 0;

  constructor() {
    this.startTime = Date.now();
  }

  static fromSnapshot(usage: BudgetUsage): UsageTracker {
    const t = new UsageTracker();
    t.stepHistory = usage.stepHistory;
    t.totalInputTokens = usage.totalInputTokens;
    t.totalOutputTokens = usage.totalOutputTokens;
    t.totalCostUSD = usage.totalCostUSD;
    t.startTime = Date.now() - usage.elapsedMs;
    return t;
  }

  record(step: StepUsage): void {
    this.stepHistory.push(step);
    this.totalInputTokens += step.inputTokens;
    this.totalOutputTokens += step.outputTokens;
    this.totalCostUSD += step.costUSD;
  }

  snapshot(): BudgetUsage {
    return {
      steps: this.stepHistory.length,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCostUSD: this.totalCostUSD,
      elapsedMs: Date.now() - this.startTime,
      stepHistory: [...this.stepHistory],
    };
  }

  stepCount(): number {
    return this.stepHistory.length;
  }

  reset(): void {
    this.stepHistory = [];
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCostUSD = 0;
  }

  rollback(): StepUsage | null {
    const last = this.stepHistory.pop();
    if (!last) return null;
    this.totalInputTokens -= last.inputTokens;
    this.totalOutputTokens -= last.outputTokens;
    this.totalCostUSD -= last.costUSD;
    return last;
  }
}
