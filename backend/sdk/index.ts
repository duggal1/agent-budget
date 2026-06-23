import type {
  BudgetOptions,
  BudgetUsage,
  StepRequest,
  OpenRouterResponse,
  OpenRouterMessage,
  ExceededStrategy,
  CheckpointData,
} from './types.js';
import type { AgentBudgetEvent } from './events.js';
import { CheckpointManager } from './checkpoint.js';
import { UsageTracker } from './tracker.js';
import { getModelPricing, calculateCost, invalidatePricingCache } from './pricing.js';
import { checkLimits, BudgetError, RateLimitError } from './budget.js';
import {
  compressMessages as compressMessageHistory,
  estimateMessagesTokens,
} from './compressor.js';
import { estimateStepCost } from './estimator.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { resolveModel, shouldLogDowngrade } from './router.js';
import { AgentEventEmitter, WarningChecker } from './events.js';

const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── AgentBudget ─────────────────────────────────────────────────────────────

export class AgentBudget {
  private readonly apiKey: string;
  private readonly limits: BudgetOptions['limits'];
  private readonly onExceeded: ExceededStrategy;
  private readonly cacheTTL: number;
  private readonly siteUrl?: string;
  private readonly appTitle?: string;
  private readonly autoCompress?: BudgetOptions['autoCompress'];
  private readonly adaptiveRouting?: BudgetOptions['adaptiveRouting'];
  private currentModelIndex = 0;
  private tracker: UsageTracker;
  private readonly circuitBreaker: CircuitBreaker | null;
  private readonly checkpointManager: CheckpointManager | null;
  private readonly emitter: AgentEventEmitter;
  private readonly warningChecker = new WarningChecker();
  private readonly warningThreshold: number;

  constructor(options: BudgetOptions) {
    const l = options.limits;
    if (l.maxCostUSD !== undefined && l.maxCostUSD < 0) throw new Error('[agent-budget] maxCostUSD must be >= 0');
    if (l.maxSteps !== undefined && l.maxSteps < 0) throw new Error('[agent-budget] maxSteps must be >= 0');
    if (l.maxTotalTokens !== undefined && l.maxTotalTokens < 0) throw new Error('[agent-budget] maxTotalTokens must be >= 0');
    if (l.maxInputTokens !== undefined && l.maxInputTokens < 0) throw new Error('[agent-budget] maxInputTokens must be >= 0');
    if (l.maxOutputTokens !== undefined && l.maxOutputTokens < 0) throw new Error('[agent-budget] maxOutputTokens must be >= 0');
    if (l.maxWallTimeMs !== undefined && l.maxWallTimeMs < 0) throw new Error('[agent-budget] maxWallTimeMs must be >= 0');

    this.apiKey     = options.apiKey;
    this.limits     = l;
    this.onExceeded = options.onExceeded ?? 'abort';
    this.cacheTTL   = options.pricingCacheTTLMs ?? DEFAULT_CACHE_TTL;
    this.siteUrl    = options.siteUrl;
    this.appTitle   = options.appTitle;
    this.autoCompress = options.autoCompress;
    this.adaptiveRouting = options.adaptiveRouting;
    this.tracker    = new UsageTracker();
    this.circuitBreaker = options.circuitBreaker
      ? new CircuitBreaker(options.circuitBreaker)
      : null;
    this.checkpointManager = options.checkpoint?.enabled
      ? new CheckpointManager({ path: options.checkpoint.path })
      : null;
    this.emitter = new AgentEventEmitter(options.onEvent);
    this.warningThreshold = options.warningThreshold ?? 0.75;
  }

