import { AgentBudget, BudgetError } from './index.js';
import type { AgentBudgetEvent, StepRequest } from './index.js';
import { setModelPricing, invalidatePricingCache } from './pricing.js';

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error('Set OPENROUTER_API_KEY env var before running this test.');
  process.exit(1);
}

const MODEL = 'cohere/north-mini-code:free';

// ─── Event collector ─────────────────────────────────────────────────────────

const collected: Array<{ ts: string; event: AgentBudgetEvent }> = [];
const expectedEvents = new Set<string>();
const seenEvents = new Set<string>();

function onEvent(event: AgentBudgetEvent) {
  const ts = new Date().toISOString();
  collected.push({ ts, event });
  seenEvents.add(event.type);
  console.log(`[${ts}] ${event.type} — ${JSON.stringify(event)}`);
}

// ─── Test 1: Basic event emission ────────────────────────────────────────────

async function testBasicEvents() {
  console.log('=== TEST 1: Basic event emission ===\n');

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxCostUSD: 1.0,
      maxSteps: 4,
    },
    onEvent,
  });

  expectedEvents.add('step:start');
  expectedEvents.add('step:end');
  expectedEvents.add('pricing:fetched');

  const request: StepRequest = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Reply with a short sentence about AI.' },
    ],
  };

  for (let i = 0; i < 3; i++) {
    const response = await agent.step(request);
    request.messages.push({ role: 'assistant', content: response.choices[0]?.message?.content ?? '' });
    request.messages.push({ role: 'user', content: `Follow up thought ${i + 1}: what else is interesting?` });
  }

  const missing = [...expectedEvents].filter((e) => !seenEvents.has(e));
  if (missing.length > 0) {
    console.error(`FAIL: Expected events not seen: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nPASS: All required events (${[...expectedEvents].join(', ')}) fired.\n`);
}

// ─── Test 2: budget:warning with low threshold ───────────────────────────────

async function testBudgetWarning() {
  console.log('=== TEST 2: budget:warning on low threshold ===\n');

  const warningEvents = new Set<string>();
  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxCostUSD: 0.01,      // small budget so step cost triggers warning
      maxSteps: 2,
    },
    warningThreshold: 0.001,  // absurdly low — warning fires on any cost
    onEvent: (event) => {
      const ts = new Date().toISOString();
      console.log(`[${ts}] ${event.type} — ${JSON.stringify(event)}`);
      if (event.type === 'budget:warning') {
        warningEvents.add(event.type);
      }
    },
  });

  const request: StepRequest = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Reply with one word: hello' },
    ],
  };

  try {
    await agent.step(request);
  } catch (err) {
    if (err instanceof BudgetError) {
      console.log(`\nBudgetError caught (expected): ${err.message}`);
    } else {
      throw err;
    }
  }

  if (warningEvents.has('budget:warning')) {
    console.log('PASS: budget:warning event fired.\n');
  } else {
    console.error('FAIL: budget:warning event did not fire.');
    process.exit(1);
  }
}

// ─── Test 3: on/off typed listener ───────────────────────────────────────────

async function testTypedListeners() {
  console.log('=== TEST 3: Typed on/off listener methods ===\n');

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxCostUSD: 1.0,
    },
  });

  let stepStartFired = false;

  const handler = () => { stepStartFired = true; };
  agent.on('step:start', handler);

  await agent.step({
    model: MODEL,
    messages: [{ role: 'user', content: 'Say OK.' }],
  });

  if (!stepStartFired) {
    console.error('FAIL: step:start listener via on() did not fire.');
    process.exit(1);
  }
  console.log('PASS: step:start listener via on() fired correctly.');

  // Test off()
  stepStartFired = false;
  agent.off('step:start', handler);

  await agent.step({
    model: MODEL,
    messages: [{ role: 'user', content: 'Say OK again.' }],
  });

  if (stepStartFired) {
    console.error('FAIL: step:start listener still fired after off().');
    process.exit(1);
  }
  console.log('PASS: step:start listener correctly removed via off().\n');
}

// ─── Test 4: Cost-based events with simulated expensive pricing ──────────────
//
// Seeds the pricing cache with expensive rates ($3/input, $30/output) so that
// the free model's API calls produce realistic cost telemetry without burning
// real money. This is the "0% mock-up" approach: real API calls + real pricing
// data piped through the same code paths a paid model would follow.

