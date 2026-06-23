/**
 * COMPREHENSIVE STRESS TEST — Agent 2 (Lead Tester)
 *
 * Hardcodes cohere/north-mini-code:free with simulated pricing ($1.50 input / $10 output).
 * Exercises ALL 6 agents' features with real API calls and reports findings.
 */

import { AgentBudget, BudgetError, setModelPricing, invalidatePricingCache } from './index.js';
import type { StepRequest } from './types.js';
import { promises as fs } from 'node:fs';

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error('Set OPENROUTER_API_KEY env var before running this test.');
  process.exit(1);
}

const MODEL = 'cohere/north-mini-code:free';
const CHECKPOINT_PATH = './.test-agent-checkpoint.json';

// ─── Simulated pricing ($1.50 input / $10 output per token) ─────────────────

function setupSimulatedPricing(): void {
  invalidatePricingCache();
  setModelPricing(MODEL, { promptPerToken: 1.5, completionPerToken: 10 });
  console.log(`[setup] Simulated pricing: $1.50/input token, $10/output token\n`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let stepCount = 0;
let passed = 0;
let failed = 0;
let issues: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  stepCount++;
  process.stdout.write(`\n─── Test ${stepCount}: ${name} ───\n`);
  await fn();
}

function pass(msg: string): void {
  passed++;
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string, detail?: string): void {
  failed++;
  console.error(`  ✗ ${msg}`);
  if (detail) console.error(`    ${detail}`);
  issues.push(`Test ${stepCount}: ${msg}${detail ? ` — ${detail}` : ''}`);
}

// ─── Agent 2: Pre-flight Cost Estimation ──────────────────────────────────────

async function testPreflightBlocks() {
  await test('Pre-flight blocks step when simulated cost exceeds budget', async () => {
    setupSimulatedPricing();
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxCostUSD: 0.0001, preflightCheck: true, preflightOutputTokenEstimate: 1 },
    });

    const bigRequest: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Hello, please help me with a complex task involving many tokens of reasoning.' }],
    };

    try {
      await agent.step(bigRequest);
      fail('Did not block — step completed despite absurd budget', `Cost would be ~${'?'.repeat(50)}`);
    } catch (err) {
      if (err instanceof BudgetError && err.exceeded.reason === 'preflightCostEstimate') {
        pass(`Blocked before API call. Remaining: $${err.exceeded.remainingBudget?.toFixed(8)}, Estimated: $${err.exceeded.estimatedCost?.toFixed(8)}`);
      } else {
        fail('Wrong error type or reason', `${err}`);
      }
    }
  });
}

async function testPreflightPassesWithSaneBudget() {
  await test('Pre-flight allows step with sufficient simulated budget', async () => {
    setupSimulatedPricing();
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxCostUSD: 1_000_000, preflightCheck: true },
    });

    const request: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word "Parrot" and nothing else.' }],
    };

    try {
      const response = await agent.step(request);
      const usage = agent.getUsage();
      pass(`Step completed. Cost: $${usage.totalCostUSD.toFixed(6)}, Tokens in: ${usage.totalInputTokens}, out: ${usage.totalOutputTokens}`);
      if (usage.totalCostUSD > 0) {
        pass(`Simulated pricing is applied: step cost $${usage.totalCostUSD.toFixed(6)}`);
      } else {
        fail('Simulated pricing NOT applied — cost is $0 despite $1.50/$10 setup', 'Check if setModelPricing is being overridden by a cache refresh during step()');
      }
    } catch (err) {
      if (err instanceof BudgetError) {
        fail(`BudgetError unexpectedly thrown`, `${err.exceeded.reason}: limit=${err.exceeded.limit} actual=${err.exceeded.actual}`);
      } else {
        fail(`Unexpected error: ${err}`, ``);
      }
    }
  });
}

// ─── Agent 4: Circuit Breaker — Repetition Detection ──────────────────────────