  /**
   * Execute one agent step through OpenRouter.
   * Checks budget limits before AND after the API call.
   * Throws BudgetError if any limit is exceeded.
   */
  async step(request: StepRequest): Promise<OpenRouterResponse> {
    const stepIndex = this.tracker.stepCount();

    const stepStart = Date.now();

    // ── Adaptive model routing: resolve model from fallback chain ────────────
    // Runs BEFORE pre-flight checks so that fallbackChainExhausted fires
    // instead of a generic cost error when on the last tier.
    if (this.adaptiveRouting) {
      const { fallbackChain, thresholds } = this.adaptiveRouting;
      const usage = this.tracker.snapshot();
      const decision = resolveModel(fallbackChain, thresholds, usage, this.limits.maxCostUSD);

      const prevIndex = this.currentModelIndex;
      this.currentModelIndex = decision.index;

      // Override the request model with the router's decision
      request.model = decision.model;

      // Check if chain is exhausted and budget is critically over
      if (decision.index >= fallbackChain.length - 1) {
        const pct = this.limits.maxCostUSD ? usage.totalCostUSD / this.limits.maxCostUSD : 1;
        if (pct >= 1) {
          const exceeded = {
            reason: 'fallbackChainExhausted' as const,
            limit: this.limits.maxCostUSD ?? 0,
            actual: usage.totalCostUSD,
            usage,
          };

          this.emitter.emit({ type: 'budget:exceeded', exceeded });

          if (typeof this.onExceeded === 'function') {
            this.onExceeded(usage);
          }

          throw new BudgetError(exceeded);
        }
      }

      // Log downgrade if moving to a cheaper tier
      if (shouldLogDowngrade(prevIndex, decision.index)) {
        const pct = this.limits.maxCostUSD
          ? usage.totalCostUSD / this.limits.maxCostUSD
          : 0;
        console.log(
          `[agent-budget] Downgrading model: ${fallbackChain[prevIndex]} → ${decision.model} (budget ${(pct * 100).toFixed(1)}% consumed)`,
        );
        this.emitter.emit({
          type: 'model:downgraded',
          from: fallbackChain[prevIndex],
          to: decision.model,
          pctConsumed: pct,
        });
      }
    }

    // ── Pre-flight: check limits before burning tokens ────────────────────────
    // Runs AFTER routing so fallbackChainExhausted takes priority over generic cost.
    this._checkOrThrow(this.tracker.snapshot());

    // ── Fetch live pricing for this model ─────────────────────────────────────
    const pricing = await getModelPricing(
      request.model,
      this.apiKey,
      this.cacheTTL,
      (modelCount, cachedUntil) => {
        this.emitter.emit({ type: 'pricing:fetched', modelCount, cachedUntil });
      },
    );

    // ── Pre-flight cost estimation ────────────────────────────────────────────
    if (this.limits.preflightCheck !== false && this.limits.maxCostUSD !== undefined) {
      const estimate = estimateStepCost(
        request,
        pricing,
        this.limits.preflightOutputTokenEstimate ?? 512,
      );
      const usage = this.tracker.snapshot();
      const remainingBudget = this.limits.maxCostUSD - usage.totalCostUSD;

      if (estimate.estimatedCostUSD > remainingBudget) {
        const exceeded = {
          reason: 'preflightCostEstimate' as const,
          limit: this.limits.maxCostUSD,
          actual: usage.totalCostUSD,
          usage,
          remainingBudget,
          estimatedCost: estimate.estimatedCostUSD,
        };

        this.emitter.emit({ type: 'budget:exceeded', exceeded });

        if (typeof this.onExceeded === 'function') {
          this.onExceeded(usage);
        }

        throw new BudgetError(exceeded);
      }
    }

    // ── Auto-compress messages if approaching token threshold ────────────────
    if (this.autoCompress) {
      const estimatedTokens = estimateMessagesTokens(request.messages);
      if (estimatedTokens > this.autoCompress.thresholdTokens) {
        const messagesBefore = request.messages.length;
        request.messages = await compressMessageHistory(
          request.messages,
          this.apiKey,
          this.autoCompress.keepLastN ?? 4,
        );
        const messagesAfter = request.messages.length;
        this.emitter.emit({
          type: 'compress:triggered',
          messagesBefore,
          messagesAfter,
          tokensFreed: estimatedTokens - estimateMessagesTokens(request.messages),
        });
      }
    }

    // ── Emit step:start before API call ─────────────────────────────────────
    this.emitter.emit({
      type: 'step:start',
      stepIndex,
      model: request.model,
    });

    // ── Build headers ─────────────────────────────────────────────────────────
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.siteUrl)  headers['HTTP-Referer']       = this.siteUrl;
    if (this.appTitle) headers['X-OpenRouter-Title']  = this.appTitle;

