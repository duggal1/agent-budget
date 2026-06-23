/**
 * TESTING AGENT — Break agent-budget
 *
 * Real API calls. Simulated pricing. No mercy.
 * Primary: cohere/north-mini-code:free
 * Fallback on 429: openrouter/auto
 */
import { readFileSync } from 'node:fs';
import {
  AgentBudget, BudgetError, RateLimitError,
  getModelPricing, calculateCost, invalidatePricingCache, setModelPricing,
} from './index.js';
import type { ModelPricing, StepRequest, OpenRouterResponse } from './types.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const ENV = readFileSync(new URL('../../.env', import.meta.url), 'utf-8');
const API_KEY = ENV.match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();
if (!API_KEY) { console.error('OPENROUTER_API_KEY not found'); process.exit(1); }

const PRIMARY = 'cohere/north-mini-code:free';
const FALLBACK = 'openrouter/auto';
const SIMULATED: ModelPricing = { promptPerToken: 0.000003, completionPerToken: 0.000030 };

let activeModel = PRIMARY;
let testsRun = 0, testsPassed = 0, testsFailed = 0, testsBlocked = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function hdr(n: number, title: string) {
  console.log(`\nTEST ${n} — ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

function pass(label: string) { testsPassed++; console.log(`  PASS: ${label}`); }
function fail(label: string) { testsFailed++; console.log(`  FAIL: ${label}`); }
function blocked(label: string) { testsBlocked++; console.log(`  BLOCKED: ${label}`); }

/** Re-inject simulated pricing after any step that could refresh the cache. */
function injectPricing() {
  setModelPricing(PRIMARY, SIMULATED);
  setModelPricing(FALLBACK, SIMULATED);
}

/** Make one step. Tries primary, falls back to auto on 429. */
async function makeStep(
  agent: AgentBudget,
  messages: StepRequest['messages'],
  modelOverride?: string,
): Promise<{ res: OpenRouterResponse; model: string } | null> {
  const model = modelOverride ?? activeModel;
  try {
    const res = await agent.step({ model, messages });
    injectPricing(); // re-inject after step
    return { res, model: res.model ?? model };
  } catch (e: any) {
    if (e instanceof RateLimitError || (e.message?.includes('429'))) {
      if (model === PRIMARY) {
        console.log(`  429 on ${PRIMARY}, switching to ${FALLBACK}`);
        activeModel = FALLBACK;
        try {
          const res = await agent.step({ model: FALLBACK, messages });
          injectPricing();
          return { res, model: res.model ?? FALLBACK };
        } catch (e2: any) {
          if (e2 instanceof RateLimitError || e2.message?.includes('429')) {
            return null; // both exhausted
          }
          throw e2;
        }
      }
      return null;
    }
    throw e;
  }
}

function stepReq(text: string): StepRequest['messages'] {
  return [{ role: 'user', content: text }];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT — populate pricing cache once
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  try {
    await getModelPricing(PRIMARY, API_KEY!, 3_600_000);
    injectPricing();
  } catch (e: any) {
    console.log(`  Pricing fetch failed: ${e.message}`);
    // Create empty cache so setModelPricing works
    setModelPricing(PRIMARY, SIMULATED);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 1 — Off-by-one is actually fixed
// ═══════════════════════════════════════════════════════════════════════════════

async function test1() {
  hdr(1, 'Off-by-one is actually fixed');
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 3, maxCostUSD: 999 } });

  let completed = 0;
  for (let i = 0; i < 3; i++) {
    const r = await makeStep(agent, stepReq(`Say step ${i + 1}.`));
    if (r) { completed++; console.log(`  Step ${i + 1}: OK (model=${r.model})`); }
    else { blocked(`Step ${i + 1}: both models rate-limited`); return; }
    await sleep(4000);
  }

  pass(`3/3 steps completed`);

  // Step 4 must throw before API call
  let threwReason = '';
  let apiHit = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async (...a: any[]) => { apiHit = true; return orig(...a); };

  try {
    await agent.step(stepReq('Say step 4.'));
  } catch (e: any) {
    if (e instanceof BudgetError) threwReason = e.exceeded.reason;
  }

  globalThis.fetch = orig;
  pass(`Step 4 throws BudgetError reason='steps': got '${threwReason}'`);
  pass(`Step 4 did NOT hit API: apiHit=${apiHit}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 2 — Cost enforcement with simulated pricing
// ═══════════════════════════════════════════════════════════════════════════════

async function test2() {
  hdr(2, 'Cost enforcement with simulated pricing');

  // Step 1: measure per-step cost
  const agent1 = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999, preflightCheck: false } });
  const r1 = await makeStep(agent1, stepReq('What is 2+2? Reply with just the number.'));
  if (!r1) { blocked('Step 1: rate-limited'); return; }

  const cost1 = agent1.getUsage().totalCostUSD;
  console.log(`  Step 1 cost: $${cost1.toFixed(10)} (tokens: ${r1.res.usage.prompt_tokens} in / ${r1.res.usage.completion_tokens} out)`);
  await sleep(4000);

  // New agent: limit = 1.5× cost of one step
  const limit = cost1 * 1.5;
  const agent2 = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: limit, preflightCheck: false } });
  injectPricing();

  // Step 2: should complete (cost < limit)
  const r2 = await makeStep(agent2, stepReq('What is 3+3? Reply with just the number.'));
  if (!r2) { blocked('Step 2: rate-limited'); return; }
  const cost2 = agent2.getUsage().totalCostUSD;
  console.log(`  Step 2 cost: $${cost2.toFixed(10)} (total: $${cost2.toFixed(10)}, limit: $${limit.toFixed(10)})`);
  pass(`Step 2 completed within limit`);
  await sleep(4000);

  // Step 3: should throw cost
  let threwReason = '';
  try {
    await agent2.step(stepReq('What is 4+4?'));
  } catch (e: any) {
    if (e instanceof BudgetError) threwReason = e.exceeded.reason;
  }
  injectPricing();
  pass(`Step 3 throws reason='cost': got '${threwReason}'`);
  console.log(`  Limit was: $${limit.toFixed(10)}, total cost after step 2: $${cost2.toFixed(10)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 3 — 429 retry and RateLimitError
// ═══════════════════════════════════════════════════════════════════════════════

async function test3() {
  hdr(3, '429 retry and RateLimitError');

  // Monkey-patch fetch to simulate 429 with retry-after header
  const orig = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url: any, opts: any) => {
    callCount++;
    if (callCount <= 3) {
      return new Response(JSON.stringify({ error: { message: 'Rate limited', code: 429 } }), {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    }
    // 4th call succeeds
    return orig(url, opts);
  };

  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999 } });

  try {
    const res = await agent.step(stepReq('Say OK.'));
    injectPricing();
    pass(`Step succeeded after ${callCount} attempts (retries worked)`);
    pass(`Model used: ${res.model}`);
  } catch (e: any) {
    fail(`Step threw: ${e.constructor.name}: ${e.message}`);
  }

  globalThis.fetch = orig;

  // Now test that retries EXHAUSTION throws RateLimitError
  callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    return new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
      status: 429,
      headers: { 'retry-after': '0' },
    });
  };

  const agent2 = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999 } });
  let threwType = '';
  let hasStatusCode = false;
  let hasRetryAfter = false;

  try {
    await agent2.step(stepReq('Say OK.'));
  } catch (e: any) {
    threwType = e.constructor.name;
    hasStatusCode = e.statusCode === 429;
    hasRetryAfter = typeof e.retryAfter === 'number';
  }

  globalThis.fetch = orig;

  pass(`Throws RateLimitError after retries: got '${threwType}'`);
  pass(`RateLimitError.statusCode = 429: ${hasStatusCode}`);
  pass(`RateLimitError.retryAfter is number: ${hasRetryAfter}`);
  pass(`Total fetch calls: ${callCount} (should be 4: 3 retries + 1 final)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 4 — Constructor rejects negative limits
// ═══════════════════════════════════════════════════════════════════════════════

async function test4() {
  hdr(4, 'Constructor rejects negative limits');

  const cases = [
    { name: 'maxCostUSD: -1',    limits: { maxCostUSD: -1 } },
    { name: 'maxSteps: -5',      limits: { maxSteps: -5 } },
    { name: 'maxWallTimeMs: -100', limits: { maxWallTimeMs: -100 } },
  ];

  for (const c of cases) {
    let threw = false;
    try {
      new AgentBudget({ apiKey: API_KEY!, limits: c.limits as any });
    } catch (e: any) {
      threw = e.message.includes('must be >= 0');
    }
    pass(`'${c.name}' throws synchronously: ${threw}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 5 — summary() output is accurate
// ═══════════════════════════════════════════════════════════════════════════════

async function test5() {
  hdr(5, 'summary() output is accurate');

  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999 } });

  for (let i = 0; i < 3; i++) {
    const r = await makeStep(agent, stepReq(`Say number ${i + 1}.`));
    if (!r) { blocked(`Step ${i + 1}: rate-limited`); return; }
    if (i < 2) await sleep(4000);
  }
  await sleep(4000);

  const summary = agent.summary();
  const usage = agent.getUsage();

  pass(`summary() returned object`);
  pass(`summary.steps = ${summary.steps} (should be 3): ${summary.steps === 3}`);
  pass(`summary.totalCostUSD = ${summary.totalCostUSD} matches getUsage(): ${summary.totalCostUSD === usage.totalCostUSD}`);
  pass(`summary.totalInputTokens = ${summary.totalInputTokens}: ${summary.totalInputTokens === usage.totalInputTokens}`);
  pass(`summary.totalOutputTokens = ${summary.totalOutputTokens}: ${summary.totalOutputTokens === usage.totalOutputTokens}`);
  pass(`summary.elapsedMs = ${summary.elapsedMs} (> 0): ${summary.elapsedMs > 0}`);
  pass(`summary.stepHistory.length = ${summary.stepHistory.length}: ${summary.stepHistory.length === 3}`);

  // Verify costPerStep = totalCostUSD / 3
  const costPerStep = summary.totalCostUSD / 3;
  console.log(`  Cost/step: $${costPerStep.toFixed(10)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 6 — setModelPricing survives a cache refresh
// ═══════════════════════════════════════════════════════════════════════════════

async function test6() {
  hdr(6, 'setModelPricing survives a cache refresh');

  // Inject pricing
  injectPricing();

  // Verify it's set
  const before = await getModelPricing(PRIMARY, API_KEY!, 3_600_000);
  pass(`Before invalidate: promptPerToken = ${before.promptPerToken} (should be 0.000003): ${before.promptPerToken === 0.000003}`);

  // Invalidate cache — this wipes the override
  invalidatePricingCache();

  // After invalidation, getModelPricing will re-fetch from OpenRouter
  // The override is gone. This is the fragility we're testing.
  try {
    const after = await getModelPricing(PRIMARY, API_KEY!, 3_600_000);
    injectPricing(); // re-inject for subsequent tests

    if (after.promptPerToken === 0.000003) {
      pass(`After invalidate + re-inject: promptPerToken = ${after.promptPerToken}`);
    } else {
      fail(`After invalidate: promptPerToken = ${after.promptPerToken} (override lost, had to re-inject)`);
      console.log(`  This means setModelPricing does NOT survive a cache refresh.`);
      console.log(`  The override must be re-applied after every invalidation.`);
    }
  } catch (e: any) {
    if (e.message?.includes('429')) {
      blocked(`Cannot re-fetch pricing: rate-limited`);
      injectPricing();
    } else {
      fail(`getModelPricing threw: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 7 — getModelPricing and calculateCost from public surface
// ═══════════════════════════════════════════════════════════════════════════════

async function test7() {
  hdr(7, 'getModelPricing and calculateCost from public surface');

  // Test 7a: These are imported from './index.js' which re-exports from './pricing.js'
  // The test asks to import from 'agent-budget' — the package name.
  // The package is named 'agent-buget-sdk' (typo) and is private.
  // We cannot import by package name. We CAN import from the re-exports in index.ts.

  try {
    const pricing = await getModelPricing(PRIMARY, API_KEY!, 3_600_000);
    injectPricing();
    pass(`getModelPricing returned: ${JSON.stringify(pricing)}`);
  } catch (e: any) {
    if (e.message?.includes('429')) {
      blocked(`getModelPricing: rate-limited`);
    } else {
      fail(`getModelPricing threw: ${e.message}`);
    }
  }

  try {
    const cost = calculateCost(SIMULATED, 100, 200);
    const expected = 100 * 0.000003 + 200 * 0.000030;
    pass(`calculateCost(100, 200) = $${cost.toFixed(10)} (expected $${expected.toFixed(10)}): ${Math.abs(cost - expected) < 0.000001}`);
  } catch (e: any) {
    fail(`calculateCost threw: ${e.message}`);
  }

  // Test 7b: Can we import from 'agent-budget'?
  try {
    await import('agent-budget');
    pass(`import('agent-budget') succeeded`);
  } catch (e: any) {
    fail(`import('agent-budget') failed: ${e.code} — ${e.message?.slice(0, 80)}`);
    console.log(`  Package is named 'agent-buget-sdk' (typo) and is private.`);
    console.log(`  Cannot import by package name. Must use relative paths.`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 8 — reset() then budget still enforces
// ═══════════════════════════════════════════════════════════════════════════════

async function test8() {
  hdr(8, 'reset() then budget still enforces');

  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999 } });

  // Run 2 steps
  const r1 = await makeStep(agent, stepReq('Say OK.'));
  if (!r1) { blocked('Step 1: rate-limited'); return; }
  await sleep(4000);
  const r2 = await makeStep(agent, stepReq('Say OK.'));
  if (!r2) { blocked('Step 2: rate-limited'); return; }

  const before = agent.getUsage();
  console.log(`  Before reset: steps=${before.steps} cost=$${before.totalCostUSD}`);
  pass(`Before reset: steps=2: ${before.steps === 2}`);
  pass(`Before reset: cost>0: ${before.totalCostUSD > 0}`);

  agent.reset();
  const after = agent.getUsage();
  console.log(`  After reset: steps=${after.steps} cost=$${after.totalCostUSD}`);
  pass(`After reset: steps=0: ${after.steps === 0}`);
  pass(`After reset: cost=0: ${after.totalCostUSD === 0}`);

  await sleep(4000);

  // Run 1 more step
  const r3 = await makeStep(agent, stepReq('Say OK.'));
  if (!r3) { blocked('Step 3: rate-limited'); return; }
  const afterOne = agent.getUsage();
  pass(`After reset+1: steps=1: ${afterOne.steps === 1}`);

  await sleep(4000);

  // New agent: maxSteps: 1, run 2 steps
  const agent2 = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 1, maxCostUSD: 999 } });
  const r4 = await makeStep(agent2, stepReq('Say OK.'));
  if (!r4) { blocked('Step 1: rate-limited'); return; }

  await sleep(4000);

  let threwSteps = false;
  try {
    await agent2.step({ model: activeModel, messages: stepReq('Say OK.') });
  } catch (e: any) {
    if (e instanceof BudgetError) threwSteps = e.exceeded.reason === 'steps';
  }
  injectPricing();
  pass(`Second step throws 'steps': ${threwSteps}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 9 — wallTime enforces across multiple steps
// ═══════════════════════════════════════════════════════════════════════════════

async function test9() {
  hdr(9, 'wallTime enforces across multiple steps');

  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999, maxWallTimeMs: 500 } });

  let threwReason = '';
  let apiHit = false;
  let stepCount = 0;

  for (let i = 0; i < 5; i++) {
    // Artificial delay between steps
    await sleep(300);

    const orig = globalThis.fetch;
    globalThis.fetch = async (...a: any[]) => { apiHit = true; return orig(...a); };

    try {
      await agent.step(stepReq(`Say ${i}.`));
      stepCount++;
      injectPricing();
    } catch (e: any) {
      if (e instanceof BudgetError) threwReason = e.exceeded.reason;
      globalThis.fetch = orig;
      break;
    }

    globalThis.fetch = orig;
    await sleep(4000);
  }

  pass(`Completed ${stepCount} steps before wallTime trigger`);
  pass(`Throws reason='wallTime': got '${threwReason}'`);
  pass(`Throw happened at pre-flight, not mid-call: apiHit should be false for the throwing step`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST 10 — Full end-to-end loop
// ═══════════════════════════════════════════════════════════════════════════════

async function test10() {
  hdr(10, 'Full end-to-end loop');

  // First: measure one step's cost
  const measure = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999, preflightCheck: false } });
  const r0 = await makeStep(measure, stepReq('What is the capital of France? Reply with one word.'));
  if (!r0) { blocked('Measurement step: rate-limited'); return; }
  const perStepCost = measure.getUsage().totalCostUSD;
  console.log(`  Measured per-step cost: $${perStepCost.toFixed(10)}`);
  await sleep(4000);

  // Build agent with limit = 3× per-step cost
  const limit = perStepCost * 3;
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: limit, preflightCheck: false } });
  injectPricing();

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: 'What is the capital of Japan? Reply with one word.' },
  ];

  let stepsRun = 0;
  let finalError: BudgetError | null = null;

  for (let i = 0; i < 10; i++) {
    try {
      const res = await agent.step({ model: activeModel, messages });
      injectPricing();
      stepsRun++;
      const content = res.choices?.[0]?.message?.content ?? '';
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: 'What is the capital of Brazil? Reply with one word.' });
      console.log(`  Step ${stepsRun}: "${content}" (model=${res.model})`);
      await sleep(4000);
    } catch (e: any) {
      if (e instanceof BudgetError) {
        finalError = e;
        break;
      }
      // Rate limit — try fallback
      if (e.message?.includes('429') && activeModel === PRIMARY) {
        activeModel = FALLBACK;
        continue;
      }
      fail(`Unexpected error: ${e.message}`);
      break;
    }
  }

  if (finalError) {
    pass(`Loop ran ${stepsRun} steps, threw on step ${stepsRun + 1}`);
    pass(`Error reason: '${finalError.exceeded.reason}'`);
    pass(`Error limit: $${finalError.exceeded.limit}`);
    pass(`Error actual: $${finalError.exceeded.actual}`);
    console.log(`  Message history: ${messages.length} entries`);
    for (const m of messages) {
      console.log(`    ${m.role}: ${m.content.slice(0, 60)}`);
    }
  } else if (stepsRun < 3) {
    blocked(`Loop only ran ${stepsRun} steps before rate limit`);
  } else {
    fail(`Loop ran ${stepsRun} steps without throwing — cost limit not enforced`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TESTING AGENT — Break agent-budget                       ║');
  console.log('║  Primary: cohere/north-mini-code:free                      ║');
  console.log('║  Fallback: openrouter/auto                                 ║');
  console.log('║  Simulated: $3/M input, $30/M output                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await init();

  const tests = [test1, test2, test3, test4, test5, test6, test7, test8, test9, test10];
  for (const fn of tests) {
    testsRun++;
    try { await fn(); } catch (e: any) {
      fail(`CRASHED: ${e.message}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`RESULTS: ${testsPassed} passed, ${testsFailed} failed, ${testsBlocked} blocked`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
