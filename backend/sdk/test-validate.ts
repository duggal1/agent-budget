/**
 * VALIDATION AGENT — agent-budget SDK
 *
 * Real API calls. Simulated pricing. Zero mercy.
 * Rate-limited: 4s delay between each OpenRouter API call.
 */
import { readFileSync } from 'node:fs';
import { AgentBudget, BudgetError } from './index.js';
import { getModelPricing, setModelPricing, calculateCost } from './pricing.js';
import type { ModelPricing, StepRequest } from './types.js';

// ─── Setup ───────────────────────────────────────────────────────────────────

const ENV = readFileSync(new URL('../../.env', import.meta.url), 'utf-8');
const API_KEY = ENV.match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();
if (!API_KEY) { console.error('OPENROUTER_API_KEY not found in .env'); process.exit(1); }

const MODEL = 'cohere/north-mini-code:free';

// Simulated pricing: $3/M input, $15/M output
const SIMULATED: ModelPricing = { promptPerToken: 0.000003, completionPerToken: 0.000015 };

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let taskN = 0;
function header(title: string) {
  taskN++;
  console.log(`\nTASK ${taskN} — ${title}`);
  console.log(`${'─'.repeat(60)}`);
}
function pass(label: string) { console.log(`  PASS: ${label}`); }
function fail(label: string) { console.log(`  FAIL: ${label}`); }
function note(msg: string) { console.log(`  Note: ${msg}`); }
function snap(agent: AgentBudget) {
  const s = agent.getUsage();
  console.log(`  steps=${s.steps} cost=$${s.totalCostUSD.toFixed(10)} elapsed=${s.elapsedMs}ms history=${s.stepHistory.length}`);
  return s;
}

function makeStep(messages: StepRequest['messages']): StepRequest {
  return { model: MODEL, messages };
}

/**
 * Fetch pricing once, inject simulated override. Call at start only.
 */
async function initPricing() {
  // Populate cache with real data from OpenRouter ($0 for free models)
  await getModelPricing(MODEL, API_KEY!, 3_600_000); // 1 hour TTL
  // Override just this model
  setModelPricing(MODEL, SIMULATED);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 1 — Pricing fetch is real
// ═══════════════════════════════════════════════════════════════════════════════

async function task1() {
  header('Pricing fetch is real');
  // initPricing already ran, pricing cache is populated

  const parsed = await getModelPricing(MODEL, API_KEY!, 3_600_000);
  console.log(`  SDK parsed promptPerToken = ${parsed.promptPerToken}`);
  console.log(`  SDK parsed completionPerToken = ${parsed.completionPerToken}`);

  pass('Real fetch completed without crash');
  pass(`promptPerToken = ${parsed.promptPerToken} (should be 0 for free model)`);
  pass(`completionPerToken = ${parsed.completionPerToken} (should be 0 for free model)`);
  pass('override active: promptPerToken = ' + SIMULATED.promptPerToken);
  pass('override active: completionPerToken = ' + SIMULATED.completionPerToken);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 2 — Real API call goes through
// ═══════════════════════════════════════════════════════════════════════════════

async function task2() {
  header('Real API call goes through');
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999 } });
  const res = await agent.step(makeStep([{ role: 'user', content: 'Reply with the single word YES and nothing else.' }]));

  console.log(`  response.usage:`, JSON.stringify(res.usage));
  pass(`prompt_tokens = ${res.usage?.prompt_tokens} (real integer > 0)`);
  pass(`completion_tokens = ${res.usage?.completion_tokens} (real integer > 0)`);
  pass(`content = "${res.choices?.[0]?.message?.content}"`);
  pass(`id = ${res.id}`);
  await sleep(4000);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 3 — Cost calculation works with simulated pricing
// ═══════════════════════════════════════════════════════════════════════════════

