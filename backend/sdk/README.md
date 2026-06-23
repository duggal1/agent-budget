# @painitehq/agent-budget

Budget-aware enforcement layer for LLM agents. Track token, cost, and step usage in real time. Enforce limits before and after every LLM call. Works with any provider.

```
npm install @painitehq/agent-budget
```

## Quick start

You bring your own API key and model. The SDK calls your provider.

```ts
import { AgentBudget } from '@painitehq/agent-budget';

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

You provide the **model**, the **messages**, and your **API key**. The SDK:

1. Checks budget before the call (pre-flight)
2. Makes the API request to your provider
3. Tracks tokens, cost, and duration
4. Checks budget after the call (post-step)
5. Emits events for streaming, warnings, and overages

No provider is bundled. No model is defaulted. You bring everything.

## Limits

Budget guardrails that stop your agent before it spends too much:

```ts
limits: {
  maxCostUSD:     0.05,   // total USD before the agent aborts
  maxSteps:       10,     // total LLM calls before abort
  maxInputTokens: 50000,  // total input tokens sent to models
  maxOutputTokens: 10000, // total output tokens received
  maxTotalTokens:  60000, // input + output combined
  maxWallTimeMs:   60000, // 60 seconds wall clock
}
```

Every limit is optional. Omit what you don't want to enforce.

### How enforcement works

Each `step()` runs two checks:

1. **Pre-flight** — before the API call. Estimates output cost (default 512 tokens) and catches over-budget calls before burning money.
2. **Post-step** — after recording the real token/cost. If exceeded, the step is **rolled back** from the tracker so you can retry without a stale balance.

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

### Custom callback instead of abort

```ts
const agent = new AgentBudget({
  apiKey: key,
  limits: { maxCostUSD: 0.01 },
  onExceeded: (usage) => {
    // Log, alert, switch models — never throws
    console.log(`Over budget: $${usage.totalCostUSD}`);
  },
});
```

### Tune pre-flight estimation

```ts
limits: {
  maxCostUSD: 0.05,
  preflightCheck: false,              // skip pre-flight entirely
  preflightOutputTokenEstimate: 2048, // safety buffer (default 512)
}
```

### Warning thresholds (non-blocking)

```ts
const agent = new AgentBudget({
  limits: { maxCostUSD: 0.10 },
  warningThreshold: 0.5, // fire 'budget:warning' at 50% consumption
});

agent.on('budget:warning', (e) => {
  // { reason: 'cost', pctConsumed: 0.51, remaining: 0.049 }
});
```

### Combine with adaptive routing

```ts
const agent = new AgentBudget({
  apiKey: key,
  limits: { maxCostUSD: 5.00 },
  adaptiveRouting: {
    fallbackChain: [
      'anthropic/claude-opus-4.8-fast', // $15/M tokens — best model
      'openai/gpt-4o',                  // $5/M tokens
      'openrouter/free',                // $0 — emergency
    ],
    thresholds: [0.4, 0.75], // downgrade at 40% and 75% of budget consumed
  },
});
```

The router downgrades the model tier as the budget depletes. Each `step()` checks the current consumption against the thresholds and selects the appropriate model from the chain before the API call.

## Bring your own executor

Use any LLM provider — OpenAI, Anthropic, Ollama, local models, or the OpenRouter Agent SDK:

```ts
import { AgentBudget } from '@painitehq/agent-budget';
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

const response = await agent.step({
  model: 'anthropic/claude-opus-4.8-fast',
  messages: [{ role: 'user', content: 'Hello' }],
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
      choices: data.messages?.map((m: any) => ({
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
  baseUrl: 'https://openrouter.ai/api/v1',        // default — change for any OpenAI-compatible API
  siteUrl: 'https://mysite.com',                   // OpenRouter attribution
  appTitle: 'My App',                              // OpenRouter attribution
  defaultHeaders: { 'X-Custom': 'value' },         // extra headers for every request
  limits: { maxCostUSD: 0.10 },
});
```

Works with any OpenAI-compatible endpoint: OpenRouter, OpenAI, Together AI, Fireworks, LocalAI, Ollama (with compat layer), etc.

## Features

- **Budget enforcement** — set limits on cost, tokens, steps, wall time. Checked pre-flight and post-step.
- **Auto-compress** — truncate message history with an LLM summary when token count exceeds a threshold.
- **Circuit breaker** — detect repetition or stagnation and halt the agent.
- **Adaptive routing** — downgrade to cheaper models as budget depletes.
- **Checkpoints** — save and resume agent state across restarts.
- **Events** — subscribe to lifecycle events (`step:start`, `step:end`, `step:token`, `budget:exceeded`, etc.).
- **Pricing cache** — model pricing fetched from OpenRouter with configurable TTL (or use `setModelPricing()` for any model).
- **Rate-limit retry** — automatic 429 retry with exponential backoff (3 attempts).
- **Streaming** — set `stream: true` and listen for `step:token` events.
- **OpenTelemetry** — optional spans via `telemetry: { enabled: true }` (requires `@opentelemetry/api`).

## API

### `new AgentBudget(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | — | Your provider API key |
| `limits.*` | `object` | — | Budget limits (cost, tokens, steps, wall time) |
| `executor` | `AgentExecutor` | — | Custom API executor (replaces built-in fetch) |
| `baseUrl` | `string` | `https://openrouter.ai/api/v1` | API base URL for built-in fetch |
| `defaultHeaders` | `object` | — | Extra HTTP headers for built-in fetch |
| `autoCompress` | `object` | — | Auto-compress messages at token threshold |
| `circuitBreaker` | `object` | — | Detect repetition/stagnation loops |
| `adaptiveRouting` | `object` | — | Downgrade model tiers as budget depletes |
| `checkpoint` | `object` | — | Persist and resume agent state |
| `onExceeded` | `'abort' \| function` | `'abort'` | Strategy when budget exceeded |
| `onEvent` | `function` | — | Global event listener |
| `pricingCacheTTLMs` | `number` | `300_000` | Pricing cache TTL |
| `siteUrl` | `string` | — | OpenRouter HTTP-Referer |
| `appTitle` | `string` | — | OpenRouter X-OpenRouter-Title |
| `telemetry` | `object` | — | Enable OpenTelemetry spans |

### `agent.step(request)`

Make one LLM call. Checks limits before and after. Throws `BudgetError` if exceeded.

```ts
const response = await agent.step({
  model: 'anthropic/claude-opus-4.8-fast',            // any model slug
  messages: [{ role: 'user', content: 'Hi' }],
  stream: true,                        // optional — emit step:token events
});
```

**Budget enforcement with rollback.** When a step exceeds budget, the step is recorded for circuit-breaker analysis, then rolled back before throwing. The tracker stays clean for retry. The actual spend is available in the `BudgetError`.

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
agent.on('compress:triggered', (event) => console.log('Compressed:', event.messagesBefore, '→', event.messagesAfter));
agent.on('model:downgraded', (event) => console.log('Downgraded to', event.to));
```

## Testing

```
npm test
```

Runs 10 real-API tests against OpenRouter with simulated pricing.

## License

MIT
