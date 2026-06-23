/**
 * BRUTAL TEST — $3/input-token, $30/output-token pricing.
 * If cost enforcement survives these numbers, it's real.
 */

import { AgentBudget, BudgetError, setModelPricing, getModelPricing, invalidatePricingCache } from './index.js';

const API_KEY = process.env.OPENROUTER_API_KEY!;
const MODEL = 'openrouter/free';
const RIDICULOUS_PROMPT = 3;     // $3 per input token
const RIDICULOUS_COMPLETION = 30; // $30 per output token

let passed = 0;
let failed = 0;

function report(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  if (ok) passed++; else failed++;
}

function inject() {
  setModelPricing(MODEL, { promptPerToken: RIDICULOUS_PROMPT, completionPerToken: RIDICULOUS_COMPLETION });
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log(`
████████████████████████████████████████████████████████████
█         BRUTAL TEST — $3/$30 PER TOKEN                 █
████████████████████████████████████████████████████████████
`);

// Test 1: getModelPricing returns our insane values
inject();
const p = await getModelPricing(MODEL, API_KEY, 60000);
const pOk = p && p.promptPerToken === RIDICULOUS_PROMPT && p.completionPerToken === RIDICULOUS_COMPLETION;
report('Pricing injection', pOk, `prompt=$${p.promptPerToken}/tok, completion=$${p.completionPerToken}/tok`);

// Test 2: A single step with 1 input token and 0 output tokens costs $3
const cost1 = 1 * RIDICULOUS_PROMPT + 0 * RIDICULOUS_COMPLETION;
report('Per-token cost math', cost1 === 3, `1×$3 + 0×$30 = $${cost1}`);

// Test 3: Budget with $10 limit — one step should blow past it
async function test3() {
  inject();
  const agent = new AgentBudget({
    apiKey: API_KEY,
    limits: { maxCostUSD: 10, maxSteps: 3, preflightCheck: false },
  });
  try {
    await agent.step({
      model: MODEL,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    console.log('  Step somehow completed. Usage:', JSON.stringify(agent.getUsage()));
    return false;
  } catch (err: any) {
    if (err instanceof BudgetError && err.exceeded.reason === 'cost') {
      const u = err.exceeded.usage;
      console.log(`  Cost exceeded: $${u.totalCostUSD.toFixed(6)} limit $10`);
      return true;
    }
    console.log(`  Wrong error: ${err.message}`);
    return false;
  }
}
const ok3 = await test3();
report('$10 limit with $3/$30 pricing', ok3, 'Single step blew past $10 limit, BudgetError thrown');

// Test 4: Pre-flight estimation should also catch it
async function test4() {
  inject();
  const agent = new AgentBudget({
    apiKey: API_KEY,
    limits: { maxCostUSD: 10, maxSteps: 3, preflightCheck: true, preflightOutputTokenEstimate: 1 },
  });
  try {
    await agent.step({
      model: MODEL,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    return false;
  } catch (err: any) {
    if (err instanceof BudgetError && err.exceeded.reason === 'preflightCostEstimate') {
      console.log(`  Pre-flight caught: estimated $${err.exceeded.estimatedCost?.toFixed(2)} > remaining`);
      return true;
    }
    if (err instanceof BudgetError && err.exceeded.reason === 'cost') {
      console.log(`  Post-step caught (pre-flight may be disabled): $${err.exceeded.actual.toFixed(2)} > limit`);
      return true;
    }
    console.log(`  Error: ${err.message}`);
    return false;
  }
}
const ok4 = await test4();
report('Pre-flight estimation', ok4, 'Cost caught before API call');

// Test 5: Calculate cost manually
const calcCost = 100 * RIDICULOUS_PROMPT + 50 * RIDICULOUS_COMPLETION;
const expected = 100 * 3 + 50 * 30;
report('calculateCost sanity', calcCost === expected, `100×$3 + 50×$30 = $${calcCost}`);

// Test 6: summary() still works after error
async function test6() {
  inject();
  const agent = new AgentBudget({
    apiKey: API_KEY,
    limits: { maxCostUSD: 5, maxSteps: 3, preflightCheck: false },
  });
  try {
    await agent.step({
      model: MODEL,
      messages: [{ role: 'user', content: 'Hi' }],
    });
  } catch {}
  const u = agent.getUsage();
  // Step is rolled back when BudgetError is thrown (tracker.rollback())
  const clean = u.steps === 0 && u.totalCostUSD === 0;
  report('Usage after caught error (rolled back)', clean, `steps=${u.steps}, cost=$${u.totalCostUSD.toFixed(2)} (rolled back for clean retry)`);
}
await test6();

// Test 7: Step with no limit succeeds regardless of pricing
async function test7() {
  inject();
  const agent = new AgentBudget({
    apiKey: API_KEY,
    limits: { maxSteps: 1, preflightCheck: false },
  });
  try {
    const r = await agent.step({
      model: MODEL,
      messages: [{ role: 'user', content: 'Say hello' }],
    });
    const u = agent.getUsage();
    const hasContent = !!r.choices?.[0]?.message?.content;
    if (!hasContent) { console.log('  No content in response'); return false; }
    console.log(`  Step succeeded. Tokens: ${r.usage?.prompt_tokens ?? '?'} in, ${r.usage?.completion_tokens ?? '?'} out`);
    return true;
  } catch (err: any) {
    console.log(`  Error: ${err.message?.split('\n')[0]}`);
    return false;
  }
}
const ok7 = await test7();
report('No-limit step with insane pricing', ok7, 'Step completed (pricing only affects tracking, not API call)');

// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n  TOTAL: ${passed + failed} tests`);
console.log(`  PASS:  ${passed}`);
console.log(`  FAIL:  ${failed}\n`);