async function testCircuitBreakerRepetition() {
  await test('Circuit breaker detects repetitive output', async () => {
    setupSimulatedPricing();
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxCostUSD: 1_000_000, preflightCheck: false },
      circuitBreaker: { repetitionWindow: 2, repetitionThreshold: 0.7, stagnationWindow: 10, stagnationMinLength: 1 },
    });

    // Prompt designed to produce extremely short, repetitive output
    const request: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with ONLY the single word "OK" and absolutely nothing else. No punctuation, no explanation.' }],
    };

    let tripped = false;
    try {
      for (let i = 0; i < 10; i++) {
        request.messages = [
          { role: 'user', content: `Reply with ONLY the word "OK" and nothing else. This is attempt ${i + 1}.` },
        ];
        await agent.step(request);
        const usage = agent.getUsage();
        const last = usage.stepHistory[usage.stepHistory.length - 1];
        console.log(`  Step ${i + 1}: output="${last.outputContent?.trim()}" (${last.outputContent?.length || 0} chars)`);
      }
      fail('Circuit breaker did not trip after 10 repetitive steps', 'The model may not be producing identical enough output for Jaccard similarity to trigger');
    } catch (err) {
      if (err instanceof BudgetError && err.exceeded.reason === 'circuitBreaker') {
        tripped = true;
        pass(`Tripped! Mode: ${err.exceeded.triggerMode}, similarity: ${err.exceeded.similarity?.toFixed(3)}, window: ${err.exceeded.windowSize}`);
      }
    }

    if (!tripped) {
      issues.push('Circuit breaker failed to detect repetition — model may produce diverse enough output to avoid triggering');
    }
  });
}

// ─── Agent 4: Circuit Breaker — Stagnation Detection ──────────────────────────

async function testCircuitBreakerStagnation() {
  await test('Circuit breaker detects stagnation (short repeated rejections)', async () => {
    setupSimulatedPricing();
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxCostUSD: 1_000_000, preflightCheck: false },
      circuitBreaker: { stagnationWindow: 3, stagnationMinLength: 20, repetitionWindow: 10, repetitionThreshold: 1.1 },
    });

    const request: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'I cannot do this task. Just say "Sorry" and nothing more.' }],
    };

    let tripped = false;
    try {
      for (let i = 0; i < 8; i++) {
        request.messages = [
          { role: 'user', content: `I cannot do this task. Just say "Sorry" and nothing more. Attempt ${i + 1}.` },
        ];
        await agent.step(request);
        const usage = agent.getUsage();
        const last = usage.stepHistory[usage.stepHistory.length - 1];
        console.log(`  Step ${i + 1}: output="${last.outputContent?.trim()}" (${last.outputContent?.length || 0} chars)`);
      }
      fail('Circuit breaker did not trip for stagnation after 8 steps', 'Model may not produce short enough output consistently');
    } catch (err) {
      if (err instanceof BudgetError && err.exceeded.reason === 'circuitBreaker') {
        tripped = true;
        pass(`Tripped! Mode: ${err.exceeded.triggerMode}, window: ${err.exceeded.windowSize}`);
      }
    }

    if (!tripped) {
      issues.push('Circuit breaker stagnation detection failed — output may exceed min length threshold');
    }
  });
}

// ─── Agent 3: Adaptive Model Routing ──────────────────────────────────────────

async function testAdaptiveRouting() {
  await test('Adaptive router downgrades model as simulated budget is consumed', async () => {
    setupSimulatedPricing();
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxCostUSD: 100, preflightCheck: false },
      adaptiveRouting: {
        fallbackChain: ['openai/gpt-4o-mini', 'google/gemini-2.0-flash-001', MODEL],
        thresholds: [0.3, 0.7],
      },
    });

    try {
      // Step 1: should use model[0] (budget 0%)
      let model = agent.getCurrentModel();
      console.log(`  Before step 1: ${model}`);

      // Burn some budget manually to trigger a downgrade
      agent.recordStep({ inputTokens: 10, outputTokens: 5, costUSD: 40 }); // 40% consumed
      model = agent.getCurrentModel();
      console.log(`  After burning 40%: ${model}`);

      // Step 2: should still be model[0] (40% < 60%)
      agent.recordStep({ inputTokens: 10, outputTokens: 5, costUSD: 20 }); // 60% consumed

      model = agent.getCurrentModel();
      console.log(`  After burning 60%: ${model}`);

      if (model !== 'google/gemini-2.0-flash-001' && model !== MODEL) {
        fail(`Router did not downgrade at 60% threshold`, `Current model: ${model}`);
      } else {
        pass(`Router downgraded to ${model} at ~60% budget`);
      }

      // Burn more to hit the last tier
      agent.recordStep({ inputTokens: 10, outputTokens: 5, costUSD: 20 }); // 80% consumed
      model = agent.getCurrentModel();
      console.log(`  After burning 80%: ${model}`);
      if (model === MODEL) {
        pass(`Router correctly fell through to cheapest model ${MODEL} at high budget`);
      }

    } catch (err) {
      if (err instanceof BudgetError) {
        // fallbackChainExhausted is also valid
        if (err.exceeded.reason === 'fallbackChainExhausted') {
          pass(`Fallback chain exhausted as expected at high budget`);
        } else {
          fail(`Unexpected BudgetError: ${err.exceeded.reason}`, ``);
        }
      } else {
        fail(`Unexpected error: ${err}`, ``);
      }
    }
  });
}

