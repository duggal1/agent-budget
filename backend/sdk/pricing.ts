import type { ModelPricing } from './types.js';

// ─── Internal types ───────────────────────────────────────────────────────────

interface OpenRouterModelRaw {
  id: string;
  pricing?: {
    prompt: string;      // USD per token, as string e.g. "0.000003"
    completion: string;
  };
}

interface PricingCache {
  data: Map<string, ModelPricing>;
  fetchedAt: number;
}

// ─── Module-level cache (shared across all AgentBudget instances) ─────────────

let cache: PricingCache | null = null;

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * Returns pricing for a model. Fetches all model prices from OpenRouter once,
 * then caches for `cacheTTLMs`. Unknown models return zero-cost (with a warning).
 */
export async function getModelPricing(
  modelId: string,
  apiKey: string,
  cacheTTLMs: number,
  onFreshFetch?: (modelCount: number, cachedUntil: number) => void,
): Promise<ModelPricing> {
  const now = Date.now();

  if (!cache || now - cache.fetchedAt > cacheTTLMs) {
    cache = await fetchAllPricing(apiKey, now);
    onFreshFetch?.(cache.data.size, cache.fetchedAt + cacheTTLMs);
  }

  const pricing = cache.data.get(modelId);

  if (!pricing) {
    console.warn(
      `[agent-budget] No pricing data for model "${modelId}". ` +
      `Cost tracking will be 0 for this model. ` +
      `Check https://openrouter.ai/models for the exact model slug.`
    );
    return { promptPerToken: 0, completionPerToken: 0 };
  }

  return pricing;
}

/**
 * Computes USD cost from pricing + token counts.
 */
export function calculateCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number
): number {
  return pricing.promptPerToken * inputTokens + pricing.completionPerToken * outputTokens;
}

/**
 * Force-invalidates the pricing cache. Call this if you need fresh prices mid-run.
 */
export function invalidatePricingCache(): void {
  cache = null;
}

/**
 * Override pricing for a specific model. Used for testing with simulated costs.
 * Does NOT persist across cache invalidations.
 */
export function setModelPricing(modelId: string, pricing: ModelPricing): void {
  if (!cache) {
    cache = { data: new Map(), fetchedAt: Date.now() };
  }
  cache.data.set(modelId, pricing);
}

// ─── Private ──────────────────────────────────────────────────────────────────

async function fetchAllPricing(apiKey: string, fetchedAt: number): Promise<PricingCache> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(
      `[agent-budget] Failed to fetch OpenRouter model list: ${res.status} ${res.statusText}`
    );
  }

  const json = (await res.json()) as { data: OpenRouterModelRaw[] };
  const data = new Map<string, ModelPricing>();

  for (const model of json.data) {
    if (!model.pricing) continue;
    const prompt = parseFloat(model.pricing.prompt);
    const completion = parseFloat(model.pricing.completion);
    if (!isNaN(prompt) && !isNaN(completion)) {
      data.set(model.id, {
        promptPerToken: prompt,
        completionPerToken: completion,
      });
    }
  }

  return { data, fetchedAt };
}
