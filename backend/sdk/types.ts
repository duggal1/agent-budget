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
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface StepRequest {
  model: string;
  messages: OpenRouterMessage[];
  tools?: unknown[];
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    message: OpenRouterMessage;
    finish_reason: string;
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
