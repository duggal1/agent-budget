import { AgentBudget, BudgetError } from './index.js';
import { CheckpointManager } from './checkpoint.js';
import { promises as fs } from 'node:fs';

const rawKey = process.env.OPENROUTER_API_KEY;
if (!rawKey) {
  console.error('❌ OPENROUTER_API_KEY env variable is required');
  process.exit(1);
}
const API_KEY: string = rawKey;

const MODEL = 'cohere/north-mini-code:free';
const CHECKPOINT_PATH = './.test-checkpoint.json';

async function main() {
  // ── Clean up any leftover checkpoint from previous runs ───────────────
  try { await fs.unlink(CHECKPOINT_PATH); } catch { /* ok */ }

  // ── Step 1: Create agent with maxSteps: 2, checkpoint enabled ────────
  console.log('\n═══ Phase 1: Run 2 steps with maxSteps:2 ═══\n');

  const agent1 = new AgentBudget({
    apiKey: API_KEY,
    limits: { maxSteps: 2 },
    checkpoint: { path: CHECKPOINT_PATH, enabled: true },
  });

  const messages1: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: 'Say "hello from step 1"' },
  ];

  try {
    const res1 = await agent1.step({ model: MODEL, messages: messages1 });
    const reply1 = res1.choices[0].message.content;
    console.log(`Step 1 response: ${reply1}`);
    messages1.push({ role: 'assistant', content: reply1 });
    messages1.push({ role: 'user', content: 'Say "hello from step 2"' });

    const res2 = await agent1.step({ model: MODEL, messages: messages1 });
    const reply2 = res2.choices[0].message.content;
    console.log(`Step 2 response: ${reply2}`);
    messages1.push({ role: 'assistant', content: reply2 });
    messages1.push({ role: 'user', content: 'Say "hello from step 3"' });

    // Should not reach here — maxSteps:2 should throw
    await agent1.step({ model: MODEL, messages: messages1 });
    console.log('❌ ERROR: Should have hit maxSteps limit');
    process.exit(1);
  } catch (err) {
    if (err instanceof BudgetError) {
      console.log(`\n✅ BudgetError caught: ${err.message}`);
      console.log(`   Reason: ${err.exceeded.reason}`);
      console.log(`   Steps completed: ${err.exceeded.usage.steps}`);
    } else {
      console.error('❌ Unexpected error:', err);
      process.exit(1);
    }
  }

  // ── Step 2: Verify checkpoint file exists ─────────────────────────────
  console.log('\n═══ Phase 2: Verify checkpoint file ═══\n');

  const checkpointExists = await fs.access(CHECKPOINT_PATH).then(() => true).catch(() => false);
  console.log(`Checkpoint file exists: ${checkpointExists}`);
  if (!checkpointExists) {
    console.log('❌ Checkpoint file not found');
    process.exit(1);
  }

  const checkpointRaw = await fs.readFile(CHECKPOINT_PATH, 'utf-8');
  const checkpoint = JSON.parse(checkpointRaw);
  console.log(`Checkpoint resumeFromStep: ${checkpoint.resumeFromStep}`);
  console.log(`Checkpoint messages count: ${checkpoint.messages.length}`);
  console.log(`Checkpoint steps in usage: ${checkpoint.usage.steps}`);

  // ── Step 3: Resume with maxSteps: 4 and run 2 more steps ─────────────
  console.log('\n═══ Phase 3: Resume with maxSteps:4 and run 2 more steps ═══\n');

  const agent2 = await AgentBudget.resume(
    {
      apiKey: API_KEY,
      limits: { maxSteps: 4 },
      checkpoint: { path: CHECKPOINT_PATH, enabled: true },
    },
    CHECKPOINT_PATH,
  );

  const resumedUsage = agent2.getUsage();
  console.log(`Resumed agent step count: ${resumedUsage.steps}`);
  if (resumedUsage.steps !== 2) {
    console.log(`❌ Expected 2 steps restored from checkpoint, got ${resumedUsage.steps}`);
    process.exit(1);
  }
  console.log('✅ Tracker correctly restored with 2 steps');

  // Load checkpoint messages and feed them as context
  const loadedCheckpoint = await agent2.loadCheckpoint();
  if (!loadedCheckpoint) {
    console.log('❌ Failed to load checkpoint via loadCheckpoint()');
    process.exit(1);
  }
  const resumedMessages = [...loadedCheckpoint.messages];
  resumedMessages.push({ role: 'user', content: 'Say "hello from resumed step 3"' });

  const res3 = await agent2.step({ model: MODEL, messages: resumedMessages });
  const reply3 = res3.choices[0].message.content;
  console.log(`Step 3 response: ${reply3}`);
  resumedMessages.push({ role: 'assistant', content: reply3 });
  resumedMessages.push({ role: 'user', content: 'Say "hello from resumed step 4"' });

  try {
    await agent2.step({ model: MODEL, messages: resumedMessages });
    console.log('❌ Expected BudgetError on step 4 (maxSteps reached)');
    process.exit(1);
  } catch (err4) {
    if (!(err4 instanceof BudgetError)) {
      console.error('❌ Unexpected error on step 4:', err4);
      process.exit(1);
    }
    console.log(`✅ Step 4 correctly hit maxSteps limit`);
  }

  const finalUsage = agent2.getUsage();
  console.log(`\nFinal total steps: ${finalUsage.steps}`);
  if (finalUsage.steps !== 4) {
    console.log(`❌ Expected 4 total steps, got ${finalUsage.steps}`);
    process.exit(1);
  }
  console.log('✅ Total step count across both runs is 4');

  // ── Step 4: Clear checkpoint and verify deletion ─────────────────────
  console.log('\n═══ Phase 4: Clear checkpoint ═══\n');

  await agent2.clearCheckpoint();
  const checkpointGone = await fs.access(CHECKPOINT_PATH).then(() => false).catch(() => true);
  console.log(`Checkpoint file deleted: ${checkpointGone}`);
  if (!checkpointGone) {
    console.log('❌ Checkpoint file was not deleted');
    process.exit(1);
  }

  console.log('\n🎉 All checkpoint tests passed!\n');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
