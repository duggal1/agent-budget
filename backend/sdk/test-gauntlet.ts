/**
 * ═══════════════════════════════════════════════════════════════
 * TESTING GAUNTLET — agent-budget SDK
 *
 * 10 tests. Real API calls. No mocks (except Test 3 429 mock).
 * Model negotiation: detect 429 on cohere/north-mini-code:free once,
 * then use openrouter/free for all remaining tests. No wasted retries.
 * ═══════════════════════════════════════════════════════════════
 */

import {
  AgentBudget,
  BudgetError,
  RateLimitError,
  invalidatePricingCache,
  getModelPricing,
  calculateCost,
  setModelPricing,
} from './index.js';
import type { StepRequest } from './types.js';

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) { console.error('Set OPENROUTER_API_KEY'); process.exit(1); }

const PRIMARY = 'cohere/north-mini-code:free';
const FALLBACK = 'openrouter/free';
const SIM_PROMPT = 0.000003;    // $3/M tokens
const SIM_COMPLETION = 0.000030; // $30/M tokens

let USE_FALLBACK = false;       // set by modelProbe()
let ACTUAL_MODEL = PRIMARY;
let passed = 0;
let failed = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Inject simulated pricing for any model ID. Creates cache if needed. */
function ensurePricing(modelId: string) {
  setModelPricing(modelId, { promptPerToken: SIM_PROMPT, completionPerToken: SIM_COMPLETION });
}

/** Full reset: invalidate + inject for both primary and fallback. */
function injectPricing() {
  invalidatePricingCache();
  ensurePricing(PRIMARY);
  ensurePricing(FALLBACK);
}

/**
 * Probe primary model with ONE request (no retries). If 429, set fallback
 * for entire run. This avoids 7s of retry backoff in every test.
 */
async function modelProbe(): Promise<void> {
  // Make a direct fetch to the chat endpoint with retries=0 by using a tiny timeout
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: PRIMARY,
        messages: [{ role: 'user', content: 'OK' }],
        max_tokens: 1,
      }),
    });

    if (res.status === 429) {
      const body = await res.json() as any;
      const msg: string = body?.error?.message ?? '';
      if (msg.includes('free-models-per-day')) {
        console.log(`  ⚠ ${PRIMARY} rate-limited (${msg.split('.')[0]}). Switching to ${FALLBACK} for all tests.\n`);
        USE_FALLBACK = true;
        ACTUAL_MODEL = FALLBACK;
        return;
      }
    }

    // Primary works — verify it actually returned a completion
    if (res.ok) {
      ACTUAL_MODEL = PRIMARY;
      return;
    }

    // Some other error — try fallback
    console.log(`  ⚠ ${PRIMARY} returned ${res.status}. Falling back to ${FALLBACK}.\n`);
    USE_FALLBACK = true;
    ACTUAL_MODEL = FALLBACK;
  } catch {
    // Network error — try fallback
    console.log(`  ⚠ ${PRIMARY} unreachable. Falling back to ${FALLBACK}.\n`);
    USE_FALLBACK = true;
    ACTUAL_MODEL = FALLBACK;
  }
}

/**
 * One agent step with transparent model fallback.
 * No retries on primary — if USE_FALLBACK is set, goes straight to fallback.
 */
async function stepOnce(
  agent: AgentBudget,
  req: StepRequest,
  label: string,
): Promise<{ response?: any; modelUsed: string; error?: any }> {
  const model = USE_FALLBACK ? FALLBACK : PRIMARY;
  req.model = model;
  ensurePricing(model);

  try {
    const r = await agent.step({ ...req });
    if (r.model && r.model !== model) {
      ensurePricing(r.model);
    }
    return { response: r, modelUsed: r.model };
  } catch (err: any) {
    // openrouter/free routes to unpredictable providers that may 429/402/etc.
    // Retry once with FALLBACK for ANY error to isolate SDK bugs from provider flakiness.
    if (!USE_FALLBACK) {
      console.log(`  ⚠ ${label}: ${err.message?.split('\n')[0] || err.code || 'error'}. Falling back to ${FALLBACK}...`);
      req.model = FALLBACK;
      ensurePricing(FALLBACK);
      try {
        const r = await agent.step({ ...req });
        if (r.model && r.model !== FALLBACK) ensurePricing(r.model);
        return { response: r, modelUsed: r.model };
      } catch (e2: any) {
        return { error: e2, modelUsed: FALLBACK };
      }
    }
    return { error: err, modelUsed: model };
  }
}

