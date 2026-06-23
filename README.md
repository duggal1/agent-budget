# agent-budget

Budget enforcement for LLM agents. Track token, cost, and step usage in real time. Enforce limits before and after every LLM call. Works with any provider.

```
npm install budget-agent
```

## Why

LLM calls cost money. Agent loops multiply that cost across every step. Without guardrails, a runaway agent can burn through credits before you notice.

This SDK sits between your agent and the LLM provider. It tracks every call, checks your budget before each one, and stops the agent when it hits a limit. The step is rolled back from the tracker, so you can retry without a stale balance.

## Quick start

```ts
import { AgentBudget } from 'budget-agent';

const agent = new AgentBudget({
  apiKey: process.env.OPENROUTER_API_KEY,
  limits: { maxCostUSD: 0.05, maxSteps: 10 },
});

const response = await agent.step({
  model: 'anthropic/claude-opus-4.8-fast',
  messages: [{ role: 'user', content: 'Hello' }],
});

console.log(agent.getUsage());
// { steps: 1, totalCostUSD: 0.000015, totalInputTokens: 12, ... }
```

## How it works

You provide the model, the messages, and your API key. The SDK:

1. Checks budget before the call (pre-flight)
2. Makes the API request to your provider
3. Tracks tokens, cost, and duration
4. Checks budget after the call (post-step)
5. Emits events for streaming, warnings, and overages

No provider is bundled. No model is defaulted. You bring everything.

### Limits

```ts
limits: {
  maxCostUSD:      0.05,   // total USD before the agent aborts
  maxSteps:        10,     // total LLM calls before abort
  maxInputTokens:  50000,  // total input tokens sent to models
  maxOutputTokens: 10000,  // total output tokens received
  maxTotalTokens:  60000,  // input + output combined
  maxWallTimeMs:   60000,  // 60 seconds wall clock
}
```

Each limit is optional. Omit what you do not want to enforce.

#### How enforcement works

Each call to `step()` runs two checks:

- Pre-flight. Before the API call. Estimates output cost (defaults to 512 tokens) and catches over-budget calls before spending money.
- Post-step. After recording the real token and cost data. If a limit is exceeded, the step is rolled back from the tracker so you can retry.

```ts
const agent = new AgentBudget({
  apiKey: key,
  limits: { maxCostUSD: 0.01, maxSteps: 3 },
});

try {
  await agent.step({ model, messages });
} catch (err) {
  if (err instanceof BudgetError) {
    console.log(err.exceeded.reason); // 'cost' | 'steps' | 'wallTime' | ...
  }
}
```

#### Custom callback instead of abort

```ts
const agent = new AgentBudget({
  apiKey: key,
  limits: { maxCostUSD: 0.01 },
  onExceeded: (usage) => {
    console.log('Over budget: $' + usage.totalCostUSD);
    // Log, alert, switch models. Does not throw.
  },
});
```

#### Tune pre-flight estimation

```ts
limits: {
  maxCostUSD: 0.05,
  preflightCheck: false,              // skip pre-flight entirely
  preflightOutputTokenEstimate: 2048, // safety buffer, default 512
}
```

#### Warning thresholds

```ts
const agent = new AgentBudget({
  limits: { maxCostUSD: 0.10 },
  warningThreshold: 0.5, // fire 'budget:warning' at 50% consumption
});

agent.on('budget:warning', (e) => {
  // { reason: 'cost', pctConsumed: 0.51, remaining: 0.049 }
});
```

#### Combine with adaptive routing

```ts
const agent = new AgentBudget({
  apiKey: key,
  limits: { maxCostUSD: 5.00 },
  adaptiveRouting: {
    fallbackChain: [
      'anthropic/claude-opus-4.8-fast',
      'openai/gpt-4o',
      'openrouter/free',
    ],
    thresholds: [0.4, 0.75],
  },
});
```

The router selects a cheaper model as the budget depletes. Each step checks current consumption against the thresholds before making the API call.

## Bring your own executor

Use any LLM provider with a custom executor.

```ts
import { AgentBudget } from 'budget-agent';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const agent = new AgentBudget({
  apiKey: process.env.OPENAI_API_KEY,
  limits: { maxCostUSD: 0.10 },
  executor: async (request) => {
    const completion = await openai.chat.completions.create({
      model: request.model,
      messages: request.messages,
    });
    return {
      model: completion.model,
      usage: {
        prompt_tokens: completion.usage?.prompt_tokens ?? 0,
        completion_tokens: completion.usage?.completion_tokens ?? 0,
        total_tokens: completion.usage?.total_tokens ?? 0,
      },
      choices: completion.choices.map(c => ({
        message: { role: c.message.role, content: c.message.content ?? '' },
        finish_reason: c.finish_reason ?? 'stop',
      })),
    };
  },
});
```

Or use raw fetch to any API:

```ts
const agent = new AgentBudget({
  apiKey: 'none',
  limits: { maxCostUSD: 0.05 },
  executor: async (request) => {
    const res = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      body: JSON.stringify({ model: request.model, messages: request.messages }),
    });
    const data = await res.json();
    return {
      model: data.model,
      usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      choices: data.messages?.map((m) => ({
        message: { role: m.role, content: m.content },
        finish_reason: 'stop',
      })) ?? [],
    };
  },
});
```

