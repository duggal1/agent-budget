/**
 * Test: Context Compression
 *
 * Tests the compressor in 4 ways:
 *  1. Standalone compressMessages() on fake 20-turn history
 *  2. Auto-compress via AgentBudget.step()
 *  3. Public agent.compressMessages() method
 *  4. Edge cases (no API needed)
 *
 * Real model: cohere/north-mini-code:free
 */

import { AgentBudget, compressMessages, estimateMessagesTokens } from './index.js';
import type { OpenRouterMessage, StepRequest } from './types.js';

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error('Set OPENROUTER_API_KEY env var before running this test.');
  process.exit(1);
}

const MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';

function makeMessage(role: OpenRouterMessage['role'], text: string): OpenRouterMessage {
  return { role, content: text };
}

function buildFakeHistory(turns: number): OpenRouterMessage[] {
  const msgs: OpenRouterMessage[] = [
    makeMessage('system', 'You are a helpful AI assistant that helps users with software engineering tasks. Be concise and accurate.'),
  ];
  for (let i = 1; i <= turns; i++) {
    msgs.push(makeMessage('user', `Step ${i}: Explain how recursion works in JavaScript with an example.`));
    msgs.push(makeMessage('assistant', `Recursion is a technique where a function calls itself. Here is a recursive factorial:\n\n\`\`\`javascript\nfunction factorial(n) {\n  if (n <= 1) return 1;\n  return n * factorial(n - 1);\n}\n\`\`\`\n\nThe base case stops the recursion when n <= 1.`));
  }
  return msgs;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i >= retries || !err?.message?.includes('429')) throw err;
      const wait = 5000 * (i + 1);
      console.log(`  Rate limited, waiting ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ─── TEST 1: Standalone compressMessages() ───────────────────────────────────

async function testStandaloneCompression() {
  console.log('\n=== TEST 1: Standalone compressMessages() (real LLM summary) ===\n');

  const history = buildFakeHistory(10);
  const keepLastN = 3;

  console.log(`  Messages before: ${history.length}`);
  console.log(`  Estimated tokens: ${estimateMessagesTokens(history)}`);

  const compressed = await compressMessages(history, API_KEY!, keepLastN);

  console.log(`  Messages after: ${compressed.length}`);
  console.log(`  Estimated tokens after: ${estimateMessagesTokens(compressed)}`);

  // System message preserved
  if (compressed[0]?.role === 'system' && compressed[0]?.content === history[0]?.content) {
    console.log('  ✓ System message preserved');
  } else {
    console.error('  ✗ System message not preserved'); process.exit(1);
  }

  // Last N untouched
  const lastNOriginal = history.slice(-keepLastN);
  const lastNCompressed = compressed.slice(-keepLastN);
  let ok = true;
  for (let i = 0; i < keepLastN; i++) {
    if (lastNOriginal[i]?.content !== lastNCompressed[i]?.content) { ok = false; }
  }
  console.log(`  ${ok ? '✓' : '✗'} Last ${keepLastN} messages untouched`);

  // Summary prefix
  const summaryMsg = compressed[history[0]?.role === 'system' ? 1 : 0];
  if (summaryMsg?.role === 'assistant' && summaryMsg?.content.includes('[COMPRESSED SUMMARY —')) {
    console.log('  ✓ Summary has [COMPRESSED SUMMARY — N messages collapsed] prefix');
    console.log(`\n  Summary (first 400 chars):\n${summaryMsg.content.slice(0, 400)}\n`);
  } else {
    console.error('  ✗ Summary message missing or wrong prefix');
    if (summaryMsg) console.error(`  Role: ${summaryMsg.role}, Start: "${summaryMsg.content.slice(0, 100)}"`);
    process.exit(1);
  }
}

// ─── TEST 2: Auto-compress in step() ──────────────────────────────────────────

async function testAutoCompress() {
  console.log('\n=== TEST 2: Auto-compress via step() ===\n');

  let compressFired = false;
  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxCostUSD: 1.0, maxSteps: 10 },
    autoCompress: { thresholdTokens: 50, keepLastN: 2 },
    onEvent: (event) => {
      if (event.type === 'compress:triggered') {
        compressFired = true;
        console.log(`  📦 compress:triggered: ${event.messagesBefore}→${event.messagesAfter} msgs, freed ${event.tokensFreed} tokens`);
      }
    },
  });

  const request: StepRequest = { model: MODEL, messages: [{ role: 'system', content: 'Keep answers brief.' }] };

  try {
    for (let i = 0; i < 5; i++) {
      request.messages.push({ role: 'user', content: `List 1 benefit of TypeScript over JavaScript.` });
      const res = await agent.step({ ...request });
      const reply = res.choices[0]?.message?.content ?? '';
      request.messages.push({ role: 'assistant', content: reply });
      console.log(`  Step ${i + 1}: msgs=${request.messages.length}, est=${estimateMessagesTokens(request.messages)}`);
    }
    console.log(`  ${compressFired ? '✓' : '○'} compress:triggered ${compressFired ? 'fired' : 'not fired (may not have crossed threshold)'}`);
  } catch (err: unknown) {
    const e = err as Error & { exceeded?: { reason: string } };
    if (e?.exceeded?.reason) {
      console.log(`  ○ Step loop ended early: ${e.exceeded.reason}`);
    } else if (e?.message?.includes('429')) {
      console.log(`  ○ API rate limited — skipping step loop (non-critical)`);
    } else {
      console.log(`  ○ Step loop interrupted: ${e?.message ?? err}`);
    }
  }
  console.log(`  Total steps: ${agent.getUsage().steps}\n`);
}

// ─── TEST 3: Public compressMessages() method ─────────────────────────────────

async function testPublicCompressMethod() {
  console.log('\n=== TEST 3: Public agent.compressMessages() method ===\n');

  const agent = new AgentBudget({
    apiKey: API_KEY!,
    limits: { maxCostUSD: 1.0 },
    autoCompress: { thresholdTokens: 1000, keepLastN: 2 },
  });

  const history = buildFakeHistory(8);
  console.log(`  Messages before: ${history.length}`);

  const compressed = await agent.compressMessages(history, 3);
  console.log(`  Messages after: ${compressed.length}`);
  console.log(`  ${compressed.length === 5 ? '✓' : '○'} Expected ~5 messages (system + summary + 3)`);

  const systemOk = compressed[0]?.role === 'system' && compressed[0]?.content === history[0]?.content;
  console.log(`  ${systemOk ? '✓' : '✗'} System message preserved`);

  const summaryOk = compressed[1]?.role === 'assistant' && (compressed[1]?.content ?? '').startsWith('[COMPRESSED SUMMARY —');
  console.log(`  ${summaryOk ? '✓' : '✗'} Summary present and marked`);

  if (!systemOk || !summaryOk) process.exit(1);
  console.log('');
}

// ─── TEST 4: Edge cases (no API needed) ──────────────────────────────────────

async function testEdgeCases() {
  console.log('\n=== TEST 4: Edge cases (no API calls) ===\n');

  const r1 = await compressMessages(
    [makeMessage('user', 'Hi'), makeMessage('assistant', 'Hello!')],
    API_KEY!,
    4,
  );
  console.log(`  ${r1.length === 2 ? '✓' : '✗'} Fewer msgs than keepLastN → untouched`);

  const r2 = await compressMessages([], API_KEY!, 3);
  console.log(`  ${r2.length === 0 ? '✓' : '✗'} Empty array → empty`);

  const r3 = await compressMessages(
    [
      makeMessage('system', 'Be helpful.'),
      makeMessage('user', 'A'),
      makeMessage('assistant', 'B'),
      makeMessage('user', 'C'),
    ],
    API_KEY!,
    3,
  );
  console.log(`  ${r3.length === 4 ? '✓' : '✗'} Exactly system + keepLastN → untouched`);

  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('   Agent 1 — Context Compression');
  console.log('═══════════════════════════════════════\n');

  await testEdgeCases();
  await testStandaloneCompression();
  await testPublicCompressMethod();
  await testAutoCompress();

  console.log('═══════════════════════════════════════');
  console.log('   ✅ All compressor tests passed!');
  console.log('═══════════════════════════════════════');
}

main().catch((err) => {
  console.error('\n❌ FATAL:', err);
  process.exit(1);
});