    // ── Call OpenRouter (with 429 retry + exponential backoff) ───────────────
    let res: Response;
    const MAX_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(OPENROUTER_CHAT, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '0', 10) || 0;
        const backoff = retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 30000);
        console.warn(`[agent-budget] Rate limited (429). Retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }

      break;
    }

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '0', 10) || 0;
        throw new RateLimitError(429, retryAfter,
          `[agent-budget] Rate limit exceeded after ${MAX_RETRIES} retries: ${body}`);
      }
      throw new Error(`[agent-budget] OpenRouter error ${res.status}: ${body}`);
    }

    const response = (await res.json()) as OpenRouterResponse;
    const durationMs = Date.now() - stepStart;

    // ── Record this step ──────────────────────────────────────────────────────
    const inputTokens  = response.usage?.prompt_tokens     ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
    const costUSD      = calculateCost(pricing, inputTokens, outputTokens);
    const outputContent = response.choices?.[0]?.message?.content ?? '';

    this.tracker.record({
      stepIndex: this.tracker.stepCount(),
      model: request.model,
      inputTokens,
      outputTokens,
      costUSD,
      durationMs,
      outputContent,
    });

    // ── Emit step:end ───────────────────────────────────────────────────────
    this.emitter.emit({
      type: 'step:end',
      stepIndex,
      model: request.model,
      inputTokens,
      outputTokens,
      costUSD,
      durationMs,
    });

    // ── Circuit breaker: check for repetition or stagnation ──────────────────
    if (this.circuitBreaker) {
      const trip = this.circuitBreaker.check(this.tracker.snapshot());
      if (trip) {
        const usage = this.tracker.snapshot();
        const exceeded = {
          reason: 'circuitBreaker' as const,
          limit: 0,
          actual: 0,
          usage,
          triggerMode: trip.triggerMode,
          windowSize: trip.windowSize,
          similarity: trip.similarity,
        };

        this.emitter.emit({
          type: 'circuit:tripped',
          triggerMode: trip.triggerMode,
          stepIndex,
        });
        this.emitter.emit({ type: 'budget:exceeded', exceeded });

        if (typeof this.onExceeded === 'function') {
          this.onExceeded(usage);
        }

        throw new BudgetError(exceeded);
      }
    }

    // ── Checkpoint: write after step succeeds but before post-step budget check ─
    if (this.checkpointManager) {
      const responseMessage = response.choices?.[0]?.message;
      const checkpointMessages = responseMessage
        ? [...request.messages, responseMessage]
        : request.messages;
      await this.checkpointManager.save(
        checkpointMessages,
        this.tracker.snapshot(),
        request.model,
        this.tracker.stepCount(),
      );
    }

    // ── Post-step: check all limits including updated cost + token totals ──────
    this._checkOrThrow(this.tracker.snapshot());

    return response;
  }

  /**
   * Current accumulated usage. Safe to call at any time.
   */
  getUsage(): BudgetUsage {
    return this.tracker.snapshot();
  }

  /**
   * Prints a single summary table to console. Returns the same usage snapshot.
   */
  summary(): BudgetUsage {
    const u = this.tracker.snapshot();
    const models = [...new Set(u.stepHistory.map(s => s.model))];
    const costPerStep = u.steps > 0 ? u.totalCostUSD / u.steps : 0;
    const durSec = (u.elapsedMs / 1000).toFixed(1);

    console.log('┌──────────────────────────────────────────────┐');
    console.log('│  agent-budget summary                        │');
    console.log('├──────────────────────────────────────────────┤');
    console.log(`│  Steps:        ${String(u.steps).padStart(10)}                     │`);
    console.log(`│  Cost:         $${u.totalCostUSD.toFixed(6).padStart(10)}                     │`);
    console.log(`│  Cost/step:    $${costPerStep.toFixed(6).padStart(10)}                     │`);
    console.log(`│  Input tokens: ${String(u.totalInputTokens).padStart(10)}                     │`);
    console.log(`│  Output tokens:${String(u.totalOutputTokens).padStart(10)}                     │`);
    console.log(`│  Duration:     ${durSec.padStart(7)}s                      │`);
    console.log(`│  Model:        ${models.join(', ').slice(0, 30).padEnd(30)} │`);
    console.log('└──────────────────────────────────────────────┘');

    return u;
  }

  /**
   * Subscribe to a specific event type.
   */
  on<K extends keyof import('./events.js').AgentBudgetEventMap>(
    type: K,
    handler: (event: import('./events.js').AgentBudgetEventMap[K]) => void,
  ): this {
    this.emitter.on(type, handler as never);
    return this;
  }

  /**
   * Unsubscribe from a specific event type.
   */
  off<K extends keyof import('./events.js').AgentBudgetEventMap>(
    type: K,
    handler: (event: import('./events.js').AgentBudgetEventMap[K]) => void,
  ): this {
    this.emitter.off(type, handler as never);
    return this;
  }

  /**
   * Resets all usage counters. Does NOT reset pricing cache.
   */
  reset(): void {
    this.tracker.reset();
    this.warningChecker.reset();
  }

  /**
   * Force-refresh pricing on next step. Useful for long-running agents.
   */
  refreshPricing(): void {
    invalidatePricingCache();
  }

  /**
   * Returns the model that would be used by the adaptive router right now,
   * or the default model from the last step request if routing is not configured.
   */
  getCurrentModel(): string | undefined {
    if (!this.adaptiveRouting) return undefined;
    return this.adaptiveRouting.fallbackChain[this.currentModelIndex];
  }

  /**
   * Manually record a step into the tracker.
   * Useful for replaying checkpoints or simulating usage in tests.
   */
  recordStep(usage: { inputTokens: number; outputTokens: number; costUSD: number }): void {
    this.tracker.record({
      stepIndex: this.tracker.stepCount(),
      model: this.getCurrentModel() ?? 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUSD: usage.costUSD,
      durationMs: 0,
    });
  }

  /**
   * Manually compress a message array. Useful outside of the step() flow.
   * Preserves the system message (if any) and the last `keepLastN` messages.
   * Everything in between is summarized via an LLM call.
   */
  async compressMessages(
    messages: OpenRouterMessage[],
    keepLastN?: number,
  ): Promise<OpenRouterMessage[]> {
    return compressMessageHistory(
      messages,
      this.apiKey,
      keepLastN ?? this.autoCompress?.keepLastN ?? 4,
    );
  }

  /**
   * Delete the checkpoint file. Call after the agent loop completes successfully.
   */
  async clearCheckpoint(): Promise<void> {
    await this.checkpointManager?.clear();
  }

  /**
   * Load an existing checkpoint. Returns null if none exists.
   */
  async loadCheckpoint(): Promise<CheckpointData | null> {
    return this.checkpointManager?.load() ?? null;
  }

  /**
   * Resume from a checkpoint. Constructs a new AgentBudget with tracker state
   * pre-loaded so budget accounting continues from where it left off.
   * Throws if no checkpoint file exists.
   */
  static async resume(options: BudgetOptions, checkpointPath?: string): Promise<AgentBudget> {
    const path = options.checkpoint?.path ?? checkpointPath ?? './.agent-checkpoint.json';
    const manager = new CheckpointManager({ path });
    const data = await manager.load();
    if (!data) {
      throw new Error(`[agent-budget] No checkpoint found at ${path}`);
    }
    const agent = new AgentBudget(options);
    agent.tracker = UsageTracker.fromSnapshot(data.usage);
    return agent;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private _checkOrThrow(usage: BudgetUsage): void {
    const exceeded = checkLimits(usage, this.limits);
    if (exceeded) {
      this.emitter.emit({ type: 'budget:exceeded', exceeded });

      if (typeof this.onExceeded === 'function') {
        this.onExceeded(usage);
      }

      throw new BudgetError(exceeded);
    }

    this.warningChecker.check(usage, this.limits, this.warningThreshold, (event) => {
      this.emitter.emit(event);
    });
  }
}

// ─── Convenience factory ─────────────────────────────────────────────────────

export function createAgentBudget(options: BudgetOptions): AgentBudget {
  return new AgentBudget(options);
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { BudgetError, RateLimitError } from './budget.js';
export { getModelPricing, calculateCost, invalidatePricingCache, setModelPricing } from './pricing.js';
export { estimateStepCost } from './estimator.js';
export { CircuitBreaker } from './circuit-breaker.js';
export { resolveModel } from './router.js';
export type { RoutingDecision } from './router.js';
export type { CostEstimate } from './estimator.js';
export type { CircuitBreakerConfig, CircuitBreakerTrip } from './circuit-breaker.js';
export { CheckpointManager } from './checkpoint.js';
export { compressMessages, estimateMessagesTokens } from './compressor.js';
export { AgentEventEmitter } from './events.js';
export type { AgentBudgetEvent, AgentBudgetEventMap } from './events.js';
export type { CheckpointData } from './types.js';
export type {
  BudgetOptions,
  BudgetLimits,
  BudgetUsage,
  StepUsage,
  StepRequest,
  OpenRouterResponse,
  OpenRouterMessage,
  BudgetExceededError,
  ExceededReason,
  ExceededStrategy,
  ModelPricing,
} from './types.js';