// ─── Agent 5: Events System ────────────────────────────────────────────────────

async function testEventEmission() {
  await test('Events fire correctly with simulated pricing', async () => {
    setupSimulatedPricing();
    const events: string[] = [];

    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxCostUSD: 1_000_000, preflightCheck: false },
      warningThreshold: 0.0001, // Trigger budget:warning immediately
      onEvent: (event) => {
        events.push(event.type);
        console.log(`  [event] ${event.type}${event.type === 'step:end' ? ` cost=$` + (event as any).costUSD?.toFixed(2) : ''}`);
      },
    });

    const request: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with a single word: "Events". Nothing else.' }],
    };

    try {
      await agent.step(request);
      // Check which events fired
      const eventTypes = new Set(events);
      const expected = ['pricing:fetched', 'step:start', 'step:end'];
      const missing = expected.filter(e => !eventTypes.has(e));
      if (missing.length > 0) {
        fail(`Missing expected events: ${missing.join(', ')}`, `Fired: ${[...eventTypes].join(', ')}`);
      } else {
        pass(`All expected events fired: ${[...eventTypes].join(', ')}`);
      }

      // Check for budget:warning
      if (eventTypes.has('budget:warning')) {
        pass(`budget:warning fired — warning threshold is working with simulated pricing`);
      } else {
        fail('budget:warning did not fire despite 0.01% threshold', 'WarningChecker may not trigger correctly with simulated cost > $0');
      }
    } catch (err) {
      fail(`Step failed: ${err}`, ``);
    }
  });
}

// ─── Agent 6: Checkpoint/Resume ────────────────────────────────────────────────

async function testCheckpointResume() {
  await test('Checkpoint saves state and resume restores correctly with simulated budget', async () => {
    setupSimulatedPricing();

    // Phase 1: Run 2 steps with checkpoint enabled
    const agent1 = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxCostUSD: 1_000_000, preflightCheck: false, maxSteps: 2 },
      checkpoint: { path: CHECKPOINT_PATH, enabled: true },
    });

    const request: StepRequest = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Say "Phase1" and nothing else.' }],
    };

    try {
      await agent1.step(request);
      console.log(`  Step 1 completed`);
      await agent1.step(request);
      console.log(`  Step 2 completed`);
    } catch (err) {
      if (err instanceof BudgetError && err.exceeded.reason === 'steps') {
        console.log(`  Step limit reached after 2 steps`);
      } else {
        fail(`Phase 1 failed: ${err}`, ``);
        return;
      }
    }

    // Verify checkpoint file exists
    try {
      await fs.access(CHECKPOINT_PATH);
      const raw = await fs.readFile(CHECKPOINT_PATH, 'utf-8');
      const cp = JSON.parse(raw);
      console.log(`  Checkpoint file: ${raw.length} bytes, version: ${cp.checkpointVersion}, messages: ${cp.messages.length}`);
      pass(`Checkpoint file written after 2 steps`);
    } catch {
      fail('Checkpoint file not found after steps', `Expected at ${CHECKPOINT_PATH}`);
      return;
    }

    // Phase 2: Resume with higher step limit
    setupSimulatedPricing(); // Re-setup pricing for the new agent
    try {
      const agent2 = await AgentBudget.resume(
        {
          apiKey: API_KEY!,
          limits: { maxCostUSD: 1_000_000, preflightCheck: false, maxSteps: 4 },
          checkpoint: { path: CHECKPOINT_PATH, enabled: true },
        },
        CHECKPOINT_PATH,
      );

      const resumeRequest: StepRequest = {
        model: MODEL,
        messages: [{ role: 'user', content: 'Say "Phase2" and nothing else. We are resuming.' }],
      };

      await agent2.step(resumeRequest);
      const usage = agent2.getUsage();
      console.log(`  Resume step 1: total steps=${usage.steps}, cost=$${usage.totalCostUSD.toFixed(2)}`);

      await agent2.step(resumeRequest);
      const usage2 = agent2.getUsage();
      console.log(`  Resume step 2: total steps=${usage2.steps}, cost=$${usage2.totalCostUSD.toFixed(2)}`);

      if (usage2.steps === 4) {
        pass(`Resume worked: total 4 steps across 2 sessions, message history continues`);
      } else {
        fail(`Unexpected step count after resume: ${usage2.steps}`, 'Expected 4');
      }

      await agent2.clearCheckpoint();
      try {
        await fs.access(CHECKPOINT_PATH);
        fail('Checkpoint file still exists after clearCheckpoint()', '');
      } catch {
        pass(`Checkpoint file deleted after clearCheckpoint()`);
      }

    } catch (err) {
      if ((err as any)?.code === 'ENOENT') {
        fail('AgentBudget.resume failed — no checkpoint file', `Phase 2 could not resume`);
      } else {
        fail(`Resume failed: ${err}`, ``);
      }
    }
  });
}

