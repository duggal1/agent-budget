/**
 * ═══════════════════════════════════════════════════════════════
 * VALIDATION AGENT — agent-budget SDK Destroyer
 *
 * Every claim tested against reality. Zero mercy.
 * ═══════════════════════════════════════════════════════════════
 */

import { AgentBudget, BudgetError, invalidatePricingCache } from './index.js';
import { getModelPricing, setModelPricing, calculateCost } from './pricing.js';
import type { StepRequest } from './types.js';

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) { console.error('Set OPENROUTER_API_KEY'); process.exit(1); }

const MODEL = 'cohere/north-mini-code:free';
const SIM_PROMPT = 0.000003;   // $3/million tokens
const SIM_COMPLETION = 0.000015; // $15/million tokens

let passed = 0;
let failed = 0;

function result(name: string, ok: boolean, detail: string) {
  const status = ok ? 'PASS' : 'FAIL';
  if (ok) passed++; else failed++;
  console.log(`  Result:   ${status}`);
  console.log(`  Notes:    ${detail}\n`);
}

async function task1_PricingFetch() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 1 — Pricing fetch is real');
  console.log('══════════════════════════════════════════════════\n');

  try {
    // Direct API call, no SDK
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const json = await res.json() as { data: Array<{ id: string; pricing?: { prompt: string; completion: string } }> };
    const model = json.data.find((m: any) => m.id === MODEL);

    if (!model) {
      console.log('  Expected: cohere/north-mini-code:free to appear in API response');
      console.log(`  Actual:   model not found in ${json.data.length} models`);
      result('TASK 1', false, 'Model missing from OpenRouter API response');
      return;
    }

    console.log(`  Model found: ${model.id}`);
    console.log(`  Raw pricing: prompt=${model.pricing?.prompt}, completion=${model.pricing?.completion}`);

    if (model.pricing?.prompt === '0' && model.pricing?.completion === '0') {
      console.log('  ✓ API confirms $0 pricing for free model');
    }

    // Try SDK's getModelPricing
    const sdkPricing = await getModelPricing(MODEL, API_KEY!, 60000);
    console.log(`  SDK parsed: promptPerToken=${sdkPricing.promptPerToken}, completionPerToken=${sdkPricing.completionPerToken}`);

    const ok = sdkPricing.promptPerToken === 0 && sdkPricing.completionPerToken === 0;
    result('TASK 1', ok, `Model exists, pricing is $0. SDK parses without crashing. Parsed values: ${sdkPricing.promptPerToken}, ${sdkPricing.completionPerToken}`);
  } catch (err: any) {
    result('TASK 1', false, `API error: ${err.message}`);
  }
}

async function task2_RealApiCall() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 2 — Real API call goes through');
  console.log('══════════════════════════════════════════════════\n');

  try {
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxSteps: 3 },
    });

    const res = await agent.step({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the word OK and nothing else.' }],
    });

    console.log(`  Response model: ${res.model}`);
    console.log(`  Response usage: ${JSON.stringify(res.usage)}`);

    const p = res.usage?.prompt_tokens;
    const c = res.usage?.completion_tokens;
    const ok = p !== undefined && p !== null && p > 0 && c !== undefined && c !== null && c > 0;

    result('TASK 2', ok, `prompt_tokens=${p}, completion_tokens=${c}. Real non-zero integers: ${ok}`);
  } catch (err: any) {
    result('TASK 2', false, `step() failed: ${err.message}. API call did NOT go through.`);
  }
}