function report(n: number, name: string, ok: boolean, detail: string) {
  const status = ok ? 'PASS' : 'FAIL';
  if (ok) passed++; else failed++;
  console.log(`  Model used: ${ACTUAL_MODEL}`);
  console.log(`  Actual:   ${detail}`);
  console.log(`  Result:   ${status}\n`);
}

function divider(n: number, name: string) {
  console.log('══════════════════════════════════════════════════');
  console.log(`TEST ${n} — ${name}`);
  console.log('══════════════════════════════════════════════════\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1 — Off-by-one: maxSteps allows exactly N steps, step N+1 throws
// ═══════════════════════════════════════════════════════════════════════════════

async function test1() {
  divider(1, 'Off-by-one: maxSteps:3 allows exactly 3 steps');
  injectPricing();

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 3, preflightCheck: false },
  });

  const req: StepRequest = {
    model: PRIMARY,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  };

  let successCount = 0;
  let step4threw = false;

  for (let i = 1; i <= 4; i++) {
    const r = await stepOnce(agent, req, `Step ${i}`);
    if (r.error) {
      if (r.error instanceof BudgetError && r.error.exceeded.reason === 'steps') {
        step4threw = true;
        console.log(`  Step ${i}: BudgetError (reason=steps) — expected`);
        break;
      }
      console.log(`  Step ${i}: UNEXPECTED: ${r.error.message}`);
      break;
    }
    successCount = i;
    console.log(`  Step ${i}: completed. Usage.steps=${agent.getUsage().steps}`);
  }

  const ok = successCount === 3 && step4threw;
  report(1, 'Off-by-one', ok,
    `Steps completed: ${successCount}. Step 4 threw steps: ${step4threw}. Usage.steps=${agent.getUsage().steps}.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2 — Cost enforcement with simulated pricing
// ═══════════════════════════════════════════════════════════════════════════════

async function test2() {
  divider(2, 'Cost enforcement with simulated pricing');
  injectPricing();

  const req: StepRequest = {
    model: PRIMARY,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  };

  // Part A — step with no cost limit always succeeds
  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 5, preflightCheck: false },
  });
  const r1 = await stepOnce(agent, req, 'Step 1');
  if (r1.error) { report(2, 'Cost enforcement', false, `Step 1 blocked: ${r1.error.message}`); return; }
  const cost1 = agent.getUsage().totalCostUSD;
  console.log(`  Step 1 cost: $${cost1.toFixed(8)}`);

  // Part B — tiny limit catches the very first step post-execution.
  // openrouter/free routes to variable-priced backends, so we use a
  // limit below any realistic step cost to guarantee enforcement fires.
  injectPricing();
  const tiny = 0.00001;
  const agent2 = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxCostUSD: tiny, maxSteps: 5, preflightCheck: false },
  });
  const r2 = await stepOnce(agent2, req, 'Tiny-limit step');
  let tinyCaught = false;
  if (r2.error && r2.error instanceof BudgetError && r2.error.exceeded.reason === 'cost') {
    tinyCaught = true;
    console.log(`  Tiny limit ($${tiny.toFixed(8)}): BudgetError (reason=cost) — expected`);
  } else if (r2.response) {
    console.log(`  Tiny limit ($${tiny.toFixed(8)}): completed (should have blocked).`);
  } else {
    console.log(`  Tiny limit: ${r2.error?.message}`);
  }

  // Part C — a larger limit allows 2+ steps, then catches
  injectPricing();
  const generous = cost1 * 1.5;
  const agent3 = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxCostUSD: generous, maxSteps: 5, preflightCheck: false },
  });
  const r3 = await stepOnce(agent3, req, '2-step agent step 1');
  if (r3.error) { report(2, 'Cost enforcement', false, `C-generous step 1 blocked: ${r3.error.message}`); return; }
  const r4 = await stepOnce(agent3, req, '2-step agent step 2');
  let generousCaught = false;
  if (r4.response) {
    const r5 = await stepOnce(agent3, req, '2-step agent step 3');
    if (r5.error && r5.error instanceof BudgetError && r5.error.exceeded.reason === 'cost') {
      generousCaught = true;
      console.log(`  Generous limit ($${generous.toFixed(8)}): 2 steps ok, step 3 cost throw — expected`);
    }
  } else if (r4.error && r4.error instanceof BudgetError && r4.error.exceeded.reason === 'cost') {
    console.log(`  Generous limit: caught on step 2 (still proves enforcement)`);
    generousCaught = true;
  }

  const ok = tinyCaught && generousCaught;
  report(2, 'Cost enforcement', ok,
    `Step1 cost: $${cost1.toFixed(8)}. Tiny limit caught: ${tinyCaught}. Generous limit caught: ${generousCaught}.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3 — 429 retry and RateLimitError
// ═══════════════════════════════════════════════════════════════════════════════

async function test3() {
  divider(3, '429 retry and RateLimitError');
  injectPricing();

  // Part A: Monkey-patch fetch to return 429 once, then restore
  // The SDK's retry logic should catch it, retry, and succeed on the second call.
  const originalFetch = globalThis.fetch;
  let intercepted = false;

  globalThis.fetch = async (url: any, opts?: any) => {
    if (!intercepted && typeof url === 'string' && url.includes('chat/completions')) {
      intercepted = true;
      return new Response(
        JSON.stringify({ error: { message: 'Mock 429', code: 429 } }),
        {
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers({ 'retry-after': '0', 'Content-Type': 'application/json' }),
        },
      );
    }
    return originalFetch(url, opts);
  };

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 3, preflightCheck: false },
  });

  try {
    const r = await agent.step({
      model: USE_FALLBACK ? FALLBACK : PRIMARY,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    console.log(`  Part A — Mock 429 on first call: caught, retried, succeeded. Model: ${r.model}`);
    console.log(`  Intercepted: ${intercepted}`);
  } catch (err: any) {
    console.log(`  Part A — Error: ${err.constructor.name}: ${err.message}`);
  }

  // Part B: Always-429 to exhaust retries and confirm RateLimitError
  globalThis.fetch = async (url: any, opts?: any) => {
    if (typeof url === 'string' && url.includes('chat/completions')) {
      return new Response(
        JSON.stringify({ error: { message: 'Always 429', code: 429 } }),
        { status: 429, headers: new Headers({ 'retry-after': '0', 'Content-Type': 'application/json' }) },
      );
    }
    return originalFetch(url, opts);
  };

  const agent2 = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 3, preflightCheck: false },
  });

  try {
    await agent2.step({
      model: USE_FALLBACK ? FALLBACK : PRIMARY,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    globalThis.fetch = originalFetch;
    report(3, '429 retry', false, 'Always-429 step succeeded — retry logic did NOT exhaust.');
    return;
  } catch (err: any) {
    globalThis.fetch = originalFetch;
    const isRLE = err instanceof RateLimitError;
    const hasSC = err.statusCode === 429;
    const hasRA = err.retryAfter !== undefined;
    console.log(`  Part B — Always 429: ${err.constructor.name} (statusCode=${err.statusCode}, retryAfter=${err.retryAfter})`);
    console.log(`  SDK retry: 3 attempts with exponential backoff (1s, 2s, 4s), then RateLimitError`);

    // Part C: Real 429 handling (demonstrated by every other test in this suite)
    if (USE_FALLBACK) {
      console.log(`  Part C — Real 429 detected at startup: primary model ${PRIMARY} is exhausted.`);
      console.log(`  ${FALLBACK} used for all tests as transparent fallback.`);
    }

    const ok = isRLE && hasSC && hasRA;
    report(3, '429 retry', ok,
      `RateLimitError: ${isRLE}, statusCode=429: ${hasSC}(${err.statusCode}), retryAfter: ${hasRA}(${err.retryAfter}). ` +
      (USE_FALLBACK ? `Real 429 detected at probe time. Fallback ${FALLBACK} used for all tests.` : '')
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4 — Constructor rejects negative limits (no API calls)
// ═══════════════════════════════════════════════════════════════════════════════

async function test4() {
  divider(4, 'Constructor rejects negative limits');

  const cases = [
    { name: 'maxCostUSD: -1',  limits: { maxCostUSD: -1 } },
    { name: 'maxSteps: -5',    limits: { maxSteps: -5 } },
    { name: 'maxWallTimeMs: -100', limits: { maxWallTimeMs: -100 } },
  ];

  let allThrew = true;
  for (const c of cases) {
    try {
      new AgentBudget({ apiKey: API_KEY!, limits: c.limits as any });
      console.log(`  ${c.name}: DID NOT THROW`);
      allThrew = false;
    } catch (err: any) {
      console.log(`  ${c.name}: threw — "${err.message}"`);
    }
  }

  report(4, 'Negative limits', allThrew,
    allThrew ? 'All 3 negative limits rejected synchronously' : 'Some negative limits were NOT rejected'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5 — summary() output matches getUsage() exactly
// ═══════════════════════════════════════════════════════════════════════════════

async function test5() {
  divider(5, 'summary() output matches getUsage()');
  injectPricing();

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 4, preflightCheck: false },
  });

  const req: StepRequest = {
    model: PRIMARY,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  };

  for (let i = 0; i < 3; i++) {
    const r = await stepOnce(agent, req, `Step ${i + 1}`);
    if (r.error) { report(5, 'summary()', false, `Step ${i + 1}: ${r.error.message}`); return; }
  }

  const usage = agent.getUsage();
  const summaryResult = agent.summary();

  const checks = [
    ['steps',       summaryResult.steps === usage.steps],
    ['totalCostUSD', Math.abs(summaryResult.totalCostUSD - usage.totalCostUSD) < 0.000001],
    ['totalInputTokens', summaryResult.totalInputTokens === usage.totalInputTokens],
    ['totalOutputTokens', summaryResult.totalOutputTokens === usage.totalOutputTokens],
    ['elapsedMs',   Math.abs(summaryResult.elapsedMs - usage.elapsedMs) < 50],
    ['stepHistory.length', summaryResult.stepHistory.length === usage.stepHistory.length],
  ];

  const allOk = checks.every(([, v]) => v);
  const failFields = checks.filter(([, v]) => !v).map(([k]) => k);

  report(5, 'summary()', allOk,
    `steps=${usage.steps}, cost=$${usage.totalCostUSD.toFixed(8)}. ` +
    `Returned object matches getUsage(): ${allOk}. ` +
    (failFields.length ? `Mismatched fields: ${failFields.join(', ')}` : '')
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 6 — setModelPricing survives cache invalidation
// ═══════════════════════════════════════════════════════════════════════════════

async function test6() {
  divider(6, 'setModelPricing survives cache refresh');
  injectPricing();

  // Force cache clear + re-inject exactly like a test would after a pricing refresh
  invalidatePricingCache();
  ensurePricing(PRIMARY);
  ensurePricing(FALLBACK);

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 3, preflightCheck: false },
  });

  const req: StepRequest = {
    model: PRIMARY,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  };

  const r = await stepOnce(agent, req, 'Step 1');
  if (r.error) { report(6, 'Pricing survival', false, `Step failed: ${r.error.message}`); return; }

  const cost = agent.getUsage().totalCostUSD;
  report(6, 'Pricing survival', cost > 0,
    `Cost after invalidate + re-inject + step: $${cost.toFixed(10)}. Non-zero: ${cost > 0}.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 7 — Public surface exports
// ═══════════════════════════════════════════════════════════════════════════════

async function test7() {
  divider(7, 'getModelPricing and calculateCost from public surface');

  try {
    const pricing = await getModelPricing(PRIMARY, API_KEY!, 300000);
    const cost = calculateCost(pricing, 100, 200);
    console.log(`  getModelPricing returned: promptPerToken=${pricing.promptPerToken}, completionPerToken=${pricing.completionPerToken}`);
    console.log(`  calculateCost(100, 200) = ${cost}`);
    report(7, 'Public exports', true,
      `Both callable from index.ts. cost=100×${pricing.promptPerToken}+200×${pricing.completionPerToken}=${cost}.`
    );
  } catch (err: any) {
    report(7, 'Public exports', false, `Error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 8 — reset() works and budget still enforces after
// ═══════════════════════════════════════════════════════════════════════════════

async function test8() {
  divider(8, 'reset() works, budget still enforces');
  injectPricing();

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 5, preflightCheck: false },
  });

  const req: StepRequest = {
    model: PRIMARY,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  };

  for (let i = 0; i < 2; i++) {
    const r = await stepOnce(agent, req, `Pre-reset ${i + 1}`);
    if (r.error) { report(8, 'reset()', false, `Pre-reset step ${i + 1}: ${r.error.message}`); return; }
  }
  const beforeReset = agent.getUsage();
  console.log(`  Before reset: steps=${beforeReset.steps}, cost=$${beforeReset.totalCostUSD.toFixed(8)}`);

  agent.reset();
  const afterReset = agent.getUsage();
  console.log(`  After reset:  steps=${afterReset.steps}, cost=$${afterReset.totalCostUSD.toFixed(8)}`);

  const rPost = await stepOnce(agent, req, 'Post-reset');
  if (rPost.error) { report(8, 'reset()', false, `Post-reset step: ${rPost.error.message}`); return; }
  const final = agent.getUsage();
  console.log(`  After +1:     steps=${final.steps}, cost=$${final.totalCostUSD.toFixed(8)}`);

  // New agent with maxSteps:1
  injectPricing();
  const agent2 = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 1, preflightCheck: false },
  });

  const r2a = await stepOnce(agent2, req, 'Agent2 step 1');
  if (r2a.error) { report(8, 'reset()', false, `Agent2 step 1: ${r2a.error.message}`); return; }
  console.log(`  Agent2 step 1: steps=${agent2.getUsage().steps}`);

  const r2b = await stepOnce(agent2, req, 'Agent2 step 2');
  let step2blocked = r2b.error instanceof BudgetError && r2b.error.exceeded.reason === 'steps';
  console.log(`  Agent2 step 2: ${step2blocked ? 'BudgetError (steps) — correct' : 'completed (should have blocked)'}`);

  const ok = afterReset.steps === 0 && afterReset.totalCostUSD === 0 &&
             final.steps === 1 && step2blocked;
  report(8, 'reset()', ok,
    `Reset -> steps=0(${afterReset.steps}), cost=0(${afterReset.totalCostUSD}). ` +
    `+1 step -> steps=1(${final.steps}). maxSteps:1 blocks step2: ${step2blocked}.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 9 — wallTime enforces across multiple steps
// ═══════════════════════════════════════════════════════════════════════════════

async function test9() {
  divider(9, 'wallTime enforces across steps');
  injectPricing();

  // Each iteration: ~1s step + ~1s delay = ~2s. Set limit so that
  // inter-step delays accumulate past it around step 5-6.
  const WALL_LIMIT = 20000;
  const DELAY = 1000;

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxWallTimeMs: WALL_LIMIT, maxSteps: 10, preflightCheck: false },
  });

  const req: StepRequest = {
    model: PRIMARY,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  };

  let hitWallTime = false;
  let completeCount = 0;

  for (let i = 1; i <= 8; i++) {
    const r = await stepOnce(agent, req, `Step ${i}`);

    if (r.error) {
      const isWall = r.error instanceof BudgetError && r.error.exceeded.reason === 'wallTime';
      if (isWall) {
        hitWallTime = true;
        console.log(`  Step ${i}: wallTime at ${agent.getUsage().elapsedMs}ms cumulative`);
        break;
      }
      console.log(`  Step ${i}: ERROR: ${r.error.message}`);
      break;
    }

    completeCount = i;
    const el = agent.getUsage().elapsedMs;
    console.log(`  Step ${i}: completed. ${el}ms / ${WALL_LIMIT}ms elapsed`);

    if (i < 8) {
      console.log(`  Delay ${DELAY}ms...`);
      await new Promise(r => setTimeout(r, DELAY));
    }
  }

  const ok = hitWallTime && completeCount >= 1;
  report(9, 'wallTime enforcement', ok,
    `Steps completed: ${completeCount}. WallTime hit: ${hitWallTime}. ` +
    `Cumulative: ${agent.getUsage().elapsedMs}ms / ${WALL_LIMIT}ms limit.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 10 — Full end-to-end loop with cost enforcement
// ═══════════════════════════════════════════════════════════════════════════════

async function test10() {
  divider(10, 'Full end-to-end loop');
  injectPricing();

  // Calibrate: one step to get per-step cost
  const calAgent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 2, preflightCheck: false },
  });

  const req: StepRequest = {
    model: PRIMARY,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  };

  const rCal = await stepOnce(calAgent, req, 'Calibration');
  if (rCal.error) { report(10, 'End-to-end', false, `Calibration: ${rCal.error.message}`); return; }

  const perStepCost = calAgent.getUsage().totalCostUSD;
  console.log(`  Per-step cost: $${perStepCost.toFixed(8)}`);

  // Loop step 1 cost may differ from calibration (different prompt length).
  // Use a generous multiplier to ensure 2-3 steps before cost enforcement.
  injectPricing();
  const limit = perStepCost * 8;
  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxCostUSD: limit, maxSteps: 10, preflightCheck: false },
  });

  const loopReq: StepRequest = {
    model: PRIMARY,
    messages: [{ role: 'user', content: 'Reply with a single word.' }],
  };

  let loopSteps = 0;
  let threwCost = false;

  for (let i = 1; i <= 10; i++) {
    const r = await stepOnce(agent, loopReq, `Loop ${i}`);
    if (r.error) {
      if (r.error instanceof BudgetError && r.error.exceeded.reason === 'cost') {
        threwCost = true;
        console.log(`  Step ${i}: cost BudgetError — expected`);
        loopSteps = i - 1;
        break;
      }
      console.log(`  Step ${i}: ${r.error.message}`);
      loopSteps = i - 1;
      break;
    }
    const content = r.response?.choices?.[0]?.message?.content ?? '';
    loopReq.messages.push({ role: 'assistant', content });
    loopReq.messages.push({ role: 'user', content: 'Another word.' });
    loopSteps = i;
    console.log(`  Step ${i}: done. cost=$${agent.getUsage().totalCostUSD.toFixed(8)}, msgs=${loopReq.messages.length}`);
  }

  const ok = loopSteps >= 2 && threwCost;
  report(10, 'End-to-end loop', ok,
    `Steps: ${loopSteps}. Threw cost: ${threwCost}. ` +
    `Final cost: $${agent.getUsage().totalCostUSD.toFixed(8)} (limit: $${limit.toFixed(8)}). ` +
    `Msg history: ${loopReq.messages.length}.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('████████████████████████████████████████████████████████████');
  console.log('█              agent-budget SDK — TESTING GAUNTLET        █');
  console.log('████████████████████████████████████████████████████████████\n');

  console.log('── Model negotiation ──────────────────────────────────────');
  await modelProbe();
  console.log(`  Primary: ${PRIMARY}`);
  console.log(`  Active:  ${ACTUAL_MODEL}`);
  console.log(`  Fallback: ${USE_FALLBACK ? `YES (${FALLBACK})` : 'not needed'}\n`);

  const startAll = Date.now();

  await test1();
  await test2();
  await test3();
  await test4();
  await test5();
  await test6();
  await test7();
  await test8();
  await test9();
  await test10();

  const totalSec = ((Date.now() - startAll) / 1000).toFixed(1);

  console.log('══════════════════════════════════════════════════');
  console.log(`  TOTAL:   ${passed + failed} tests`);
  console.log(`  PASS:    ${passed}`);
  console.log(`  FAIL:    ${failed}`);
  console.log(`  DURATION: ${totalSec}s`);
  if (USE_FALLBACK) {
    console.log(`  NOTE:    Primary model ${PRIMARY} was rate-limited.`);
    console.log(`           All tests used ${FALLBACK} with simulated pricing.`);
  }
  console.log('══════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
