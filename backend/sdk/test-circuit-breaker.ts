import { AgentBudget, BudgetError } from './index.js';

// ─── Test: Circuit Breaker for Broken Agent Loops ────────────────────────────
// Makes real API calls to cohere/north-mini-code:free with prompts designed
// to elicit repetitive short answers, verifying the circuit breaker trips.

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error('Set OPENROUTER_API_KEY environment variable');
  process.exit(1);
}

const MODEL = 'cohere/north-mini-code:free';

async function testCircuitBreaker() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Circuit Breaker Test — Repetition Detection');
  console.log('══════════════════════════════════════════════════════════════\n');

  // Tight window: trip after 3 consecutive similar outputs
  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxSteps: 10,
      maxCostUSD: 0.05,
    },
    circuitBreaker: {
      repetitionWindow: 3,
      repetitionThreshold: 0.85,
      stagnationWindow: 5,
      stagnationMinLength: 10,
    },
  });

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    {
      role: 'user',
      content:
        'Reply with the word OK and nothing else. No punctuation, no explanation. Just the two letters O and K.',
    },
  ];

  let tripped = false;

  for (let step = 0; step < 8; step++) {
    console.log(`── Step ${step + 1} ──────────────────────────────────────────────`);

    try {
      const response = await agent.step({
        model: MODEL,
        messages,
      });

      const content = response.choices?.[0]?.message?.content ?? '(empty)';
      const usage = agent.getUsage();

      console.log(`  Model:    ${response.model}`);
      console.log(`  Output:   "${content}"`);
      console.log(`  Tokens:   ${response.usage?.prompt_tokens ?? '?'} in / ${response.usage?.completion_tokens ?? '?'} out`);
      console.log(`  Cost:     $${usage.totalCostUSD.toFixed(6)}`);
      console.log(`  Steps:    ${usage.steps}\n`);

      // Feed response back as context for the next step
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content:
          'Reply with the word OK and nothing else. No punctuation, no explanation. Just the two letters O and K.',
      });
    } catch (err) {
      if (err instanceof BudgetError && err.exceeded.reason === 'circuitBreaker') {
        console.log('  ⚡ Circuit breaker tripped!\n');
        console.log(`  Trigger mode: ${err.exceeded.triggerMode}`);
        console.log(`  Window size:  ${err.exceeded.windowSize}`);
        if (err.exceeded.similarity !== undefined) {
          console.log(`  Similarity:   ${err.exceeded.similarity.toFixed(4)}`);
        }
        console.log(`  Full message: ${err.message}\n`);
        tripped = true;
        break;
      }
      throw err;
    }
  }

  if (tripped) {
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  PASS: Circuit breaker correctly detected repetition loop');
    console.log('══════════════════════════════════════════════════════════════');
  } else {
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  FAIL: Circuit breaker did NOT trip within 8 steps');
    console.log('══════════════════════════════════════════════════════════════');
    process.exit(1);
  }
}

async function testStagnation() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Circuit Breaker Test — Stagnation Detection');
  console.log('══════════════════════════════════════════════════════════════\n');

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: {
      maxSteps: 10,
      maxCostUSD: 0.05,
    },
    circuitBreaker: {
      stagnationWindow: 3,
      stagnationMinLength: 100, // require at least 100 chars — short replies trip
      repetitionWindow: 5,
      repetitionThreshold: 0.99, // high bar so only stagnation trips
    },
  });

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    {
      role: 'user',
      content:
        'Just say OK. Nothing else.',
    },
  ];

  let tripped = false;

  for (let step = 0; step < 8; step++) {
    console.log(`── Step ${step + 1} ──────────────────────────────────────────────`);

    try {
      const response = await agent.step({
        model: MODEL,
        messages,
      });

      const content = response.choices?.[0]?.message?.content ?? '(empty)';
      const usage = agent.getUsage();

      console.log(`  Model:    ${response.model}`);
      console.log(`  Output:   "${content}" (${content.length} chars)`);
      console.log(`  Tokens:   ${response.usage?.prompt_tokens ?? '?'} in / ${response.usage?.completion_tokens ?? '?'} out`);
      console.log(`  Cost:     $${usage.totalCostUSD.toFixed(6)}`);
      console.log(`  Steps:    ${usage.steps}\n`);

      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content:
          'Just say OK. Nothing else.',
      });
    } catch (err) {
      if (err instanceof BudgetError && err.exceeded.reason === 'circuitBreaker') {
        console.log('  ⚡ Circuit breaker tripped!\n');
        console.log(`  Trigger mode: ${err.exceeded.triggerMode}`);
        console.log(`  Window size:  ${err.exceeded.windowSize}`);
        if (err.exceeded.similarity !== undefined) {
          console.log(`  Similarity:   ${err.exceeded.similarity.toFixed(4)}`);
        }
        console.log(`  Full message: ${err.message}\n`);
        tripped = true;
        break;
      }
      throw err;
    }
  }

  if (tripped) {
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  PASS: Circuit breaker correctly detected stagnation');
    console.log('══════════════════════════════════════════════════════════════');
  } else {
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  FAIL: Circuit breaker did NOT trip for stagnation');
    console.log('══════════════════════════════════════════════════════════════');
    process.exit(1);
  }
}

async function main() {
  await testCircuitBreaker();
  await testStagnation();
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
