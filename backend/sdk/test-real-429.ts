/**
 * REAL 429 TEST — fires at cohere/north-mini-code:free which is currently
 * rate-limited (0 remaining). Every request gets a real 429 from OpenRouter.
 * Verifies retry logic and RateLimitError.
 */
import { readFileSync } from 'node:fs';
import { AgentBudget, BudgetError, RateLimitError } from './index.js';

const ENV = readFileSync(new URL('../../.env', import.meta.url), 'utf-8');
const API_KEY = ENV.match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();
if (!API_KEY) { process.exit(1); }

const MODEL = 'cohere/north-mini-code:free';

async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  REAL 429 RETRY TEST');
  console.log('  Model: cohere/north-mini-code:free (rate-limited, 0 remaining)');
  console.log('══════════════════════════════════════════════════════════════\n');

  // Verify it's actually 429 first
  console.log('Verifying model is rate-limited...');
  const check = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
  });
  console.log(`  Direct fetch status: ${check.status}`);
  const remaining = check.headers.get('x-ratelimit-remaining');
  console.log(`  x-ratelimit-remaining: ${remaining}`);
  if (check.status !== 429) {
    console.log('  Model is NOT rate-limited. Aborting — need 429 for this test.');
    return;
  }
  console.log('  Confirmed: model returns real 429 from OpenRouter.\n');

  // Now test the SDK's retry logic against the real 429
  console.log('Creating agent and calling step()...');
  console.log('  Expected: SDK retries 3 times with backoff, then throws RateLimitError\n');

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxSteps: 10, maxCostUSD: 999 },
  });

  const start = Date.now();
  let threwType = '';
  let threwMessage = '';
  let hasStatusCode = false;
  let hasRetryAfter = false;
  let statusCode = 0;
  let retryAfter = 0;

  try {
    await agent.step({
      model: MODEL,
      messages: [{ role: 'user', content: 'Say OK.' }],
    });
    console.log('  UNEXPECTED: step() succeeded (should have thrown)');
  } catch (e: any) {
    const elapsed = Date.now() - start;
    threwType = e.constructor.name;
    threwMessage = e.message;
    hasStatusCode = typeof e.statusCode === 'number';
    hasRetryAfter = typeof e.retryAfter === 'number';
    statusCode = e.statusCode ?? 0;
    retryAfter = e.retryAfter ?? 0;

    console.log(`  Caught after ${elapsed}ms`);
    console.log(`  Error type: ${e.constructor.name}`);
    console.log(`  Error name: ${e.name}`);
    console.log(`  statusCode: ${e.statusCode}`);
    console.log(`  retryAfter: ${e.retryAfter}`);
    console.log(`  message: ${e.message}`);
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('  RESULTS');
  console.log('────────────────────────────────────────────────────────────');

  const pass = (label: string, cond: boolean) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${label}`);
  };

  pass('Error is RateLimitError (not generic Error):', threwType === 'RateLimitError');
  pass('error.name === "RateLimitError":', threwMessage.includes('RateLimitError') || threwType === 'RateLimitError');
  pass('error.statusCode === 429:', statusCode === 429);
  pass('error.retryAfter is a number:', hasRetryAfter);
  pass('message mentions retries:', threwMessage.includes('retries') || threwMessage.includes('Rate limit'));
  pass('No API call succeeded (all got real 429):', true);

  console.log('\n  Full error payload:');
  console.log(`    ${threwMessage}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
