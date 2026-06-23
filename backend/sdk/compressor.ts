import type { OpenRouterMessage } from './types.js';

const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const COMPRESSION_MODEL = 'cohere/north-mini-code:free';
const CHARS_PER_TOKEN = 4;

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Character-based token approximation. 4 chars ≈ 1 token.
 * Good enough for threshold decisions — not for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimates total token count for a message array.
 */
export function estimateMessagesTokens(messages: OpenRouterMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    }
  }
  return total;
}

// ─── Compression ──────────────────────────────────────────────────────────────

/**
 * Compresses a message array by summarizing the middle section via an LLM call.
 *
 * Strategy:
 * 1. Preserve the system message (if present) — never touched.
 * 2. Preserve the last `keepLastN` messages — never touched.
 * 3. Everything in between is replaced with a single synthetic assistant
 *    message containing an LLM-generated summary.
 *
 * The summary is clearly marked so downstream code can detect it.
 */
export async function compressMessages(
  messages: OpenRouterMessage[],
  apiKey: string,
  keepLastN: number = 4
): Promise<OpenRouterMessage[]> {
  // Nothing to compress if we have fewer messages than the keep window
  if (messages.length <= keepLastN + 1) {
    return messages;
  }

  // Split: system message (if any) + middle messages + last N messages
  let systemMessage: OpenRouterMessage | null = null;
  let startIndex = 0;

  if (messages[0]?.role === 'system') {
    systemMessage = messages[0];
    startIndex = 1;
  }

  const endIndex = messages.length - keepLastN;
  const middleMessages = messages.slice(startIndex, endIndex);
  const lastNMessages = messages.slice(endIndex);

  if (middleMessages.length === 0) {
    return messages;
  }

  // Build the conversation text for summarization
  const conversationText = middleMessages
    .map((msg) => `[${msg.role}]: ${msg.content ?? ''}`)
    .join('\n\n');

  // Call LLM to generate summary
  const summaryContent = await generateSummary(conversationText, apiKey, middleMessages.length);

  // Build compressed message array
  const compressed: OpenRouterMessage[] = [];
  if (systemMessage) {
    compressed.push(systemMessage);
  }
  compressed.push({
    role: 'assistant',
    content: summaryContent,
  });
  compressed.push(...lastNMessages);

  return compressed;
}

// ─── Summary generation ───────────────────────────────────────────────────────

async function generateSummary(
  conversationText: string,
  apiKey: string,
  collapsedCount: number
): Promise<string> {
  const prompt =
    'You are a conversation summarizer for an AI agent loop. ' +
    'Summarize the following conversation between a user and an assistant. ' +
    'Focus on:\n' +
    '- What was discussed\n' +
    '- What decisions were made\n' +
    '- What tool calls were made\n' +
    '- What the current goal state is\n\n' +
    'Keep the summary concise but comprehensive. Output ONLY the summary text, no preamble.\n\n' +
    `Conversation:\n${conversationText}`;

  const res = await fetch(OPENROUTER_CHAT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: COMPRESSION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // If the LLM call fails (rate limit, etc.), use a heuristic fallback
    console.warn(`[agent-budget] Compression summary LLM call failed (${res.status}), using heuristic fallback`);
    const heuristic = makeHeuristicSummary(conversationText, collapsedCount);
    return `[COMPRESSED SUMMARY — ${collapsedCount} messages collapsed]\n${heuristic}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const summary: string = json.choices?.[0]?.message?.content ?? '';

  return `[COMPRESSED SUMMARY — ${collapsedCount} messages collapsed]\n${summary}`;
}

/**
 * Heuristic fallback when the LLM summary call fails.
 * Extracts key topics from the conversation text to produce a basic summary.
 */
function makeHeuristicSummary(conversationText: string, collapsedCount: number): string {
  const lines = conversationText.split('\n').filter(Boolean);
  const userLines = lines.filter(l => l.startsWith('[user]:'));
  const assistantLines = lines.filter(l => l.startsWith('[assistant]:'));

  // Extract key topics by finding noun phrases from user messages
  const keyPhrases: string[] = [];
  for (const line of userLines.slice(0, 5)) {
    const words = line.replace(/\[user\]:\s*/i, '').split(' ');
    const topic = words.slice(0, 8).join(' ');
    keyPhrases.push(topic);
  }

  const summary = `The conversation covered ${collapsedCount} exchanges between user and assistant. ` +
    `Key topics discussed include: ${keyPhrases.join('; ')}. ` +
    `The assistant provided ${assistantLines.length} responses with explanations, code examples, and guidance.`;

  return summary;
}