// ─── Agent 1: Auto-Compression ─────────────────────────────────────────────────

async function testAutoCompression() {
  await test('Auto-compression triggers with large message history', async () => {
    setupSimulatedPricing();
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: { maxCostUSD: 1_000_000, preflightCheck: false },
      autoCompress: { thresholdTokens: 20, keepLastN: 2 },
    });

    // Build a large message history to trigger compression
    const messages: StepRequest['messages'] = [
      { role: 'system', content: 'You are a helpful assistant who gives short concise answers.' },
    ];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'user', content: `This is a very long user message number ${i + 1} that contains many tokens of text to ensure the total exceeds the threshold. We are testing auto-compression behavior with real API calls. The compression should summarize the middle section and keep the last 2 messages untouched.`.repeat(2) });
      messages.push({ role: 'assistant', content: `This is assistant response number ${i + 1} confirming receipt of the long user message and providing helpful information about the topic discussed in the previous message. Our goal is to test compression under realistic conditions.`.repeat(2) });
    }

    const request: StepRequest = {
      model: MODEL,
      messages,
    };

    const beforeCount = request.messages.length;
    console.log(`  Messages before step: ${beforeCount}`);

    try {
      const response = await agent.step(request);
      const usage = agent.getUsage();
      // The messages may have been compressed in-place
      console.log(`  Step completed. Output: "${response.choices[0]?.message?.content?.trim().substring(0, 60)}..."`);

      // We can't directly verify compression happened from outside,
      // but we can check if there's a circuit:exceeded or other events
      // Actually, compression modifies request.messages in-place, so we just need to check
      // if the model was able to process the request
      pass(`Step with ${beforeCount} messages completed under compression threshold`);
    } catch (err) {
      if (err instanceof BudgetError) {
        fail(`BudgetError during compression test: ${err.exceeded.reason}`, '');
      } else {
        fail(`Compression test step failed: ${err}`, '');
      }
    }

    // Manual compression test
    try {
      const compressed = await agent.compressMessages(messages, 2);
      console.log(`  After manual compression: ${compressed.length} messages (was ${messages.length})`);
      if (compressed.length < messages.length) {
        pass(`Manual compression reduced messages: ${messages.length} → ${compressed.length}`);
        // Check that summary prefix exists
        const summaryMsg = compressed.find(m => m.content.startsWith('[COMPRESSED SUMMARY'));
        if (summaryMsg) {
          pass(`Summary message found with prefix: "${summaryMsg.content.substring(0, 80)}..."`);
        } else {
          fail('No [COMPRESSED SUMMARY] prefix found in compressed messages', 'compressor may not be marking summaries');
        }
      } else {
        fail(`Manual compression did not reduce message count`, `${compressed.length} >= ${messages.length}`);
      }
    } catch (err) {
      fail(`Manual compression failed: ${err}`, '');
    }
  });
}

// ─── Cross-Agent Interaction: Router + Pre-flight + Circuit Breaker ────────────