async function task3_CostCalculation() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 3 — Cost calculation with simulated pricing');
  console.log('══════════════════════════════════════════════════\n');

  try {
    invalidatePricingCache();
    setModelPricing(MODEL, { promptPerToken: SIM_PROMPT, completionPerToken: SIM_COMPLETION });

    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxSteps: 3 },
    });

    const res = await agent.step({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the word OK and nothing else.' }],
    });

    const p = res.usage?.prompt_tokens ?? 0;
    const c = res.usage?.completion_tokens ?? 0;
    const expectedCost = p * SIM_PROMPT + c * SIM_COMPLETION;

    const usage = agent.getUsage();
    const recordedCost = usage.totalCostUSD;

    console.log(`  Input tokens: ${p} × ${SIM_PROMPT} = ${(p * SIM_PROMPT).toFixed(10)}`);
    console.log(`  Output tokens: ${c} × ${SIM_COMPLETION} = ${(c * SIM_COMPLETION).toFixed(10)}`);
    console.log(`  Expected cost: ${expectedCost.toFixed(10)}`);
    console.log(`  Recorded cost: ${recordedCost.toFixed(10)}`);

    const diff = Math.abs(expectedCost - recordedCost);
    const ok = diff < 0.000001;

    result('TASK 3', ok, `Expected ${expectedCost.toFixed(10)}, got ${recordedCost.toFixed(10)}, diff=${diff.toFixed(10)}. ${ok ? 'Match within 6 decimal places' : 'MISMATCH!'}`);
  } catch (err: any) {
    result('TASK 3', false, `Error: ${err.message}`);
  }
}

async function task4_maxCostUSD() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 4 — maxCostUSD triggers correctly');
  console.log('══════════════════════════════════════════════════\n');

  try {
    invalidatePricingCache();
    setModelPricing(MODEL, { promptPerToken: SIM_PROMPT, completionPerToken: SIM_COMPLETION });

    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxCostUSD: 0.0000001, preflightCheck: true },
    });

    const startTime = Date.now();
    try {
      await agent.step({
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with the word OK and nothing else.' }],
      });
      // If it didn't throw, that's a FAIL - cost limit should have been hit
      const elapsed = Date.now() - startTime;
      result('TASK 4', false, `No BudgetError thrown. Step completed in ${elapsed}ms. This means the cost limit was NOT enforced. ${elapsed < 2000 ? '(Suspiciously fast - was the API call actually made?)' : ''}`);
    } catch (err: any) {
      const elapsed = Date.now() - startTime;

      if (err instanceof BudgetError) {
        console.log(`  Reason: ${err.exceeded.reason}`);
        console.log(`  Limit: ${err.exceeded.limit}`);
        console.log(`  Actual (usage total before step): ${err.exceeded.actual}`);
        console.log(`  Elapsed: ${elapsed}ms`);

        // First step should NOT have prior cost, so preflight shouldn't block
        // The 'cost' reason should only fire POST-step
        const isCost = err.exceeded.reason === 'cost';
        const waited = elapsed > 1000; // spent real time on API

        result('TASK 4', isCost && waited,
          `Reason=${err.exceeded.reason}, elapsed=${elapsed}ms. ` +
          `${isCost ? 'Correct reason' : 'WRONG reason - should be cost'}. ` +
          `${waited ? 'API call was made' : 'Blocked before API call (preflight on step 1?)'}.`
        );
      } else {
        result('TASK 4', false, `Wrong error type: ${err.constructor.name}: ${err.message}`);
      }
    }
  } catch (err: any) {
    result('TASK 4', false, `Setup error: ${err.message}`);
  }
}

