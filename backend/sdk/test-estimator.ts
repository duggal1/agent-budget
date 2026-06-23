/**
 * Test: Predictive Pre-Flight Cost Estimation
 *
 * 1. Agent with absurdly low budget → pre-flight blocks before API call
 * 2. Agent with sane budget → step completes successfully
 */

import { AgentBudget, BudgetError } from './index.js';
import type { StepRequest } from './types.js';

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error('Set OPENROUTER_API_KEY env var before running this test.');
  process.exit(1);
}

const MODEL = 'cohere/north-mini-code:free';
// Use a paid model for the pre-flight block test (free models = $0 cost estimate)
const PAID_MODEL = 'openai/gpt-4o-mini';

// ~2000 words of dummy text to create a large prompt
const LOREM = Array.from({ length: 40 }, (_, i) =>
  `Sentence ${i + 1}: The quick brown fox jumps over the lazy dog near the riverbank where the water flows gently downstream past ancient stones covered in moss and lichen, creating a serene landscape that stretches toward the horizon beneath a sky painted with hues of amber and rose as the sun descends behind distant mountain peaks casting long shadows across the valley floor. `
).join('');

// ─── Test 1: Pre-flight blocks before API call ───────────────────────────────

async function testPreflightBlocks() {
  console.log('=== TEST 1: Pre-flight blocks on absurdly low budget ===\n');

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxCostUSD: 0.000001,
      preflightCheck: true,
    },
  });

  const request: StepRequest = {
    model: PAID_MODEL,
    messages: [
      { role: 'user', content: LOREM },
    ],
  };

  try {
    await agent.step(request);
    console.error('FAIL: Expected BudgetError but step completed.');
    process.exit(1);
  } catch (err) {
    if (err instanceof BudgetError && err.exceeded.reason === 'preflightCostEstimate') {
      console.log('PASS: BudgetError thrown with reason "preflightCostEstimate"');
      console.log(`  Remaining budget: $${err.exceeded.remainingBudget?.toFixed(8)}`);
      console.log(`  Estimated cost:   $${err.exceeded.estimatedCost?.toFixed(8)}`);
      console.log(`  Message: ${err.message}\n`);
    } else {
      console.error('FAIL: Wrong error type or reason:', err);
      process.exit(1);
    }
  }
}

// ─── Test 2: Sane budget → step completes ────────────────────────────────────

async function testSaneBudget() {
  console.log('=== TEST 2: Sane budget → step succeeds ===\n');

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxCostUSD: 1.0,
      preflightCheck: true,
    },
  });

  const request: StepRequest = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Reply with the word OK and nothing else.' },
    ],
  };

  try {
    const response = await agent.step(request);
    const usage = agent.getUsage();
    console.log('PASS: Step completed successfully');
    console.log(`  Model: ${response.model}`);
    console.log(`  Response: ${response.choices[0]?.message?.content?.trim()}`);
    console.log(`  Cost: $${usage.totalCostUSD.toFixed(8)}`);
    console.log(`  Steps: ${usage.steps}\n`);
  } catch (err) {
    console.error('FAIL: Step threw unexpected error:', err);
    process.exit(1);
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  await testPreflightBlocks();
  await testSaneBudget();
  console.log('All pre-flight estimator tests passed.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