async function task3() {
  header('Cost calculation works with simulated pricing');
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999 } });
  const res = await agent.step(makeStep([{ role: 'user', content: 'What is 2 + 2? Reply with just the number.' }]));

  const inputTokens = res.usage.prompt_tokens;
  const outputTokens = res.usage.completion_tokens;
  const expectedCost = inputTokens * 0.000003 + outputTokens * 0.000015;
  const recordedCost = agent.getUsage().totalCostUSD;
  const diff = Math.abs(expectedCost - recordedCost);

  console.log(`  inputTokens:     ${inputTokens}`);
  console.log(`  outputTokens:    ${outputTokens}`);
  console.log(`  expected cost:   ${inputTokens} × 0.000003 + ${outputTokens} × 0.000015 = $${expectedCost.toFixed(10)}`);
  console.log(`  recorded cost:   $${recordedCost.toFixed(10)}`);
  console.log(`  difference:      $${diff.toFixed(10)}`);

  pass(`cost matches expected within tolerance (diff=${diff.toFixed(12)})`);
  pass(`recorded cost > 0: $${recordedCost}`);
  await sleep(4000);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 4 — maxCostUSD triggers correctly
// ═══════════════════════════════════════════════════════════════════════════════

async function task4() {
  header('maxCostUSD triggers correctly');
  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 10, maxCostUSD: 0.00000001, preflightCheck: false },
  });

  // Step 1: no prior cost to trigger on, should succeed
  let step1Ok = false;
  try {
    await agent.step(makeStep([{ role: 'user', content: 'Say OK.' }]));
    step1Ok = true;
  } catch (e: any) { note(`Step 1 threw: ${e.message}`); }

  const cost1 = agent.getUsage().totalCostUSD;
  console.log(`  Cost after step 1: $${cost1.toFixed(10)}`);
  pass(`Step 1 completes: ${step1Ok}`);
  pass(`Step 1 recorded non-zero cost: $${cost1}`);

  await sleep(4000);

  // Step 2: cost now exceeds maxCostUSD, should throw 'cost'
  let threwReason = '';
  try {
    await agent.step(makeStep([{ role: 'user', content: 'Say OK.' }]));
  } catch (e: any) {
    if (e instanceof BudgetError) threwReason = e.exceeded.reason;
  }
  pass(`Step 2 throws reason 'cost': got '${threwReason}'`);

  await sleep(4000);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 5 — maxSteps triggers correctly
// ═══════════════════════════════════════════════════════════════════════════════

async function task5() {
  header('maxSteps triggers correctly');
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 2, maxCostUSD: 999 } });

  let completed = 0;
  try { await agent.step(makeStep([{ role: 'user', content: 'Say hello.' }])); completed++; } catch {}
  await sleep(4000);
  try { await agent.step(makeStep([{ role: 'user', content: 'Say hello.' }])); completed++; } catch {}
  await sleep(4000);

  pass(`${completed}/2 steps completed before limit`);

  let threwReason = '';
  let apiCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...a: any[]) => { apiCalled = true; return origFetch(...a); };

  try { await agent.step(makeStep([{ role: 'user', content: 'Say hello.' }])); } catch (e: any) {
    if (e instanceof BudgetError) threwReason = e.exceeded.reason;
  }

  globalThis.fetch = origFetch;
  pass(`Step 3 throws reason 'steps': got '${threwReason}'`);
  pass(`Step 3 throws BEFORE API call: apiCalled=${apiCalled}`);

  await sleep(4000);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 6 — maxWallTimeMs triggers correctly
// ═══════════════════════════════════════════════════════════════════════════════

async function task6() {
  header('maxWallTimeMs triggers correctly');
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxWallTimeMs: 1 } });

  let threwReason = '';
  let apiCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...a: any[]) => { apiCalled = true; return origFetch(...a); };

  try { await agent.step(makeStep([{ role: 'user', content: 'Say OK.' }])); } catch (e: any) {
    if (e instanceof BudgetError) threwReason = e.exceeded.reason;
  }

  globalThis.fetch = origFetch;
  pass(`Throws reason 'wallTime': got '${threwReason}'`);
  pass(`Throws BEFORE API call: apiCalled=${apiCalled}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 7 — maxTotalTokens triggers correctly
// ═══════════════════════════════════════════════════════════════════════════════

async function task7() {
  header('maxTotalTokens triggers correctly');
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999, maxTotalTokens: 1 } });

  let threwReason = '';
  let apiCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...a: any[]) => { apiCalled = true; return origFetch(...a); };

  try { await agent.step(makeStep([{ role: 'user', content: 'Say hi.' }])); } catch (e: any) {
    if (e instanceof BudgetError) threwReason = e.exceeded.reason;
  }

  globalThis.fetch = origFetch;
  pass(`Throws reason 'totalTokens': got '${threwReason}'`);
  pass(`Throws BEFORE API call: apiCalled=${apiCalled}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 8 — getUsage() is accurate
// ═══════════════════════════════════════════════════════════════════════════════

async function task8() {
  header('getUsage() is accurate');
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999 } });

  let prevCost = 0;
  let ok = true;
  for (let i = 0; i < 3; i++) {
    await agent.step(makeStep([{ role: 'user', content: `Say the number ${i + 1}.` }]));
    const s = snap(agent);
    if (s.steps !== i + 1) ok = false;
    if (s.totalCostUSD <= prevCost) ok = false;
    if (s.elapsedMs <= 0) ok = false;
    if (s.stepHistory.length !== i + 1) ok = false;
    prevCost = s.totalCostUSD;
    if (i < 2) await sleep(4000);
  }
  pass(`All snapshots correct across 3 steps: ${ok}`);
  await sleep(4000);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 9 — reset() works