async function task5_maxSteps() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 5 — maxSteps triggers correctly');
  console.log('══════════════════════════════════════════════════\n');

  try {
    invalidatePricingCache();
    setModelPricing(MODEL, { promptPerToken: SIM_PROMPT, completionPerToken: SIM_COMPLETION });

    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxSteps: 2, preflightCheck: false },
    });

    const req: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the word OK and nothing else.' }],
    };

    let step1ok = false;
    let step2ok = false;
    let step3failed = false;

    try {
      await agent.step({ ...req });
      step1ok = true;
      console.log('  Step 1: completed');
    } catch (e: any) {
      console.log(`  Step 1: FAILED — ${e.message}`);
    }

    try {
      await agent.step({ ...req });
      step2ok = true;
      console.log('  Step 2: completed');
    } catch (e: any) {
      console.log(`  Step 2: FAILED — ${e.message}`);
    }

    try {
      await agent.step({ ...req });
      console.log('  Step 3: completed (SHOULD HAVE FAILED)');
    } catch (e: any) {
      if (e instanceof BudgetError) {
        step3failed = true;
        console.log(`  Step 3: BudgetError (expected) — reason=${e.exceeded.reason}`);
      } else {
        console.log(`  Step 3: Error — ${e.message}`);
      }
    }

    const steps = agent.getUsage().steps;
    const ok = step1ok && step2ok && step3failed && steps === 2;

    result('TASK 5', ok,
      `Step1=${step1ok}, Step2=${step2ok}, Step3 threw BudgetError=${step3failed}. ` +
      `Recorded steps=${steps}. ${ok ? 'maxSteps=2 allows exactly 2 steps' : 'MISMATCH'}`
    );
  } catch (err: any) {
    result('TASK 5', false, `Error: ${err.message}`);
  }
}

async function task6_maxWallTimeMs() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 6 — maxWallTimeMs triggers correctly');
  console.log('══════════════════════════════════════════════════\n');

  try {
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxWallTimeMs: 1, preflightCheck: false },
    });

    const before = Date.now();
    try {
      await agent.step({
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      });
      const after = Date.now();
      result('TASK 6', false, `No BudgetError thrown. Elapsed: ${after - before}ms. wallTime check did NOT trigger.`);
    } catch (err: any) {
      const after = Date.now();
      if (err instanceof BudgetError) {
        const isWallTime = err.exceeded.reason === 'wallTime';
        const blockedBeforeApi = (after - before) < 500;
        result('TASK 6', isWallTime && blockedBeforeApi,
          `Reason=${err.exceeded.reason}, elapsed=${after - before}ms. ` +
          `${isWallTime ? 'Correct reason' : 'WRONG reason'}. ` +
          `${blockedBeforeApi ? 'Blocked before API call (correct for pre-flight)' : 'Allowed API call then checked (waste)'}`
        );
      } else {
        result('TASK 6', false, `Wrong error type: ${err.message}`);
      }
    }
  } catch (err: any) {
    result('TASK 6', false, `Setup error: ${err.message}`);
  }
}

async function task7_maxTotalTokens() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 7 — maxTotalTokens triggers correctly');
  console.log('══════════════════════════════════════════════════\n');

  try {
    invalidatePricingCache();
    setModelPricing(MODEL, { promptPerToken: SIM_PROMPT, completionPerToken: SIM_COMPLETION });

    // First run a step to get real token counts
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxSteps: 3, preflightCheck: false },
    });

    const req: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the word OK and nothing else.' }],
    };

    await agent.step({ ...req });
    const usage = agent.getUsage();
    const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;
    console.log(`  Step 1 used ${usage.totalInputTokens} input + ${usage.totalOutputTokens} output = ${totalTokens} total tokens`);

    // Now create a new agent with maxTotalTokens just below the actual usage
    const tightAgent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxTotalTokens: totalTokens, preflightCheck: false },
    });

    try {
      await tightAgent.step({ ...req });
      const u2 = tightAgent.getUsage();
      const total2 = u2.totalInputTokens + u2.totalOutputTokens;
      result('TASK 7', false,
        `No BudgetError thrown. Set maxTotalTokens=${totalTokens}, step used ${u2.totalInputTokens}+${u2.totalOutputTokens}=${total2}. ` +
        `${total2 >= totalTokens ? 'Limit should have triggered (actual >= limit)' : 'Limit not reached'}`
      );
    } catch (err: any) {
      if (err instanceof BudgetError) {
        console.log(`  Reason: ${err.exceeded.reason}`);
        console.log(`  Limit: ${err.exceeded.limit}`);
        console.log(`  Actual: ${err.exceeded.actual}`);
        result('TASK 7', err.exceeded.reason === 'totalTokens',
          `Reason=${err.exceeded.reason}, limit=${err.exceeded.limit}, actual=${err.exceeded.actual}`
        );
      } else {
        result('TASK 7', false, `Wrong error type: ${err.message}`);
      }
    }
  } catch (err: any) {
    result('TASK 7', false, `Error: ${err.message}`);
  }
}

