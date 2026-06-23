# agent-budget — Multi-Agent Extension Briefing

---

## MASTER CONTEXT (read this before your individual task)

You are extending an NPM SDK called `agent-budget`. It is a TypeScript middleware package that enforces hard budget limits (cost in USD, token count, step count, wall time) on AI agent loops running through OpenRouter. It fetches live model pricing dynamically from `GET https://openrouter.ai/api/v1/models` so no prices are ever hardcoded.

**Current file structure:**

```
agent-budget/
├── src/
│   ├── types.ts      — all TypeScript interfaces
│   ├── pricing.ts    — fetches + caches live model prices from OpenRouter
│   ├── tracker.ts    — accumulates per-step and total usage metrics
│   ├── budget.ts     — checkLimits() function + BudgetError class
│   └── index.ts      — AgentBudget class, createAgentBudget factory, all exports
├── package.json      — ESM, Node ≥18, TypeScript 5.4
├── tsconfig.json     — NodeNext module resolution
└── README.md
```

**What the current SDK does:**
- `new AgentBudget({ apiKey, limits, onExceeded })` — constructs a budget-aware agent wrapper
- `agent.step(request)` — makes one OpenRouter call, checks limits before and after, throws `BudgetError` on exceed
- `agent.getUsage()` — returns live usage snapshot
- `agent.reset()` — resets counters
- Limits: `maxCostUSD`, `maxSteps`, `maxTotalTokens`, `maxInputTokens`, `maxOutputTokens`, `maxWallTimeMs`

**What is critically wrong with the current SDK:**

The current implementation is a basic skeleton. It tracks and stops. That is all it does. In 2026, agents run in long autonomous loops — they loop dozens of times, context windows rot, costs explode unexpectedly, models fail silently, broken loops burn money with no escape valve, and there is zero visibility into what is happening mid-run. The current SDK does none of this. It is a speed bump, not a production-grade system.

**Your job is NOT to:**
- Rebuild what already exists
- Add complexity for its own sake
- Create abstractions nobody needs
- Add dependencies without strong justification

**Your job IS to:**
- Solve one specific, acute, real production pain point that the current SDK completely misses
- Extend the existing codebase by adding new files or modifying existing ones
- Keep the public API stupidly simple — one or two new methods or options max
- Produce working TypeScript code that compiles cleanly under the existing tsconfig
- Write a real local test using OpenRouter with the default model: `cohere/north-mini-code:free`
- Your test must make actual live API calls. No mocks. No stubs. Use a real `OPENROUTER_API_KEY` env variable.

**Tech constraints:**
- ESM only (`"type": "module"` in package.json)
- All imports use `.js` extensions (NodeNext resolution)
- Node ≥ 18 native `fetch` — no node-fetch
- Avoid new dependencies unless genuinely unavoidable
- Test file lives at `src/test-[your-feature].ts`, run with `npx tsx src/test-[your-feature].ts`

**Default test model for all agents:** `cohere/north-mini-code:free`

**OpenRouter API key:** read from `process.env.OPENROUTER_API_KEY`

---

---

## AGENT 1 — Context Compression Between Loop Iterations

**Your task:** Build a context compression module that automatically compresses message history between agent steps when the conversation is approaching a token threshold.

**The real pain point:** Agents that run 10, 20, 30 steps accumulate thousands of tokens of message history. By step 15, the model is confused by its own prior reasoning, context is bloated, costs per step keep rising, and eventually you hit a context window hard limit and the whole loop crashes. Nobody has a clean, drop-in solution for this. Everyone either ignores it (broken by step 20) or builds bespoke summarization logic for every project. The fix belongs in the budget layer because that is where token awareness already lives.

**What to build:**

New file: `src/compressor.ts`

A `compressMessages()` function that takes a message array and a target token budget and returns a compressed message array. Compression strategy:

1. Always preserve: the system message (if any) and the last N messages (configurable, default 4) — these are sacred, never touched.
2. Everything in the middle: replace with a single synthetic `assistant` message that summarizes what was discussed, what was decided, what tool calls were made, and what the current goal state is.
3. The summary message must be clearly marked so downstream code knows it is a compression artifact: prefix content with `[COMPRESSED SUMMARY — ${n} messages collapsed]`.
4. Token counting: use a simple character-based approximation (4 chars ≈ 1 token) — do NOT add a tiktoken dependency. It is good enough for threshold decisions.