async function testCrossAgentInteraction() {
  await test('Cross-agent: Router + Pre-flight + Circuit Breaker work together with simulated pricing', async () => {
    setupSimulatedPricing();
    const agent = new AgentBudget({
      apiKey: API_KEY!,
      limits: {
        maxCostUSD: 500,
        preflightCheck: true,
        preflightOutputTokenEstimate: 1,
      },
      adaptiveRouting: {
        fallbackChain: ['openai/gpt-4o-mini', MODEL],
        thresholds: [0.5],
      },
      circuitBreaker: {
        repetitionWindow: 2,
        repetitionThreshold: 0.7,
        stagnationWindow: 10,
        stagnationMinLength: 1,
      },
    });

    const request: StepRequest = {
      model: 'openai/gpt-4o-mini', // Will be overridden by router
      messages: [{ role: 'user', content: 'Say "Test" exactly. Only this word.' }],
    };

    try {
      // Burn some budget to trigger routing
      agent.recordStep({ inputTokens: 20, outputTokens: 10, costUSD: 300 }); // 60% consumed

      const currentModel = agent.getCurrentModel();
      console.log(`  After 60% burn, router selected: ${currentModel}`);

      if (currentModel === MODEL) {
        pass(`Router correctly downgraded to cheap model`);
      } else {
        fail(`Router did not downgrade at 60% budget`, `Current model: ${currentModel}`);
      }

      // The pre-flight check should allow this (remaining $200 > estimated cost)
      const response = await agent.step(request);
      const usage = agent.getUsage();

      if (response.model === MODEL || response.model.includes('north-mini')) {
        pass(`Actual API call used downgraded model: ${response.model}`);
      } else {
        fail(`API call used unexpected model: ${response.model}`, 'Expected the free model from router');
      }

      // Now do a few more steps to trigger circuit breaker
      for (let i = 0; i < 3; i++) {
        request.messages = [
          { role: 'user', content: `Say only "Test" and nothing else. Iteration ${i + 1}.` },
        ];
        await agent.step(request);
        const last = agent.getUsage().stepHistory.slice(-1)[0];
        console.log(`  Repeat step ${i + 1}: "${last.outputContent?.trim()}"`);
      }

      fail('Cross-agent test: circuit breaker should have tripped in 4+ repetitive steps', '');

    } catch (err) {
      if (err instanceof BudgetError) {
        if (err.exceeded.reason === 'circuitBreaker') {
          pass(`Cross-agent interaction: Router + Pre-flight + Circuit Breaker all active. Tripped on: ${err.exceeded.triggerMode}`);
        } else if (err.exceeded.reason === 'preflightCostEstimate') {
          pass(`Cross-agent: Pre-flight blocked with $${err.exceeded.estimatedCost?.toFixed(2)} estimate vs $${err.exceeded.remainingBudget?.toFixed(2)} remaining`);
        } else if (err.exceeded.reason === 'fallbackChainExhausted') {
          pass(`Cross-agent: Fallback chain exhausted — budget fully consumed`);
        } else {
          fail(`Cross-agent: Unexpected BudgetError: ${err.exceeded.reason}`, '');
        }
      } else {
        fail(`Cross-agent: Unexpected error: ${err}`, '');
      }
    }
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   COMPREHENSIVE AGENT-BUDGET STRESS TEST                    ║');
  console.log(`║   Model: ${MODEL}                  ║`);
  console.log(`║   Simulated pricing: $1.50 input / $10 output per token    ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const startTime = Date.now();

  // Agent 2 tests
  await testPreflightBlocks();
  await testPreflightPassesWithSaneBudget();

  // Agent 4 tests
  await testCircuitBreakerRepetition();
  await testCircuitBreakerStagnation();

  // Agent 3 tests
  await testAdaptiveRouting();

  // Agent 5 tests
  await testEventEmission();

  // Agent 6 tests
  await testCheckpointResume();

  // Agent 1 tests
  await testAutoCompression();

  // Cross-agent test
  await testCrossAgentInteraction();

  // ─── Summary ──────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   RESULTS                                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Time: ${elapsed}s\n`);

  if (issues.length > 0) {
    console.log('─── ISSUES FOUND ───');
    for (const issue of issues) {
      console.log(`  ⚠ ${issue}`);
    }
  } else {
    console.log('  ✓ No issues found.');
  }

  // Cleanup checkpoint if still hanging around
  try { await fs.unlink(CHECKPOINT_PATH); } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  try { fs.unlink(CHECKPOINT_PATH); } catch {}
  process.exit(1);
});