async function task8_getUsageAccuracy() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 8 — getUsage() is accurate');
  console.log('══════════════════════════════════════════════════\n');

  try {
    invalidatePricingCache();
    setModelPricing(MODEL, { promptPerToken: SIM_PROMPT, completionPerToken: SIM_COMPLETION });

    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxSteps: 4, preflightCheck: false },
    });

    const req: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    };

    const snapshots: Array<{ steps: number; costUSD: number; elapsedMs: number }> = [];

    for (let i = 0; i < 3; i++) {
      try {
        await agent.step({ ...req });
        const u = agent.getUsage();
        snapshots.push({ steps: u.steps, costUSD: u.totalCostUSD, elapsedMs: u.elapsedMs });
        console.log(`  After step ${i + 1}: steps=${u.steps}, cost=${u.totalCostUSD.toFixed(10)}, elapsed=${u.elapsedMs}ms`);

        if (i > 0) {
          const prev = snapshots[i - 1];
          if (u.steps !== prev.steps + 1) console.log(`  ⚠ Steps jumped: ${prev.steps} → ${u.steps}`);
          if (u.costUSD <= prev.costUSD) console.log(`  ⚠ Cost didn't increase: ${prev.costUSD} → ${u.costUSD}`);
          if (u.elapsedMs < prev.elapsedMs) console.log(`  ⚠ Elapsed went backwards: ${prev.elapsedMs} → ${u.elapsedMs}`);
        }
      } catch (e: any) {
        console.log(`  Step ${i + 1}: ${e.message}`);
        break;
      }
    }

    const ok = snapshots.length === 3 &&
      snapshots[0].steps === 1 &&
      snapshots[1].steps === 2 &&
      snapshots[2].steps === 3 &&
      snapshots[2].costUSD > snapshots[1].costUSD &&
      snapshots[2].elapsedMs >= snapshots[1].elapsedMs;

    result('TASK 8', ok,
      `Recorded ${snapshots.length}/3 steps. ` +
      `Steps: ${snapshots.map(s => s.steps).join(', ')}. ` +
      `Costs: ${snapshots.map(s => s.costUSD.toFixed(10)).join(', ')}. ` +
      `Elapsed: ${snapshots.map(s => s.elapsedMs).join(', ')}ms`
    );
  } catch (err: any) {
    result('TASK 8', false, `Error: ${err.message}`);
  }
}

async function task9_Reset() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 9 — reset() works');
  console.log('══════════════════════════════════════════════════\n');

  try {
    invalidatePricingCache();
    setModelPricing(MODEL, { promptPerToken: SIM_PROMPT, completionPerToken: SIM_COMPLETION });

    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxSteps: 5, preflightCheck: false },
    });

    const req: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    };

    // Run 2 steps
    try { await agent.step({ ...req }); } catch (e: any) { console.log(`  Step 1: ${e.message}`); }
    try { await agent.step({ ...req }); } catch (e: any) { console.log(`  Step 2: ${e.message}`); }

    const beforeReset = agent.getUsage();
    console.log(`  Before reset: steps=${beforeReset.steps}, cost=${beforeReset.totalCostUSD.toFixed(10)}`);

    // Reset
    agent.reset();
    const afterReset = agent.getUsage();
    console.log(`  After reset: steps=${afterReset.steps}, cost=${afterReset.totalCostUSD.toFixed(10)}`);

    // Run 1 more step
    try { await agent.step({ ...req }); } catch (e: any) { console.log(`  Step 3 (after reset): ${e.message}`); }

    const final = agent.getUsage();
    console.log(`  Final: steps=${final.steps}, cost=${final.totalCostUSD.toFixed(10)}`);

    const ok = afterReset.steps === 0 && afterReset.totalCostUSD === 0 &&
               final.steps === 1;

    result('TASK 9', ok,
      `Before reset: steps=${beforeReset.steps}. After reset: steps=${afterReset.steps}, cost=${afterReset.totalCostUSD}. ` +
      `After +1 step: steps=${final.steps}. ${ok ? 'reset() works correctly' : 'reset() broken'}`
    );
  } catch (err: any) {
    result('TASK 9', false, `Error: ${err.message}`);
  }
}