Extend `AgentBudget` in `index.ts` with:
- A new option `autoCompress?: { thresholdTokens: number; keepLastN?: number }` in `BudgetOptions`
- Before each `step()` call, if estimated message token count exceeds `thresholdTokens`, auto-compress the messages in-place before sending
- Expose `agent.compressMessages(messages, keepLastN?)` as a public method for manual use

The compression summary must itself be generated via a real LLM call to OpenRouter using `cohere/north-mini-code:free`. Do not use a heuristic summary. Use the model.

**Test:** Write `src/test-compressor.ts` that:
1. Builds a fake but realistic message history of 20 alternating user/assistant turns
2. Calls `compressMessages()` on it with a threshold of 500 tokens and keepLastN of 3
3. Prints the before and after message count and the generated summary content
4. Confirms the last 3 messages are untouched

---

---

## AGENT 2 — Predictive Pre-Flight Cost Estimation

**Your task:** Build a pre-flight cost estimator that predicts the cost of a step BEFORE making the API call, and blocks the call if the predicted cost would push the agent over budget.

**The real pain point:** The current SDK only catches cost violations AFTER the API call completes and burns real money. For large prompts — long message histories, big system prompts, extensive tool definitions — the input token cost alone can blow the remaining budget before the model produces a single output token. There is no way to know this in advance without a token counter. The result: agents blow their budget on the very last step with no warning.

**What to build:**

New file: `src/estimator.ts`

A `estimateStepCost()` function that:
1. Takes a `StepRequest` and a `ModelPricing` object
2. Estimates input token count using character-based approximation (4 chars ≈ 1 token) applied to the serialized message array + tool definitions
3. Applies a configurable output token estimate (default: 512 tokens) for the completion
4. Returns: `{ estimatedInputTokens, estimatedOutputTokens, estimatedCostUSD, confidence: 'approximate' }`

Extend `BudgetLimits` in `types.ts` with:
- `preflightCheck?: boolean` — default `true`. When true, runs cost estimation before each step and throws `BudgetError` with `reason: 'preflightCostEstimate'` if the estimated cost would breach `maxCostUSD` based on remaining budget.
- `preflightOutputTokenEstimate?: number` — default 512. The assumed output size for pre-flight purposes.

Add `reason: 'preflightCostEstimate'` to `ExceededReason` in `types.ts`.

The pre-flight check must show:
- `remainingBudget`: how much USD is left
- `estimatedCost`: what this step is predicted to cost
- Both values in the thrown `BudgetError.exceeded` payload

**Test:** Write `src/test-estimator.ts` that:
1. Creates an agent with `maxCostUSD: 0.000001` (absurdly low) and `preflightCheck: true`
2. Tries to run a step with a large message history (paste in ~2000 words of dummy text as a user message)
3. Confirms it throws `BudgetError` with `reason: 'preflightCostEstimate'` BEFORE the API call is made
4. Prints the estimated cost and remaining budget from the error payload
5. Then sets a sane budget and confirms a real step goes through successfully using `cohere/north-mini-code:free`

---

---

## AGENT 3 — Adaptive Model Downgrade on Budget Pressure

**Your task:** Build an adaptive model routing layer that automatically switches to a cheaper fallback model when the agent is approaching its cost limit, instead of hard-aborting.

**The real pain point:** Current behavior is binary: under budget → run, over budget → crash. Real production agents need a graceful degradation path. When you have spent 80% of your budget and still have work to do, the right answer is not to crash — it is to finish the job with a cheaper model. Nobody packages this cleanly. Everyone either writes bespoke routing logic or just crashes and loses the entire agent run.

**What to build:**

New file: `src/router.ts`

A model routing system that:
1. Takes a configured `fallbackChain: string[]` — ordered list of model IDs from most preferred to cheapest
2. At each step, checks what percentage of `maxCostUSD` has been consumed
3. Selects the appropriate model from the chain based on configurable thresholds
4. Default thresholds: 0–60% → use model[0], 60–85% → use model[1], 85–100% → use model[2], etc.
5. If the chain is exhausted and budget is still critical, throw `BudgetError` with `reason: 'fallbackChainExhausted'`

Add `reason: 'fallbackChainExhausted'` to `ExceededReason` in `types.ts`.

Extend `BudgetOptions` with:
```ts
adaptiveRouting?: {
  fallbackChain: string[];       // e.g. ['anthropic/claude-sonnet-4-5', 'google/gemini-flash-1.5', 'cohere/north-mini-code:free']
  thresholds?: number[];         // e.g. [0.6, 0.85] — must be length fallbackChain.length - 1
}
```