## Built-in OpenRouter support

By default, the SDK calls OpenRouter's API. Configure the endpoint and headers:

```ts
const agent = new AgentBudget({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseUrl: 'https://openrouter.ai/api/v1',
  siteUrl: 'https://mysite.com',
  appTitle: 'My App',
  defaultHeaders: { 'X-Custom': 'value' },
  limits: { maxCostUSD: 0.10 },
});
```

Works with any OpenAI-compatible endpoint: OpenRouter, OpenAI, Together AI, Fireworks, LocalAI, Ollama.

## Features

- Budget enforcement. Set limits on cost, tokens, steps, wall time. Checked pre-flight and post-step.
- Auto-compress. Truncate message history with an LLM summary when token count exceeds a threshold.
- Circuit breaker. Detect repetition or stagnation and halt the agent.
- Adaptive routing. Downgrade to cheaper models as budget depletes.
- Checkpoints. Save and resume agent state across restarts.
- Events. Subscribe to lifecycle events (`step:start`, `step:end`, `step:token`, `budget:exceeded`).
- Pricing cache. Model pricing fetched from OpenRouter with configurable TTL.
- Rate-limit retry. Automatic 429 retry with exponential backoff (3 attempts).
- Streaming. Set `stream: true` and listen for `step:token` events.
- OpenTelemetry. Optional spans via `telemetry: { enabled: true }` (requires `@opentelemetry/api`).
- Provider error handling. Detects errors in OpenRouter's `choices[0].error` and throws `UpstreamError`.

## API

### `new AgentBudget(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | - | Your provider API key |
| `limits.*` | `object` | - | Budget limits (cost, tokens, steps, wall time) |
| `executor` | `AgentExecutor` | - | Custom API executor (replaces built-in fetch) |
| `baseUrl` | `string` | `https://openrouter.ai/api/v1` | API base URL for built-in fetch |
| `defaultHeaders` | `object` | - | Extra HTTP headers for built-in fetch |
| `autoCompress` | `object` | - | Auto-compress messages at token threshold |
| `circuitBreaker` | `object` | - | Detect repetition/stagnation loops |
| `adaptiveRouting` | `object` | - | Downgrade model tiers as budget depletes |
| `checkpoint` | `object` | - | Persist and resume agent state |
| `onExceeded` | `'abort' \| function` | `'abort'` | Strategy when budget exceeded |
| `onEvent` | `function` | - | Global event listener |
| `pricingCacheTTLMs` | `number` | `300_000` | Pricing cache TTL |
| `siteUrl` | `string` | - | OpenRouter HTTP-Referer |
| `appTitle` | `string` | - | OpenRouter X-OpenRouter-Title |
| `telemetry` | `object` | - | Enable OpenTelemetry spans |

### `agent.step(request)`

Make one LLM call. Checks limits before and after. Throws `BudgetError` if exceeded.

```ts
const response = await agent.step({
  model: 'anthropic/claude-opus-4.8-fast',
  messages: [{ role: 'user', content: 'Hi' }],
  stream: true,
});
```

When a step exceeds budget, the step is recorded for circuit-breaker analysis, then rolled back before throwing. The tracker stays clean for retry. The actual spend is available in the `BudgetError`.

### `agent.getUsage()`

Returns a snapshot of current usage:

```ts
{
  steps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  elapsedMs: number;
  stepHistory: StepUsage[];
}
```

### `agent.summary()`

Prints a formatted table to console and returns the same usage snapshot.

### `agent.reset()`

Reset all usage counters.

### `agent.compressMessages(messages, keepLastN?)`

Manually compress a message array via LLM summary.

### `agent.loadCheckpoint()` / `agent.clearCheckpoint()`

Load or clear persisted checkpoint state.

### `AgentBudget.resume(options, checkpointPath?)`

Static factory. Creates a new agent pre-loaded with checkpoint state.

## Events

```ts
agent.on('step:start', (event) => console.log('Step', event.stepIndex, 'started'));
agent.on('step:token', (event) => process.stdout.write(event.token));
agent.on('step:end', (event) => console.log('Step cost:', event.costUSD));
agent.on('budget:exceeded', (event) => console.log('Limit hit:', event.exceeded.reason));
agent.on('compress:triggered', (event) => console.log('Compressed:', event.messagesBefore, '->', event.messagesAfter));
agent.on('model:downgraded', (event) => console.log('Downgraded to', event.to));
```

## Exports

```ts
import {
  AgentBudget,
  BudgetError,
  RateLimitError,
  UpstreamError,
  createAgentBudget,
  getModelPricing,
  calculateCost,
  setModelPricing,
  invalidatePricingCache,
  estimateStepCost,
  compressMessages,
  estimateMessagesTokens,
  CircuitBreaker,
  resolveModel,
  CheckpointManager,
  AgentEventEmitter,
} from 'budget-agent';
```

## Testing

```
npm test
```

Runs 10 real-API tests against OpenRouter with simulated pricing. No mocking. All tests make real API calls.

## License

MIT
