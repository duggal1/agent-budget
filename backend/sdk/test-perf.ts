/**
 * Performance benchmark — measure SDK overhead in milliseconds.
 * Everything except the actual OpenRouter API call.
 */
import { readFileSync } from 'node:fs';
import {
  AgentBudget, BudgetError,
  getModelPricing, calculateCost, invalidatePricingCache, setModelPricing,
  CircuitBreaker, resolveModel, estimateStepCost, estimateMessagesTokens,
  compressMessages, CheckpointManager,
} from './index.js';
import type { ModelPricing, StepRequest } from './types.js';

const ENV = readFileSync(new URL('../../.env', import.meta.url), 'utf-8');
const API_KEY = ENV.match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();
if (!API_KEY) { process.exit(1); }

const MODEL = 'cohere/north-mini-code:free';
const SIMULATED: ModelPricing = { promptPerToken: 0.000003, completionPerToken: 0.000030 };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function bench(label: string, fn: () => void | Promise<void>, iterations = 1000) {
  return async () => {
    // Warmup
    for (let i = 0; i < 10; i++) await fn();

    const start = performance.now();
    for (let i = 0; i < iterations; i++) await fn();
    const elapsed = performance.now() - start;
    const perOp = elapsed / iterations;

    console.log(`  ${label.padEnd(50)} ${perOp.toFixed(3)}ms/op  (${iterations} ops in ${elapsed.toFixed(1)}ms)`);
    return perOp;
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  PERFORMANCE BENCHMARK — SDK overhead (no API calls)       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Pre-populate pricing cache
  await getModelPricing(MODEL, API_KEY!, 3_600_000);
  setModelPricing(MODEL, SIMULATED);

  const results: Array<{ label: string; ms: number }> = [];

  // ── Pure computation (no I/O) ────────────────────────────────────────────

  console.log('Pure computation (no I/O):');

  const msgs: StepRequest['messages'] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is the capital of France?' },
    { role: 'assistant', content: 'The capital of France is Paris.' },
    { role: 'user', content: 'What about Japan?' },
  ];

  results.push({ label: 'checkLimits (no exceeded)', ms: await bench('checkLimits (no exceeded)', () => {
    const { checkLimits } = require('./budget.js');
    checkLimits(
      { steps: 5, totalInputTokens: 1000, totalOutputTokens: 500, totalCostUSD: 0.01, elapsedMs: 1000, stepHistory: [] },
      { maxSteps: 10, maxCostUSD: 1.0 }
    );
  })});

  results.push({ label: 'checkLimits (exceeded)', ms: await bench('checkLimits (exceeded)', () => {
    const { checkLimits } = require('./budget.js');
    checkLimits(
      { steps: 10, totalInputTokens: 1000, totalOutputTokens: 500, totalCostUSD: 0.01, elapsedMs: 1000, stepHistory: [] },
      { maxSteps: 5, maxCostUSD: 1.0 }
    );
  })});

  results.push({ label: 'calculateCost', ms: await bench('calculateCost', () => {
    calculateCost(SIMULATED, 1500, 500);
  })});

  results.push({ label: 'estimateStepCost', ms: await bench('estimateStepCost', () => {
    estimateStepCost({ model: MODEL, messages: msgs }, SIMULATED, 512);
  })});

  results.push({ label: 'estimateMessagesTokens', ms: await bench('estimateMessagesTokens', () => {
    estimateMessagesTokens(msgs);
  })});

  results.push({ label: 'CircuitBreaker.check (no trip)', ms: await bench('CircuitBreaker.check (no trip)', () => {
    const cb = new CircuitBreaker();
    cb.check({
      steps: 5, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, elapsedMs: 0,
      stepHistory: Array.from({ length: 5 }, (_, i) => ({
        stepIndex: i, model: MODEL, inputTokens: 10, outputTokens: 5, costUSD: 0, durationMs: 100,
        outputContent: `Different output number ${i} with varying content to avoid repetition detection`,
      })),
    });
  })});

  results.push({ label: 'resolveModel (0% consumed)', ms: await bench('resolveModel (0%)', () => {
    resolveModel(['a', 'b', 'c'], [0.6, 0.85],
      { steps: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, elapsedMs: 0, stepHistory: [] },
      10);
  })});

  results.push({ label: 'resolveModel (90% consumed)', ms: await bench('resolveModel (90%)', () => {
    resolveModel(['a', 'b', 'c'], [0.6, 0.85],
      { steps: 1, totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 9, elapsedMs: 0, stepHistory: [] },
      10);
  })});

  // ── Object allocation ────────────────────────────────────────────────────

  console.log('\nObject allocation:');

  results.push({ label: 'AgentBudget constructor', ms: await bench('AgentBudget constructor', () => {
    new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 1.0 } });
  }, 100)});

  results.push({ label: 'getUsage() snapshot', ms: await bench('getUsage() snapshot', () => {
    const a = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 1.0 } });
    a.getUsage();
  }, 100)});

  results.push({ label: 'UsageTracker.record + snapshot', ms: await bench('UsageTracker.record + snapshot', () => {
    const a = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 1.0 } });
    a.recordStep({ inputTokens: 100, outputTokens: 50, costUSD: 0.001 });
    a.getUsage();
  }, 100)});

  // ── Filesystem (checkpoint) ──────────────────────────────────────────────

  console.log('\nFilesystem I/O:');

  const cpPath = '/tmp/_bench-cp.json';
  const cpManager = new CheckpointManager({ path: cpPath });

  results.push({ label: 'CheckpointManager.save', ms: await bench('Checkpoint save', async () => {
    await cpManager.save(
      [{ role: 'user', content: 'test' }],
      { steps: 1, totalInputTokens: 10, totalOutputTokens: 5, totalCostUSD: 0, elapsedMs: 100, stepHistory: [] },
      MODEL, 1,
    );
  }, 100)});

  results.push({ label: 'CheckpointManager.load', ms: await bench('Checkpoint load', async () => {
    await cpManager.load();
  }, 100)});

  results.push({ label: 'CheckpointManager.clear', ms: await bench('Checkpoint clear', async () => {
    await cpManager.clear();
  }, 100)});

  // ── Pricing (cached) ─────────────────────────────────────────────────────

  console.log('\nPricing (cache hit):');

  results.push({ label: 'getModelPricing (cache hit)', ms: await bench('getModelPricing (cache hit)', async () => {
    await getModelPricing(MODEL, API_KEY!, 3_600_000);
  }, 100)});

  // ── setModelPricing ──────────────────────────────────────────────────────

  console.log('\nPricing override:');

  results.push({ label: 'setModelPricing', ms: await bench('setModelPricing', () => {
    setModelPricing(MODEL, SIMULATED);
  }, 100)});

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log('\nSummary:');

  results.push({ label: 'summary() with 10 steps', ms: await bench('summary() 10 steps', () => {
    const a = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 20, maxCostUSD: 999 } });
    for (let i = 0; i < 10; i++) {
      a.recordStep({ inputTokens: 100, outputTokens: 50, costUSD: 0.001 });
    }
    // Suppress console output
    const orig = console.log;
    console.log = () => {};
    a.summary();
    console.log = orig;
  }, 100)});

  // ── Results table ────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  console.log('  RESULTS TABLE');
  console.log('═'.repeat(60));
  console.log(`  ${'Operation'.padEnd(50)} ${'Time'.padStart(10)}`);
  console.log('  ' + '─'.repeat(58));

  const sorted = [...results].sort((a, b) => a.ms - b.ms);
  for (const r of sorted) {
    const rating = r.ms < 0.01 ? '⚡' : r.ms < 0.1 ? '✅' : r.ms < 1 ? '⚠️' : '❌';
    console.log(`  ${rating} ${r.label.padEnd(48)} ${r.ms.toFixed(3).padStart(8)}ms`);
  }

  console.log('\n  Legend: ⚡ < 0.01ms | ✅ < 0.1ms | ⚠️ < 1ms | ❌ > 1ms');

  // ── Total SDK overhead estimate ──────────────────────────────────────────

  const overhead = sorted.reduce((sum, r) => sum + r.ms, 0);
  console.log(`\n  Total SDK overhead (all operations combined): ${overhead.toFixed(3)}ms`);
  console.log(`  This is the MINIMUM added latency per step (excluding API call).`);

  // Cleanup
  await cpManager.clear();
}

main().catch(e => { console.error(e); process.exit(1); });