When `adaptiveRouting` is configured:
- `agent.step(request)` ignores `request.model` and resolves the model from the router based on current budget consumption
- Expose `agent.getCurrentModel(): string` — returns which model would be used right now
- Log to console when a downgrade occurs: `[agent-budget] Downgrading model: ${from} → ${to} (budget ${pct}% consumed)`

**Test:** Write `src/test-router.ts` that:
1. Configures an agent with a very tight `maxCostUSD` and a fallback chain ending in `cohere/north-mini-code:free`
2. Runs 3 steps, printing which model was selected at each step
3. Artificially burns budget between steps by calling `tracker.record()` directly to simulate high usage (you may need to expose a test hook)
4. Confirms the final step uses `cohere/north-mini-code:free` as the cheapest fallback and actually completes

---

---

## AGENT 4 — Circuit Breaker for Broken Agent Loops

**Your task:** Build a circuit breaker that detects when an agent is stuck in a broken or degenerate loop and halts execution before it burns the entire budget on garbage output.

**The real pain point:** In 2026, autonomous agent loops fail in subtle ways that cost tracking cannot catch. The model starts repeating itself. Tool calls return the same result 5 times. The agent oscillates between two states and never converges. Step count and cost limits catch this eventually, but only after burning significant money on useless work. A circuit breaker catches it early using output quality signals, not just accounting signals.

**What to build:**

New file: `src/circuit-breaker.ts`

A `CircuitBreaker` class that plugs into the agent loop and monitors output quality across consecutive steps. It detects two failure modes:

**Mode 1 — Repetition:** The last N assistant outputs are too similar to each other. Similarity check: normalize both strings (lowercase, strip punctuation, collapse whitespace), then compute overlap using a simple word-set Jaccard similarity. If similarity > threshold for N consecutive pairs, trip the breaker.

**Mode 2 — Stagnation:** The assistant message content is below a minimum length threshold for N consecutive steps (e.g., output keeps returning 1-sentence non-answers). This catches models that have given up and are just saying "I cannot help with that" in a loop.

Add `reason: 'circuitBreaker'` to `ExceededReason` in `types.ts`.

Extend `BudgetOptions` with:
```ts
circuitBreaker?: {
  repetitionWindow?: number;       // default 3 — consecutive steps to check
  repetitionThreshold?: number;    // default 0.85 — Jaccard similarity to trigger
  stagnationWindow?: number;       // default 4
  stagnationMinLength?: number;    // default 50 chars
}
```

When tripped, throw `BudgetError` with:
- `reason: 'circuitBreaker'`
- Include in the error payload: `triggerMode: 'repetition' | 'stagnation'`, `windowSize`, `similarity` (for repetition mode)

`CircuitBreaker` must be stateless between instances but accumulate state across steps via the tracker — do not maintain a separate data store. Pull the last N `stepHistory` entries from `BudgetUsage` and analyze them. This means you need to extend `StepUsage` in `types.ts` to include `outputContent: string`.

**Test:** Write `src/test-circuit-breaker.ts` that:
1. Makes real calls to `cohere/north-mini-code:free` with a prompt designed to elicit repetitive short answers (e.g., "Reply with the word OK and nothing else")
2. Runs the agent in a loop feeding each response back as context
3. Confirms the circuit breaker trips within the configured window
4. Prints the trigger mode and similarity score from the error

---

---

## AGENT 5 — Structured Telemetry and Event Emission

**Your task:** Build a structured event emission system that makes every meaningful moment in an agent run observable, without requiring any external dependencies.

**The real pain point:** Agent runs are black boxes. You have no idea what happened inside unless you add logging everywhere manually. Cost spikes, model downgrades, budget warnings, step durations, circuit breaker trips — none of it is observable by default. In 2026, every production system needs observability. OpenTelemetry is too heavy for an SDK like this. What is needed is a lightweight, structured event bus that emits typed events at every meaningful moment and lets the caller do whatever they want with them (log, send to a webhook, pipe to a dashboard).

**What to build:**

New file: `src/events.ts`

A typed event system built on Node.js `EventEmitter`. No external dependencies.

Define a discriminated union of all possible event types:

```ts
type AgentBudgetEvent =
  | { type: 'step:start';         stepIndex: number; model: string; estimatedCostUSD?: number }
  | { type: 'step:end';           stepIndex: number; model: string; inputTokens: number; outputTokens: number; costUSD: number; durationMs: number }
  | { type: 'budget:warning';     reason: ExceededReason; pctConsumed: number; remaining: number }
  | { type: 'budget:exceeded';    exceeded: BudgetExceededError }
  | { type: 'model:downgraded';   from: string; to: string; pctConsumed: number }
  | { type: 'circuit:tripped';    triggerMode: 'repetition' | 'stagnation'; stepIndex: number }
  | { type: 'compress:triggered'; messagesBefore: number; messagesAfter: number; tokensFreed: number }
  | { type: 'pricing:fetched';    modelCount: number; cachedUntil: number }
```

`budget:warning` fires when any metric crosses a configurable warning threshold (default: 75% of any limit). It fires once per threshold crossing per metric, not on every step.

Extend `AgentBudget` to:
- Accept `onEvent?: (event: AgentBudgetEvent) => void` in `BudgetOptions`
- Emit the appropriate event at every meaningful moment inside `step()`, `compressMessages()`, the router, and the circuit breaker
- Also expose `agent.on(type, handler)` and `agent.off(type, handler)` as typed event listener methods so callers can subscribe to specific event types

**Test:** Write `src/test-events.ts` that:
1. Creates an agent with a warning threshold of 10% (very low, to trigger warnings immediately)
2. Runs 3 real steps against `cohere/north-mini-code:free`
3. Subscribes to all event types and prints every event to console with a timestamp
4. Confirms `step:start`, `step:end`, and `pricing:fetched` events all fire correctly
5. Confirm `budget:warning` fires when threshold is breached

---

---

## AGENT 6 — Checkpoint and Resume

**Your task:** Build a checkpoint/resume system that serializes full agent state after every step so a crashed, timed-out, or budget-exceeded agent can resume from exactly where it stopped.

**The real pain point:** Long agent runs fail. A process crashes. A budget limit hits mid-task. A network timeout kills step 12 of 20. Right now, the entire run is lost and you start over from step 0, burning cost and time you already paid for. In 2026, agentic tasks run for minutes or hours. Losing the whole run because of a transient failure is unacceptable. Nobody has a simple, drop-in checkpoint primitive for agent loops. Temporal is too heavy. Redis queues are too much infrastructure. The right solution is a local file-based checkpoint that requires zero external dependencies and works in any Node.js environment.

**What to build:**

New file: `src/checkpoint.ts`

A `CheckpointManager` class that:

1. After every successful `step()`, serializes the following to a JSON file:
   - Full message history (the messages array passed to `step()` plus the assistant response appended)
   - Full `BudgetUsage` snapshot
   - The model used
   - A `resumeFromStep` index
   - A `checkpointVersion` string (use `'1.0'`) for future compatibility
   - ISO timestamp of the checkpoint

2. On resume, reads the checkpoint file and restores:
   - `messages`: the full message history up to that point
   - `usage`: restores the tracker state so budget accounting continues correctly from where it left off, not from zero
   - `resumeFromStep`: so the caller knows which step to continue from

3. Checkpoint file location: configurable, default `'./.agent-checkpoint.json'`. One file per agent run (overwrites on each step — latest checkpoint only).

4. Auto-cleanup: when the agent loop completes successfully (caller explicitly calls `agent.clearCheckpoint()`), the file is deleted.

Extend `BudgetOptions` with:
```ts
checkpoint?: {
  path?: string;         // default './.agent-checkpoint.json'
  enabled?: boolean;     // default false — must opt in
}
```

Extend `AgentBudget` with:
- `agent.clearCheckpoint(): Promise<void>` — deletes the checkpoint file
- `agent.loadCheckpoint(): Promise<CheckpointData | null>` — loads an existing checkpoint, returns null if none exists
- Static method: `AgentBudget.resume(options, checkpointPath?)` — constructs a new `AgentBudget` instance with tracker state pre-loaded from checkpoint so budget accounting is correct

The checkpoint must survive a `BudgetError` throw — write the checkpoint before the post-step budget check so a budget-exceeded agent can be resumed with a higher limit.

**Test:** Write `src/test-checkpoint.ts` that:
1. Creates an agent with `maxSteps: 2` and checkpoint enabled
2. Runs 2 steps against `cohere/north-mini-code:free`, confirming checkpoint file is written after each step
3. Deliberately hits the step limit (BudgetError)
4. Calls `AgentBudget.resume()` with `maxSteps: 4` and loads from checkpoint
5. Runs 2 more steps successfully
6. Confirms total step count across both runs is 4 and the message history is continuous
7. Calls `agent.clearCheckpoint()` and confirms the file is deleted