// ─── Limits ──────────────────────────────────────────────────────────────────

export interface BudgetLimits {
  maxCostUSD?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxSteps?: number;
  maxWallTimeMs?: number;
  preflightCheck?: boolean;           // default: true
  preflightOutputTokenEstimate?: number; // default: 512
}

// ─── Strategy ────────────────────────────────────────────────────────────────

export type ExceededStrategy = 'abort' | ((usage: BudgetUsage) => void);

// ─── Executor ─────────────────────────────────────────────────────────────────

export interface ExecutorResult {
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
}

/**
 * Custom API executor. Replaces the built-in OpenRouter fetch.
 * Receives the StepRequest (after adaptive routing, auto-compress, etc.) and
 * returns a normalized response. Use this to integrate any LLM provider.
 */
export type AgentExecutor = (
  request: StepRequest,
) => Promise<ExecutorResult>;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface BudgetOptions {
  apiKey: string;
  limits: BudgetLimits;
  onExceeded?: ExceededStrategy;
  pricingCacheTTLMs?: number; // default: 5 minutes
  siteUrl?: string;           // optional OpenRouter attribution
  appTitle?: string;          // optional OpenRouter attribution
  autoCompress?: {
    thresholdTokens: number;  // estimated token count that triggers compression
    keepLastN?: number;       // number of recent messages to preserve (default 4)
  };
  circuitBreaker?: {
    repetitionWindow?: number;    // consecutive steps to check for repetition (default 3)
    repetitionThreshold?: number; // Jaccard similarity threshold to trip (default 0.85)
    stagnationWindow?: number;    // consecutive steps to check for stagnation (default 4)
    stagnationMinLength?: number; // minimum output length in chars (default 50)
  };
  adaptiveRouting?: {
    fallbackChain: string[];  // ordered model IDs from most preferred to cheapest
    thresholds?: number[];    // e.g. [0.6, 0.85] — must be length fallbackChain.length - 1
  };
  checkpoint?: {
    path?: string;    // default './.agent-checkpoint.json'
    enabled?: boolean; // default false
  };
  onEvent?: (event: import('./events.js').AgentBudgetEvent) => void;
  warningThreshold?: number;      // fraction of any limit that triggers budget:warning (default 0.75)
  telemetry?: {
    enabled: boolean;             // enable OpenTelemetry spans
    tracer?: unknown;             // optional pre-configured tracer
  };
  executor?: AgentExecutor;       // custom API executor (replaces built-in OpenRouter fetch)
  baseUrl?: string;               // API base URL (default: https://openrouter.ai/api/v1)
  defaultHeaders?: Record<string, string>; // custom HTTP headers for built-in fetch
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

export interface ModelPricing {
  promptPerToken: number;     // USD per input token
  completionPerToken: number; // USD per output token
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export interface StepUsage {
  stepIndex: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  durationMs: number;
  outputContent?: string;
}

export interface BudgetUsage {
  steps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  elapsedMs: number;
  stepHistory: StepUsage[];
}

// ─── Budget exceeded ─────────────────────────────────────────────────────────

export type ExceededReason =
  | 'cost'
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'steps'
  | 'wallTime'
  | 'preflightCostEstimate'
  | 'circuitBreaker'
  | 'fallbackChainExhausted';

export interface BudgetExceededError {
  reason: ExceededReason;
  limit: number;
  actual: number;
  usage: BudgetUsage;
  remainingBudget?: number;
  triggerMode?: 'repetition' | 'stagnation';
  windowSize?: number;
  similarity?: number;
  estimatedCost?: number;
}

// ─── OpenRouter shapes ───────────────────────────────────────────────────────

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  name?: string;
}

export interface StepRequest {
  model: string;         // Any OpenRouter model slug: 'openai/gpt-4o', 'anthropic/claude-sonnet', etc.
  messages: OpenRouterMessage[];
  tools?: unknown[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface StreamChunk {
  type: 'token' | 'done' | 'error';
  token?: string;
  response?: OpenRouterResponse;
  error?: string;
}

export type TokenCallback = (token: string) => void;

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    message: OpenRouterMessage;
    finish_reason: string;
    native_finish_reason?: string | null;
    error?: {
      code: number;
      message: string;
      metadata?: Record<string, unknown>;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── Checkpoint ──────────────────────────────────────────────────────────────

export interface CheckpointData {
  checkpointVersion: string;
  messages: OpenRouterMessage[];
  usage: BudgetUsage;
  model: string;
  resumeFromStep: number;
  createdAt: string;
}