async function testCostSimulation() {
  console.log('=== TEST 4: Cost-based events with simulated pricing ===\n');

  // Seed expensive pricing before any AgentBudget instance touches pricing
  invalidatePricingCache();
  setModelPricing(MODEL, { promptPerToken: 3, completionPerToken: 30 });

  const costEvents: AgentBudgetEvent[] = [];
  const costAgent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxCostUSD: 100000,   // high enough to let the step through
      preflightCheck: true,
    },
    warningThreshold: 0.001, // fire budget:warning on any non-zero cost
    onEvent: (event) => {
      const ts = new Date().toISOString();
      costEvents.push(event);
      console.log(`[${ts}] ${event.type} — ${JSON.stringify(event)}`);
    },
  });

  const request: StepRequest = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Reply with a 10-word sentence about machine learning.' },
    ],
  };

  // Sub-test A: step completes, events fire with simulated cost
  const response = await costAgent.step(request);
  const usage = costAgent.getUsage();

  console.log(`\n  Model: ${response.model}`);
  console.log(`  Real input tokens: ${response.usage?.prompt_tokens ?? '?'}`);
  console.log(`  Real output tokens: ${response.usage?.completion_tokens ?? '?'}`);
  console.log(`  Simulated costUSD: $${usage.totalCostUSD.toFixed(4)}`);
  console.log(`  (${(response.usage?.prompt_tokens ?? 0) * 3} input + ${(response.usage?.completion_tokens ?? 0) * 30} output)\n`);

  const stepEnds = costEvents.filter(e => e.type === 'step:end') as Array<AgentBudgetEvent & { type: 'step:end' }>;
  const budgetWarnings = costEvents.filter(e => e.type === 'budget:warning');
  const stepStarts = costEvents.filter(e => e.type === 'step:start');

  if (stepStarts.length === 0) {
    console.error('FAIL: step:start did not fire in cost simulation.');
    process.exit(1);
  }
  console.log('PASS: step:start fired.');

  if (stepEnds.length === 0) {
    console.error('FAIL: step:end did not fire in cost simulation.');
    process.exit(1);
  }
  console.log(`PASS: step:end fired — simulated costUSD: $${stepEnds[0].costUSD.toFixed(4)}`);

  if (stepEnds[0].costUSD === 0) {
    console.error('FAIL: step:end costUSD is 0 — pricing simulation did not take effect.');
    process.exit(1);
  }
  console.log('PASS: step:end costUSD reflects simulated pricing (non-zero).');

  // Sub-test B: budget:warning fires for cost (not just steps)
  const costWarnings = budgetWarnings.filter(e => e.reason === 'cost');
  if (costWarnings.length === 0) {
    console.error('FAIL: budget:warning for cost did not fire.');
    process.exit(1);
  }
  console.log(`PASS: budget:warning for cost fired (pctConsumed: ${(costWarnings[0] as { pctConsumed: number }).pctConsumed.toFixed(6)}).\n`);

  // Sub-test C: pre-flight blocks with tight budget
  console.log('  --- Sub-test C: Pre-flight blocks with tight budget ---\n');

  invalidatePricingCache();
  setModelPricing(MODEL, { promptPerToken: 3, completionPerToken: 30 });

  const preflightEvents: AgentBudgetEvent[] = [];
  const tightAgent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxCostUSD: 50,        // far below the estimated $15k+ for a single step
      preflightCheck: true,
    },
    onEvent: (event) => {
      const ts = new Date().toISOString();
      preflightEvents.push(event);
      console.log(`[${ts}] ${event.type} — ${JSON.stringify(event)}`);
    },
  });

  const bigRequest: StepRequest = {
    model: MODEL,
    messages: [
      { role: 'user', content: Array.from({ length: 200 }, (_, i) => `Sentence ${i + 1}: The quick brown fox jumps over the lazy dog near the riverbank.`).join(' ') },
    ],
  };

  try {
    await tightAgent.step(bigRequest);
    console.error('FAIL: Expected BudgetError for preflight check.');
    process.exit(1);
  } catch (err) {
    if (err instanceof BudgetError && err.exceeded.reason === 'preflightCostEstimate') {
      console.log(`\n  BudgetError reason: ${err.exceeded.reason}`);
      console.log(`  Estimated cost:    $${(err.exceeded.estimatedCost ?? 0).toFixed(4)}`);
      console.log(`  Remaining budget:  $${(err.exceeded.remainingBudget ?? 0).toFixed(4)}`);
      console.log(`  Message: ${err.message}`);
    } else {
      console.error('FAIL: Wrong error type or reason:', err);
      process.exit(1);
    }

    const exceededEvent = preflightEvents.find(e => e.type === 'budget:exceeded');
    if (!exceededEvent) {
      console.error('FAIL: budget:exceeded did not fire before pre-flight throw.');
      process.exit(1);
    }
    const bExceeded = exceededEvent as AgentBudgetEvent & { type: 'budget:exceeded' };
    if (bExceeded.exceeded.reason !== 'preflightCostEstimate') {
      console.error(`FAIL: budget:exceeded reason is ${bExceeded.exceeded.reason}, expected preflightCostEstimate.`);
      process.exit(1);
    }
    console.log('PASS: budget:exceeded fired with reason preflightCostEstimate before API call.\n');
  }
}

async function main() {
  await testBasicEvents();
  await testBudgetWarning();
  await testTypedListeners();
  await testCostSimulation();
  console.log('All event emission tests passed.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