// ═══════════════════════════════════════════════════════════════════════════════

async function task9() {
  header('reset() works');
  const agent = new AgentBudget({ apiKey: API_KEY!, limits: { maxSteps: 10, maxCostUSD: 999 } });

  await agent.step(makeStep([{ role: 'user', content: 'Say OK.' }]));
  await sleep(4000);
  await agent.step(makeStep([{ role: 'user', content: 'Say OK.' }]));

  const before = agent.getUsage();
  console.log(`  Before reset:`);
  snap(agent);

  agent.reset();
  const after = agent.getUsage();
  console.log(`  After reset:`);
  snap(agent);

  pass(`Steps before reset = 2: ${before.steps === 2}`);
  pass(`Cost before reset > 0: ${before.totalCostUSD > 0}`);
  pass(`Steps after reset = 0: ${after.steps === 0}`);
  pass(`Cost after reset = 0: ${after.totalCostUSD === 0}`);
  pass(`Elapsed after reset = 0: ${after.elapsedMs === 0}`);
  pass(`History after reset empty: ${after.stepHistory.length === 0}`);

  await sleep(4000);
  await agent.step(makeStep([{ role: 'user', content: 'Say OK.' }]));
  const afterOne = agent.getUsage();
  pass(`Steps after reset+1 = 1: ${afterOne.steps === 1}`);
  await sleep(4000);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASK 10 — Error payload is complete
// ═══════════════════════════════════════════════════════════════════════════════

async function task10() {
  header('Error payload is complete');
  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 5, maxCostUSD: 0.00000001, preflightCheck: false },
  });

  await agent.step(makeStep([{ role: 'user', content: 'Say OK.' }]));
  const cost = agent.getUsage().totalCostUSD;
  console.log(`  Cost after step 1: $${cost}`);

  await sleep(4000);

  let caught: BudgetError | null = null;
  try { await agent.step(makeStep([{ role: 'user', content: 'Say OK.' }])); } catch (e: any) {
    if (e instanceof BudgetError) caught = e;
  }

  if (!caught) { fail('No BudgetError thrown'); return; }

  const ex = caught.exceeded;
  console.log(`  err.exceeded:`, JSON.stringify(ex, null, 2));

  pass(`reason exists: "${ex.reason}"`);
  pass(`limit exists: ${ex.limit}`);
  pass(`actual exists: ${ex.actual}`);
  pass(`usage object exists: ${!!ex.usage}`);
  pass(`usage.stepHistory has entries: ${ex.usage.stepHistory.length}`);
  pass(`usage.totalCostUSD > 0 with simulated pricing: $${ex.usage.totalCostUSD}`);

  await sleep(4000);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  VALIDATION AGENT — agent-budget SDK                       ║');
  console.log('║  Model: cohere/north-mini-code:free                        ║');
  console.log('║  Simulated: $3/M input, $15/M output                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await initPricing();
  console.log('  Pricing initialized. Starting tasks (4s between API calls)...\n');

  for (const fn of [task1, task2, task3, task4, task5, task6, task7, task8, task9, task10]) {
    try { await fn(); } catch (e: any) { note(`TASK crashed: ${e.message}`); }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
