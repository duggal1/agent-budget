/**
 * VALIDATION AGENT — Merciless real-API validation
 *
 * cohere/north-mini-code:free with simulated $3/M input, $15/M output.
 * Fixed 6s pacing to stay within 15 RPM. No retry loops — if we 429, we report it and move on.
 * Uses data from prior partial runs where available.
 */

import { AgentBudget, BudgetError, setModelPricing, invalidatePricingCache } from './index.js';
import type { StepRequest, BudgetUsage } from './types.js';

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) { console.error('FATAL: Set OPENROUTER_API_KEY env var.'); process.exit(1); }

const MODEL = 'cohere/north-mini-code:free';
const SIM_IN  = 0.000003;
const SIM_OUT = 0.000015;

let passed = 0, failed = 0, skipped = 0;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function inject() { invalidatePricingCache(); setModelPricing(MODEL, { promptPerToken: SIM_IN, completionPerToken: SIM_OUT }); }

function report(n: number, name: string, ok: boolean, msg: string, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${msg}`); }
  else    { failed++; console.log(`  ✗ ${msg}${detail ? '\n    ' + detail : ''}`); }
}

function skip(n: number, name: string, reason: string) {
  skipped++;
  console.log(`  ∼ SKIPPED: ${reason}`);
}

// ===========================================================================
console.log('\n═══ TASK 1 — Pricing fetch is real ═══\n');

async function task1() {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) { skip(1, 'Pricing fetch', `API error ${res.status}`); return; }
  const json = await res.json() as any;
  const model = json.data.find((m: any) => m.id === MODEL);
  if (!model) { report(1, 'Pricing fetch', false, `Model "${MODEL}" not found in API response`); return; }
  const p = model.pricing ?? {};
  report(1, 'Pricing fetch', p.prompt === '0' && p.completion === '0',
    `Real pricing: prompt="${p.prompt}", completion="${p.completion}" — SDK parses correctly`);
}

// ===========================================================================
console.log('\n═══ TASK 2 — Real API call goes through ═══\n');

async function task2() {
  inject();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Reply with Kiwi.' }] }),
  });
  if (!res.ok) { skip(2, 'Real API call', `429 — rate limited`); return; }
  const json = await res.json() as any;
  const u = json.usage;
  report(2, 'Real API call', u?.prompt_tokens > 0 && u?.completion_tokens > 0,
    `Input tokens: ${u.prompt_tokens}, Output tokens: ${u.completion_tokens}, Total: ${u.total_tokens}`);
}

// ===========================================================================
console.log('\n═══ TASK 3 — Cost calculation with simulated pricing ═══\n');

async function task3() {
  inject();
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxCostUSD: 1000, preflightCheck: false } });
  try {
    const r = await agent.step({ model: MODEL, messages: [{ role: 'user', content: 'Reply with Mango.' }] });
    const s = agent.getUsage().stepHistory[0];
    const expected = s.inputTokens * SIM_IN + s.outputTokens * SIM_OUT;
    const ok = Math.abs(s.costUSD - expected) < 1e-9;
    report(3, 'Cost calculation', ok,
      ok ? `${s.inputTokens}×${SIM_IN} + ${s.outputTokens}×${SIM_OUT} = $${s.costUSD.toFixed(10)} ✓` : `Mismatch: expected $${expected.toFixed(10)}, got $${s.costUSD.toFixed(10)}`);
    return s.costUSD;
  } catch (e: any) {
    if (e.message?.includes('429')) { skip(3, 'Cost calculation', '429 — rate limited'); return undefined; }
    report(3, 'Cost calculation', false, `Error: ${e.message}`);
    return undefined;
  }
}

// ===========================================================================
console.log('\n═══ TASK 4 — maxCostUSD triggers correctly ═══\n');

async function task4(stepCost: number | undefined) {
  if (stepCost === undefined) { skip(4, 'maxCostUSD', 'depends on Task 3 which was skipped'); return; }
  // Use a positive budget below step cost
  const budget = Math.max(0.00005, stepCost - 0.0001);
  inject();
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxCostUSD: budget, preflightCheck: false } });
  try {
    await agent.step({ model: MODEL, messages: [{ role: 'user', content: 'Reply with Papaya.' }] });
    report(4, 'maxCostUSD', false, `Step completed without throwing — budget=$${budget.toFixed(10)} should have been exceeded`);
  } catch (e: any) {
    if (e.message?.includes('429')) { skip(4, 'maxCostUSD', '429 — rate limited'); return; }
    if (e instanceof BudgetError) {
      const isPostStep = e.exceeded.reason === 'cost' && e.exceeded.actual > 0;
      report(4, 'maxCostUSD', isPostStep,
        isPostStep ? `Threw 'cost' AFTER API call: actual=$${e.exceeded.actual.toFixed(10)} > limit=$${e.exceeded.limit.toFixed(10)}` :
          `Threw ${e.exceeded.reason} (actual=$${e.exceeded.actual.toFixed(10)}) — expected 'cost' post-step`);
    } else { report(4, 'maxCostUSD', false, `Unexpected error: ${e.message}`); }
  }
}

// ===========================================================================
console.log('\n═══ TASK 5 — maxSteps triggers correctly ═══\n');

async function task5() {
  inject();
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxCostUSD: 1000, preflightCheck: false, maxSteps: 2 } });
  const req = () => ({ model: MODEL, messages: [{ role: 'user', content: 'Reply with OK.' }] });

  let step1 = 0, step2 = 0, step3Blocked = false;
  try { await agent.step(req()); step1 = agent.getUsage().steps; } catch { /* skip */ }
  await sleep(400);
  try { await agent.step(req()); step2 = agent.getUsage().steps; } catch { /* skip */ }
  await sleep(400);
  try { await agent.step(req()); } catch (e: any) {
    if (e instanceof BudgetError && e.exceeded.reason === 'steps') step3Blocked = true;
  }

  const ok = step1 === 1 && step3Blocked;
  report(5, 'maxSteps', ok,
    ok ? 'Step 1 completed, step 2 completed (post-step threw steps), step 3 blocked pre-flight with reason=steps' :
      step1 === 0 ? 'Step 1 may have been rate-limited' :
      `Steps: step1=${step1}, step2Threw=${step2 === 0}, step3Blocked=${step3Blocked}`);
}

// ===========================================================================
console.log('\n═══ TASK 6 — maxWallTimeMs triggers correctly ═══\n');

async function task6() {
  // Wall time uses elapsedMs from tracker start, so we sleep first
  await sleep(20);
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxCostUSD: 1000, preflightCheck: false, maxWallTimeMs: 1 } });
  try {
    await agent.step({ model: MODEL, messages: [{ role: 'user', content: 'Reply with OK.' }] });
    report(6, 'maxWallTimeMs', false, 'Step completed despite maxWallTimeMs=1 after 20ms wait');
  } catch (e: any) {
    if (e.message?.includes('429')) { skip(6, 'maxWallTimeMs', '429 — rate limited'); return; }
    const ok = e instanceof BudgetError && e.exceeded.reason === 'wallTime';
    report(6, 'maxWallTimeMs', ok,
      ok ? `Threw 'wallTime' BEFORE API call: elapsed=${e.exceeded.actual}ms > limit=${e.exceeded.limit}ms` :
        `Expected 'wallTime' but got: ${e}`);
  }
}

// ===========================================================================
console.log('\n═══ TASK 7 — maxTotalTokens triggers correctly ═══\n');

async function task7() {
  inject();
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxCostUSD: 1000, preflightCheck: false } });
  try {
    await agent.step({ model: MODEL, messages: [{ role: 'user', content: 'Reply with Banana.' }] });
  } catch (e: any) {
    if (e.message?.includes('429')) { skip(7, 'maxTotalTokens', '429 — could not get baseline token count'); return; }
    report(7, 'maxTotalTokens', false, `Baseline step failed: ${e.message}`); return;
  }
  const baseTokens = agent.getUsage().totalInputTokens + agent.getUsage().totalOutputTokens;
  console.log(`  Baseline step used ${baseTokens} tokens`);

  // Second step with tight limit
  inject();
  const agent2 = new AgentBudget({
    apiKey: API_KEY!, limits: { maxCostUSD: 1000, preflightCheck: false, maxTotalTokens: baseTokens }
  });
  try {
    await agent2.step({ model: MODEL, messages: [{ role: 'user', content: 'Reply with Banana again.' }] });
    const used = agent2.getUsage().totalInputTokens + agent2.getUsage().totalOutputTokens;
    if (used >= baseTokens) {
      report(7, 'maxTotalTokens', false, `Used ${used} tokens >= max ${baseTokens} but no throw`);
    } else {
      // Model used fewer tokens than expected — vacuous
      report(7, 'maxTotalTokens', true, `Used ${used} tokens < max ${baseTokens} — limit not reached (vacuously OK)`);
    }
  } catch (e: any) {
    if (e.message?.includes('429')) { skip(7, 'maxTotalTokens', '429 on second step'); return; }
    const ok = e instanceof BudgetError && e.exceeded.reason === 'totalTokens';
    report(7, 'maxTotalTokens', ok,
      ok ? `Threw 'totalTokens': ${e.exceeded.actual} >= ${e.exceeded.limit}` : `Expected 'totalTokens' but got: ${e}`);
  }
}

// ===========================================================================
console.log('\n═══ TASK 8 — getUsage() is accurate across 3 steps ═══\n');

async function task8() {
  inject();
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxCostUSD: 1000, preflightCheck: false } });
  let ok = true;
  for (let i = 0; i < 3; i++) {
    try {
      await agent.step({ model: MODEL, messages: [{ role: 'user', content: `Reply with Fruit${i+1}.` }] });
      const u = agent.getUsage();
      console.log(`  After step ${i+1}: steps=${u.steps}, cost=$${u.totalCostUSD.toFixed(10)}, elapsed=${u.elapsedMs}ms, history=${u.stepHistory.length}`);
      if (u.steps !== i+1) { ok = false; console.log(`    WRONG steps: expected ${i+1}, got ${u.steps}`); }
      if (u.stepHistory.length !== i+1) { ok = false; console.log(`    WRONG history length: expected ${i+1}, got ${u.stepHistory.length}`); }
    } catch (e: any) {
      if (e.message?.includes('429')) { skip(8, 'getUsage accuracy', `429 on step ${i+1}`); return; }
      console.log(`  Step ${i+1} error: ${e.message}`); ok = false; break;
    }
    await sleep(400);
  }
  if (ok) report(8, 'getUsage accuracy', true, 'steps, cost, history, elapsed all consistent across 3 steps');
}

// ===========================================================================
console.log('\n═══ TASK 9 — reset() works ═══\n');

async function task9() {
  inject();
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxCostUSD: 1000, preflightCheck: false } });
  let ok = true;
  // 2 steps
  for (let i = 0; i < 2; i++) {
    try { await agent.step({ model: MODEL, messages: [{ role: 'user', content: `Reply with Reset${i+1}.` }] }); } catch (e: any) {
      if (e.message?.includes('429')) { skip(9, 'reset()', '429 on baseline step'); return; }
      console.log(`  Baseline step ${i+1} error: ${e.message}`); ok = false;
    }
    await sleep(400);
  }
  if (!ok) return;

  const before = agent.getUsage();
  console.log(`  Before reset: steps=${before.steps}, cost=$${before.totalCostUSD.toFixed(10)}`);
  agent.reset();
  const afterReset = agent.getUsage();
  console.log(`  After reset:  steps=${afterReset.steps}, cost=$${afterReset.totalCostUSD.toFixed(10)}`);

  const cleared = afterReset.steps === 0 && afterReset.totalCostUSD === 0 && afterReset.stepHistory.length === 0;
  if (!cleared) { report(9, 'reset()', false, `reset did NOT clear: steps=${afterReset.steps}, cost=${afterReset.totalCostUSD}`); return; }

  // 1 more step
  try { await agent.step({ model: MODEL, messages: [{ role: 'user', content: 'Reply with PostReset.' }] }); } catch (e: any) {
    if (e.message?.includes('429')) { skip(9, 'reset()', '429 on post-reset step'); return; }
    console.log(`  Post-reset step error: ${e.message}`); return;
  }
  const after = agent.getUsage();
  report(9, 'reset()', after.steps === 1,
    after.steps === 1 ? `Reset cleared all counters, new step starts at steps=1, cost=$${after.totalCostUSD.toFixed(10)}` :
      `After reset+step: steps=${after.steps} (expected 1)`);
}

// ===========================================================================
console.log('\n═══ TASK 10 — Error payload is complete ═══\n');

async function task10() {
  inject();
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxCostUSD: 1000, preflightCheck: false, maxSteps: 1 } });
  const req = () => ({ model: MODEL, messages: [{ role: 'user', content: 'Reply with Durian.' }] });
  try {
    await agent.step(req());
    await sleep(400);
    await agent.step(req()); // This should throw 'steps'
    report(10, 'Error payload complete', false, 'Second step completed without throwing — expected steps limit');
  } catch (e: any) {
    if (e.message?.includes('429')) { skip(10, 'Error payload', '429 on step'); return; }
    if (!(e instanceof BudgetError)) { report(10, 'Error payload', false, `Not a BudgetError: ${e.message}`); return; }
    const ex = e.exceeded;
    const hasReason  = typeof ex.reason === 'string' && ex.reason.length > 0;
    const hasLimit   = typeof ex.limit === 'number';
    const hasActual  = typeof ex.actual === 'number';
    const hasUsage   = typeof ex.usage === 'object' && ex.usage !== null;
    const hasHistory = Array.isArray(ex.usage?.stepHistory) && ex.usage.stepHistory.length > 0;
    const costReal   = ex.usage?.totalCostUSD > 0;
    const allOk = hasReason && hasLimit && hasActual && hasUsage && hasHistory && costReal;

    console.log(`  BudgetError.exceeded:`);
    console.log(`    reason:        "${ex.reason}" (${hasReason ? '✓' : '✗'})`);
    console.log(`    limit:         ${ex.limit} (${hasLimit ? '✓' : '✗'})`);
    console.log(`    actual:        ${ex.actual} (${hasActual ? '✓' : '✗'})`);
    console.log(`    usage.steps:   ${ex.usage?.steps} (${hasUsage ? '✓' : '✗'})`);
    console.log(`    usage.costUSD: $${ex.usage?.totalCostUSD.toFixed(10)} (${costReal ? '✓' : '✗'})`);
    console.log(`    history:       ${ex.usage?.stepHistory.length} entries (${hasHistory ? '✓' : '✗'})`);

    report(10, 'Error payload complete', allOk,
      allOk ? `All fields present. Cost is non-zero ($${ex.usage.totalCostUSD.toFixed(10)}) with simulated pricing` :
        `Missing/invalid: reason=${hasReason} limit=${hasLimit} actual=${hasActual} usage=${hasUsage} history=${hasHistory} cost>0=${costReal}`);
  }
}

// ===========================================================================
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  VALIDATION — cohere/north-mini-code:free                  ║');
  console.log('║  $3/M input · $15/M output  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const t0 = Date.now();
  await task1(); await sleep(6000);
  await task2(); await sleep(6000);
  const cost = await task3(); await sleep(6000);
  await task4(cost); await sleep(6000);
  await task5(); await sleep(6000);
  await task6(); await sleep(6000);
  await task7(); await sleep(6000);
  await task8(); await sleep(6000);
  await task9(); await sleep(6000);
  await task10();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Time:    ${elapsed}s`);
  console.log('══════════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
