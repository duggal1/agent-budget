import { AgentBudget, BudgetError } from './index.js';
import type { StepRequest } from './types.js';

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error('Set OPENROUTER_API_KEY env var before running this test.');
  process.exit(1);
}

const MODEL = 'cohere/north-mini-code:free';
const FALLBACK_CHAIN: string[] = [
  MODEL,
  MODEL,
  MODEL,
];

async function testAdaptiveRouting() {
  console.log('=== Adaptive Model Routing Test ===\n');

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxCostUSD: 10,
      preflightCheck: false,
    },
    adaptiveRouting: {
      fallbackChain: FALLBACK_CHAIN,
      thresholds: [0.3, 0.7],
    },
  });

  const request: StepRequest = {
    model: 'ignored-by-router',
    messages: [
      { role: 'user', content: 'Reply with the word OK and nothing else.' },
    ],
  };

  // ─── Step 1: Budget at 0% → should use model[0] ───────────────────────────
  console.log('--- Step 1 (0% consumed) ---');
  let model = agent.getCurrentModel();
  console.log(`  Router selected: ${model}`);
  console.log(`  Expected tier: 0 (${FALLBACK_CHAIN[0]})`);

  try {
    const response = await agent.step(request);
    console.log(`  Actual model used: ${response.model}`);
    console.log(`  Response: ${response.choices[0]?.message?.content?.trim()}\n`);
  } catch (err) {
    console.error('FAIL: Step 1 threw:', err);
    process.exit(1);
  }

  // ─── Burn budget to ~50% (past 30% threshold) ─────────────────────────────
  console.log('--- Burning budget to 50% ---');
  agent.recordStep({ inputTokens: 1000, outputTokens: 500, costUSD: 5 });
  console.log(`  Usage: $${agent.getUsage().totalCostUSD.toFixed(2)} / $10.00\n`);

  // ─── Step 2: Budget at 50% → should use model[1] ──────────────────────────
  console.log('--- Step 2 (50% consumed) ---');
  model = agent.getCurrentModel();
  console.log(`  Router selected: ${model}`);
  console.log(`  Expected tier: 1 (${FALLBACK_CHAIN[1]})`);

  try {
    const response = await agent.step(request);
    console.log(`  Actual model used: ${response.model}`);
    console.log(`  Response: ${response.choices[0]?.message?.content?.trim()}\n`);
  } catch (err) {
    console.error('FAIL: Step 2 threw:', err);
    process.exit(1);
  }

  // ─── Burn budget to ~80% (past 70% threshold) ─────────────────────────────
  console.log('--- Burning budget to 80% ---');
  agent.recordStep({ inputTokens: 1000, outputTokens: 500, costUSD: 3 });
  console.log(`  Usage: $${agent.getUsage().totalCostUSD.toFixed(2)} / $10.00\n`);

  // ─── Step 3: Budget at 80% → should use model[2] (cheapest) ───────────────
  console.log('--- Step 3 (80% consumed) ---');
  model = agent.getCurrentModel();
  console.log(`  Router selected: ${model}`);
  console.log(`  Expected tier: 2 (${FALLBACK_CHAIN[2]})`);

  try {
    const response = await agent.step(request);
    console.log(`  Actual model used: ${response.model}`);
    console.log(`  Response: ${response.choices[0]?.message?.content?.trim()}\n`);
  } catch (err) {
    console.error('FAIL: Step 3 threw:', err);
    process.exit(1);
  }

  console.log('PASS: All routing steps completed successfully.');
  console.log(`  Total steps: ${agent.getUsage().steps}`);
}

// ─── Test: fallbackChainExhausted when over budget on last tier ──────────────

async function testFallbackChainExhausted() {
  console.log('\n=== Fallback Chain Exhausted Test ===\n');

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxCostUSD: 0.00001,
      preflightCheck: false,
    },
    adaptiveRouting: {
      fallbackChain: [MODEL],
    },
  });

  // Burn budget beyond maxCostUSD
  agent.recordStep({ inputTokens: 1000, outputTokens: 500, costUSD: 0.00002 });

  const request: StepRequest = {
    model: 'ignored',
    messages: [
      { role: 'user', content: 'Reply with OK.' },
    ],
  };

  try {
    await agent.step(request);
    console.error('FAIL: Expected BudgetError but step completed.');
    process.exit(1);
  } catch (err) {
    if (err instanceof BudgetError && err.exceeded.reason === 'fallbackChainExhausted') {
      console.log('PASS: BudgetError thrown with reason "fallbackChainExhausted"');
      console.log(`  Actual spent: $${err.exceeded.actual.toFixed(8)}`);
      console.log(`  Limit: $${err.exceeded.limit}\n`);
    } else {
      console.error('FAIL: Wrong error type or reason:', err);
      process.exit(1);
    }
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  await testAdaptiveRouting();
  await testFallbackChainExhausted();
  console.log('All adaptive routing tests passed.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
