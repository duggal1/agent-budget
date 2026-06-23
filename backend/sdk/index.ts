import type {
  BudgetOptions,
  BudgetUsage,
  StepRequest,
  OpenRouterResponse,
  OpenRouterMessage,
  ExceededStrategy,
  CheckpointData,
  AgentExecutor,
  ExecutorResult,
} from './types.js';
import type { AgentBudgetEvent } from './events.js';
import { CheckpointManager } from './checkpoint.js';
import { UsageTracker } from './tracker.js';
import { getModelPricing, calculateCost, invalidatePricingCache } from './pricing.js';
import { checkLimits, BudgetError, RateLimitError, UpstreamError } from './budget.js';
import {
  compressMessages as compressMessageHistory,
  estimateMessagesTokens,
} from './compressor.js';
import { estimateStepCost } from './estimator.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { resolveModel, shouldLogDowngrade } from './router.js';
import { AgentEventEmitter, WarningChecker } from './events.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
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
  private readonly telemetry: BudgetOptions['telemetry'];
  private tracer: any = null;
  private readonly executor?: AgentExecutor;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;

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
    this.telemetry = options.telemetry;
    this.executor = options.executor;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultHeaders = options.defaultHeaders ?? {};
  }

  /**
   * Execute one agent step through OpenRouter.
   * Checks budget limits before AND after the API call.
   * Throws BudgetError if any limit is exceeded.
   */
  async step(request: StepRequest): Promise<OpenRouterResponse> {
    const stepIndex = this.tracker.stepCount();

    const stepStart = Date.now();
    this._initTracer();
    const stepSpan = this._startSpan('agent-budget.step');

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
    const pricingSpan = this._startSpan('agent-budget.pricing');
    const pricing = await getModelPricing(
      request.model,
      this.apiKey,
      this.cacheTTL,
      (modelCount, cachedUntil) => {
        this.emitter.emit({ type: 'pricing:fetched', modelCount, cachedUntil });
      },
    );
    pricingSpan?.end();

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

    // ── Execute the step (custom executor or built-in OpenRouter fetch) ──────
    let response: OpenRouterResponse;
    if (this.executor) {
      const result = await this.executor({ ...request });
      response = {
        id: '',
        model: result.model,
        choices: result.choices.map(c => ({
          message: c.message as OpenRouterMessage,
          finish_reason: c.finish_reason,
        })),
        usage: result.usage,
      };
    } else {
      response = await this._defaultFetch(request, stepIndex, pricing);
    }
    const durationMs = Date.now() - stepStart;

    // ── Record this step (before checks so circuit breaker can analyze it) ─────
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

        this.tracker.rollback();
        throw new BudgetError(exceeded);
      }
    }

    // ── Checkpoint: write after step succeeds ────────────────────────────────
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
    try {
      this._checkOrThrow(this.tracker.snapshot());
    } catch (err) {
      // Roll back the tracker so the consumer can retry without stale data.
      // The actual API spend is included in the error for transparency.
      this.tracker.rollback();
      throw err;
    }

    stepSpan?.end();
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
   * Returns the model that the adaptive router would use right now,
   * or undefined if adaptive routing is not configured.
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

  private _initTracer(): void {
    if (!this.telemetry?.enabled || this.tracer) return;
    try {
      const otel = require('@opentelemetry/api') as { trace: { getTracer: (name: string) => unknown } };
      this.tracer = otel.trace.getTracer('agent-budget');
    } catch {
      this.tracer = null;
    }
  }

  private _startSpan(name: string): { end: () => void } | null {
    if (!this.tracer) return null;
    try {
      const span = (this.tracer as any).startSpan(name);
      return {
        end: () => { try { span.end(); } catch {} }
      };
    } catch {
      return null;
    }
  }

  private async _readStream(
    res: Response,
    model: string,
    stepIndex: number,
    stepStart: number,
    pricing: import('./types.js').ModelPricing,
  ): Promise<import('./types.js').OpenRouterResponse> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let responseId = '';
    let responseModel = '';
    let usage: import('./types.js').OpenRouterResponse['usage'] | null = null;
    let streamError: { code: number; message: string } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data) as any;
          const choice = parsed.choices?.[0];

          // Check for streamed provider error (finish_reason: "error" + choice.error)
          if (choice?.error) {
            streamError = { code: choice.error.code, message: choice.error.message };
          }

          // Emit token for each content delta
          if (choice?.delta?.content) {
            const token: string = choice.delta.content;
            fullContent += token;
            this.emitter.emit({ type: 'step:token', stepIndex, token });
          }

          // Capture usage — it appears in the final chunk before [DONE].
          // With stream_options: { include_usage: true }, this chunk has
          // an empty choices array and a usage object.
          if (parsed.usage) {
            usage = parsed.usage;
          }

          if (parsed.id) responseId = parsed.id;
          if (parsed.model) responseModel = parsed.model;
        } catch { /* skip malformed SSE lines */ }
      }
    }

    // If a streamed error was captured, throw it so the budget layer
    // doesn't record a fake zero-cost step.
    if (streamError) {
      throw new UpstreamError(streamError.code, streamError.message);
    }

    return {
      id: responseId,
      model: responseModel || model,
      choices: [{
        message: { role: 'assistant', content: fullContent },
        finish_reason: 'stop',
      }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  private async _defaultFetch(request: StepRequest, stepIndex: number, pricing: import('./types.js').ModelPricing): Promise<OpenRouterResponse> {
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.siteUrl)  headers['HTTP-Referer']       = this.siteUrl;
    if (this.appTitle) headers['X-OpenRouter-Title']  = this.appTitle;

    // When streaming, include stream_options so usage data is returned
    // in the final chunk. Respect any user-supplied value.
    const body: Record<string, unknown> = { ...request };
    if (body.stream === true && !('stream_options' in body)) {
      body.stream_options = { include_usage: true };
    }

    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let res: Response;
    const MAX_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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
      const bodyText = await res.text();
      if (res.status === 402) {
        throw new Error(`[agent-budget] Insufficient credits (402): ${bodyText}`);
      }
      if (res.status === 502) {
        throw new Error(`[agent-budget] Provider unavailable (502): ${bodyText}`);
      }
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '0', 10) || 0;
        throw new RateLimitError(429, retryAfter,
          `[agent-budget] Rate limit exceeded after ${MAX_RETRIES} retries: ${bodyText}`);
      }
      throw new Error(`[agent-budget] API error ${res.status}: ${bodyText}`);
    }

    const response = request.stream === true
      ? await this._readStream(res, request.model, stepIndex, Date.now(), pricing)
      : (await res.json()) as OpenRouterResponse;

    // OpenRouter may return HTTP 200 with an error inside choices[0].
    // This happens when the provider rejects the request (insufficient
    // credits, guardrail, provider outage, etc.).
    const choiceError = response.choices?.[0]?.error;
    if (choiceError) {
      throw new UpstreamError(choiceError.code, choiceError.message, choiceError.metadata);
    }

    return response;
  }

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

export { BudgetError, RateLimitError, UpstreamError } from './budget.js';
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
  StreamChunk,
  TokenCallback,
  AgentExecutor,
  ExecutorResult,
} from './types.js';