async function task10_ErrorPayload() {
  console.log('══════════════════════════════════════════════════');
  console.log('TASK 10 — Error payload is complete');
  console.log('══════════════════════════════════════════════════\n');

  try {
    invalidatePricingCache();
    setModelPricing(MODEL, { promptPerToken: SIM_PROMPT, completionPerToken: SIM_COMPLETION });

    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxSteps: 1, preflightCheck: false },
    });

    const req: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    };

    // Run 1 step clean
    try { await agent.step({ ...req }); } catch (_) {}

    // Run 2nd step — should hit maxSteps limit
    try {
      await agent.step({ ...req });
      result('TASK 10', false, 'No BudgetError thrown on step 2 with maxSteps=1');
    } catch (err: any) {
      if (err instanceof BudgetError) {
        const e = err.exceeded;
        console.log(`  Full exceeded payload:`);
        console.log(`  ${JSON.stringify(e, null, 2)}`);

        const hasReason = !!e.reason;
        const hasLimit = e.limit !== undefined && e.limit !== null;
        const hasActual = e.actual !== undefined && e.actual !== null;
        const hasUsage = !!e.usage;
        const hasStepHistory = e.usage?.stepHistory && e.usage.stepHistory.length > 0;
        const costNonZero = e.usage?.totalCostUSD !== undefined;

        const ok = hasReason && hasLimit && hasActual && hasUsage && hasStepHistory;

        result('TASK 10', ok,
          `reason=${hasReason}, limit=${hasLimit}(${e.limit}), actual=${hasActual}(${e.actual}), ` +
          `usage.stepHistory.length=${e.usage?.stepHistory?.length ?? 0}, ` +
          `usage.totalCostUSD=${e.usage?.totalCostUSD}. ` +
          `${ok ? 'Payload complete' : 'Missing fields!'}`
        );
      } else {
        result('TASK 10', false, `Wrong error type: ${err.message}`);
      }
    }
  } catch (err: any) {
    result('TASK 10', false, `Setup error: ${err.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('████████████████████████████████████████████████████████');
  console.log('█           agent-budget SDK — VALIDATION             █');
  console.log('████████████████████████████████████████████████████████\n');
  console.log(`Model: ${MODEL}`);
  console.log(`Simulated pricing: $${SIM_PROMPT}/input token, $${SIM_COMPLETION}/output token\n`);

  await task1_PricingFetch();
  await task2_RealApiCall();
  await task3_CostCalculation();
  await task4_maxCostUSD();
  await task5_maxSteps();
  await task6_maxWallTimeMs();
  await task7_maxTotalTokens();
  await task8_getUsageAccuracy();
  await task9_Reset();
  await task10_ErrorPayload();

  console.log('══════════════════════════════════════════════════');
  console.log('  RESULTS:');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);
  console.log(`  Pass rate: ${((passed / (passed + failed)) * 100).toFixed(0)}%`);

  if (failed > 0) {
    console.log('\n  FAILURES DETECTED — see individual task notes above');
  }
  console.log('══════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
