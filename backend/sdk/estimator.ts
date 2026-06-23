import type { StepRequest, ModelPricing } from './types.js';
import { calculateCost } from './pricing.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CostEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUSD: number;
  confidence: 'approximate';
}

// ─── Character-based token estimation ─────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

function estimateMessageTokens(messages: StepRequest['messages']): number {
  let chars = 0;
  for (const msg of messages) {
    if (msg.content) chars += msg.content.length;
    if (msg.tool_call_id) chars += msg.tool_call_id.length;
    if (msg.name) chars += msg.name.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function estimateToolTokens(tools: unknown[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Estimates the cost of a step BEFORE making the API call.
 * Uses character-based approximation (4 chars ≈ 1 token).
 */
export function estimateStepCost(
  request: StepRequest,
  pricing: ModelPricing,
  defaultOutputTokens: number = 512,
): CostEstimate {
  const messageTokens = estimateMessageTokens(request.messages);
  const toolTokens = estimateToolTokens(request.tools);
  const estimatedInputTokens = messageTokens + toolTokens;

  const estimatedOutputTokens = request.max_tokens ?? defaultOutputTokens;
  const estimatedCostUSD = calculateCost(pricing, estimatedInputTokens, estimatedOutputTokens);

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUSD,
    confidence: 'approximate',
  };
}
