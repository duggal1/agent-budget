---
title: Quickstart
subtitle: Get started with OpenRouter
slug: quickstart
headline: OpenRouter Quickstart Guide | Developer Documentation
canonical-url: 'https://openrouter.ai/docs/quickstart'
'og:site_name': OpenRouter Documentation
'og:title': OpenRouter Quickstart Guide
'og:description': >-
  Get started with OpenRouter's unified API for hundreds of AI models. Learn how
  to integrate using the API directly, the Client SDKs, or the Agent SDK.
'og:image':
  type: url
  value: >-
    https://openrouter.ai/dynamic-og?pathname=quickstart&title=Quick%20Start&description=Start%20using%20OpenRouter%20API%20in%20minutes%20with%20any%20SDK
'og:image:width': 1200
'og:image:height': 630
'twitter:card': summary_large_image
'twitter:site': '@OpenRouter'
noindex: false
nofollow: false
---

OpenRouter provides a unified API that gives you access to hundreds of AI models through a single endpoint, while automatically handling fallbacks and selecting the most cost-effective options.

There are three ways to integrate with OpenRouter, depending on how much control you want:

| Approach | Best for |
|----------|----------|
| **[API](#using-the-openrouter-api)** | Full control, any language, no dependencies |
| **[Client SDKs](#using-the-client-sdks)** | Type-safe model calls with minimal overhead |
| **[Agent SDK](#using-the-agent-sdk)** | Building agents with tool use, loops, and state |

<Note>
  ```
  Read https://github.com/OpenRouterTeam/skills/tree/main/skills/create-agent-tui and follow the instructions to build an agent using OpenRouter.
  ```
</Note>

<Tip>
  Looking for information about free models and rate limits? Please see the [FAQ](/docs/faq#how-are-rate-limits-calculated)
</Tip>

In the examples below, the OpenRouter-specific headers are optional. Setting them allows your app to appear on the OpenRouter leaderboards. For detailed information about app attribution, see our [App Attribution guide](/docs/app-attribution).

---

## Using the OpenRouter API

The most direct way to use OpenRouter. Send standard HTTP requests to the `/api/v1/chat/completions` endpoint — compatible with any language or framework.

<Tip>
  You can use the interactive [Request Builder](https://openrouter.ai/request-builder) to generate OpenRouter API requests in the language of your choice.
</Tip>

<Note>
  The examples below use `~openai/gpt-latest`, a [latest alias](/docs/guides/routing/routers/latest-resolution) that always resolves to the newest OpenAI flagship model — so your code keeps using the freshest version without redeploying. You can substitute any model slug here. Browse the full catalog at [openrouter.ai/models](https://openrouter.ai/models), or list every available slug programmatically via the [`GET /api/v1/models`](/docs/api-reference/models/get-models) endpoint.
</Note>

<CodeGroup>

```python title="Python"

response = requests.post(
  url="https://openrouter.ai/api/v1/chat/completions",
  headers={
    "Authorization": "Bearer <OPENROUTER_API_KEY>",
    "HTTP-Referer": "<YOUR_SITE_URL>", # Optional. Site URL for rankings on openrouter.ai.
    "X-OpenRouter-Title": "<YOUR_SITE_NAME>", # Optional. Site title for rankings on openrouter.ai.
  },
  data=json.dumps({
    "model": "~openai/gpt-latest",
    "messages": [
      {
        "role": "user",
        "content": "What is the meaning of life?"
      }
    ]
  })
)
```

```typescript title="TypeScript (fetch)"
fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer <OPENROUTER_API_KEY>',
    'HTTP-Referer': '<YOUR_SITE_URL>', // Optional. Site URL for rankings on openrouter.ai.
    'X-OpenRouter-Title': '<YOUR_SITE_NAME>', // Optional. Site title for rankings on openrouter.ai.
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '~openai/gpt-latest',
    messages: [
      {
        role: 'user',
        content: 'What is the meaning of life?',
      },
    ],
  }),
});
```

```shell title="Shell"
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
  "model": "~openai/gpt-latest",
  "messages": [
    {
      "role": "user",
      "content": "What is the meaning of life?"
    }
  ]
}'
```

</CodeGroup>

The API also supports [streaming](/docs/api/reference/streaming). You can also use the [OpenAI SDK](#using-the-openai-sdk) pointed at OpenRouter as a drop-in replacement.

---

## Using the Client SDKs

The [Client SDKs](/docs/client-sdks/overview) wrap the OpenRouter API with full type safety, auto-generated types from the OpenAPI spec, and zero boilerplate. It is intentionally lean — a thin layer over the REST API.

First, install the SDK:

<CodeGroup>
```bash title="npm"
npm install @openrouter/sdk
```

```bash title="yarn"
yarn add @openrouter/sdk
```

```bash title="pnpm"
pnpm add @openrouter/sdk
```

```bash title="pip"
pip install openrouter
```
</CodeGroup>

Then use it in your code:

<CodeGroup>

```typescript title="TypeScript"

const client = new OpenRouter({
  apiKey: '<OPENROUTER_API_KEY>',
  httpReferer: '<YOUR_SITE_URL>', // Optional. Site URL for rankings on openrouter.ai.
  appTitle: '<YOUR_SITE_NAME>', // Optional. Site title for rankings on openrouter.ai.
});

const completion = await client.chat.send({
  model: '~openai/gpt-latest',
  messages: [
    {
      role: 'user',
      content: 'What is the meaning of life?',
    },
  ],
});

console.log(completion.choices[0].message.content);
```

```python title="Python"
from openrouter import OpenRouter

with OpenRouter(api_key=os.getenv("OPENROUTER_API_KEY")) as client:
    response = client.chat.send(
        model="~openai/gpt-latest",
        messages=[
            {"role": "user", "content": "What is the meaning of life?"}
        ],
    )

    print(response.choices[0].message.content)
```

</CodeGroup>

See the full [Client SDKs documentation](/docs/client-sdks/overview) for streaming, embeddings, and the complete API reference.

---

## Using the Agent SDK

The [Agent SDK](/docs/agent-sdk/overview) (`@openrouter/agent`) provides higher-level primitives for building AI agents. It handles multi-turn conversation loops, tool execution, and state management automatically via the `callModel` function.

Install the package:

<CodeGroup>
```bash title="npm"
npm install @openrouter/agent
```

```bash title="pnpm"
pnpm add @openrouter/agent
```

```bash title="yarn"
yarn add @openrouter/agent
```
</CodeGroup>

Build an agent with tools:

```typescript

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  inputSchema: z.object({
    location: z.string().describe('City name'),
  }),
  execute: async ({ location }) => {
    return { temperature: 72, condition: 'sunny', location };
  },
});

const result = await callModel({
  model: '~anthropic/claude-sonnet-latest',
  messages: [
    { role: 'user', content: 'What is the weather in San Francisco?' },
  ],
  tools: [weatherTool],
});

const text = await result.getText();
console.log(text);
```

The SDK sends the prompt, receives a tool call from the model, executes `get_weather`, feeds the result back, and returns the final response — all in one `callModel` invocation.

See the full [Agent SDK documentation](/docs/agent-sdk/overview) for stop conditions, streaming, dynamic parameters, and more.

---

## Using the OpenAI SDK

You can also use the OpenAI SDK pointed at OpenRouter as a drop-in replacement. This is useful if you have existing code built on the OpenAI SDK and want to access OpenRouter's model catalog without changing your code structure.

<CodeGroup>

```typescript title="Typescript"

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: '<OPENROUTER_API_KEY>',
  defaultHeaders: {
    'HTTP-Referer': '<YOUR_SITE_URL>', // Optional. Site URL for rankings on openrouter.ai.
    'X-OpenRouter-Title': '<YOUR_SITE_NAME>', // Optional. Site title for rankings on openrouter.ai.
  },
});

async function main() {
  const completion = await openai.chat.completions.create({
    model: '~openai/gpt-latest',
    messages: [
      {
        role: 'user',
        content: 'What is the meaning of life?',
      },
    ],
  });

  console.log(completion.choices[0].message);
}

main();
```

```python title="Python"
from openai import OpenAI

client = OpenAI(
  base_url="https://openrouter.ai/api/v1",
  api_key="<OPENROUTER_API_KEY>",
)

completion = client.chat.completions.create(
  extra_headers={
    "HTTP-Referer": "<YOUR_SITE_URL>", # Optional. Site URL for rankings on openrouter.ai.
    "X-OpenRouter-Title": "<YOUR_SITE_NAME>", # Optional. Site title for rankings on openrouter.ai.
  },
  model="~openai/gpt-latest",
  messages=[
    {
      "role": "user",
      "content": "What is the meaning of life?"
    }
  ]
)

print(completion.choices[0].message.content)
```
</CodeGroup>

## Using third-party SDKs

For information about using third-party SDKs and frameworks with OpenRouter, please [see our frameworks documentation.](/docs/guides/community/frameworks-and-integrations-overview)