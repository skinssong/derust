import { randomUUID } from 'crypto';

export type ProviderSettings = {
  baseUrl: string;
  model: string;
  apiKey: string;
  jsonMode: boolean;
  timeoutMs: number;
  maxTokens: number;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  userAgent?: string;
};

export type CompleteResult = {
  text: string;
  usage?: { input: number; output: number };
  finishReason?: string;
};

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

type ChatBody = {
  model: string;
  temperature: number;
  max_tokens?: number;
  messages: Message[];
  response_format?: { type: 'json_object' };
  reasoning_effort?: string;
};

const DEFAULT_USER_AGENT = 'derust';
const OPENCODE_SESSION_HEADER = 'x-opencode-session';
const MAX_ERROR_BODY = 500;

export async function completeJson(
  system: string,
  user: string,
  settings: ProviderSettings,
  signal?: AbortSignal
): Promise<CompleteResult> {
  return complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    settings,
    signal
  );
}

/**
 * Second attempt after a reply that was not the requested JSON object: hand the
 * model its own reply back and ask it to convert that reply into the JSON.
 * Temperature is 0, so repeating the same request verbatim tends to reproduce
 * the same failure; extending the conversation changes it.
 */
export async function completeJsonRepair(
  system: string,
  user: string,
  previousReply: string,
  settings: ProviderSettings,
  signal?: AbortSignal
): Promise<CompleteResult> {
  const previous = previousReply.trim();
  if (!previous) {
    return completeJson(system, user, settings, signal);
  }
  return complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: previous.slice(-8000) },
      {
        role: 'user',
        content:
          'That reply was not the JSON object the task requires. Rewrite it as exactly the JSON object described in the instructions, beginning with { and ending with }. Return only the JSON.'
      }
    ],
    settings,
    signal
  );
}

async function complete(
  messages: Message[],
  settings: ProviderSettings,
  signal?: AbortSignal
): Promise<CompleteResult> {
  const body: ChatBody = {
    model: settings.model,
    temperature: 0,
    max_tokens: settings.maxTokens,
    messages,
    reasoning_effort: settings.reasoningEffort
  };

  if (settings.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  let droppedJsonMode = false;
  let droppedEffort = false;

  for (let attempt = 0; attempt <= 4; attempt += 1) {
    const response = await post(body, settings, signal);
    const raw = await response.text();

    if (response.status === 400 && body.response_format && !droppedJsonMode) {
      droppedJsonMode = true;
      delete body.response_format;
      continue;
    }

    if (response.status === 400 && body.reasoning_effort && !droppedEffort) {
      droppedEffort = true;
      delete body.reasoning_effort;
      continue;
    }

    if (response.status === 400 && body.max_tokens !== undefined && body.max_tokens > 8192) {
      body.max_tokens = 8192;
      continue;
    }

    if (response.status === 400 && body.max_tokens !== undefined) {
      delete body.max_tokens;
      continue;
    }

    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await delay(600 * (attempt + 1));
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Provider returned ${response.status} ${response.statusText}: ${redact(bound(raw), settings.apiKey)}`
      );
    }

    const data = parseJson(raw);
    const finishReason = extractFinishReason(data);
    const content = extractContent(data, finishReason);
    const usage = extractUsage(data);
    return { text: stripFences(content), usage, finishReason };
  }

  throw new Error('Provider request failed after retries.');
}

async function post(body: ChatBody, settings: ProviderSettings, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const onAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    return await fetch(endpoint(settings.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': settings.userAgent ?? DEFAULT_USER_AGENT,
        ...(isOpenCode(settings.baseUrl)
          ? { [OPENCODE_SESSION_HEADER]: `derust-${randomUUID()}` }
          : {})
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(signal?.aborted ? 'Analysis cancelled.' : `Provider request timed out after ${settings.timeoutMs / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function isOpenCode(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

function extractContent(data: unknown, finishReason?: string): string {
  if (!isObject(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error('Provider response had no choices.');
  }

  const choice = data.choices[0];
  if (!isObject(choice) || !isObject(choice.message)) {
    throw new Error('Provider response had no message.');
  }

  const emptyMessage =
    finishReason === 'length'
      ? 'Provider hit the output cap before writing any text (finish_reason: length). Raise derust.maxOutputTokens or lower reasoning effort.'
      : 'Provider returned an empty message. The output cap was probably consumed by reasoning tokens.';

  const content = choice.message.content;
  if (typeof content === 'string') {
    if (!content.trim()) {
      throw new Error(emptyMessage);
    }
    return content;
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
    if (joined.trim()) {
      return joined;
    }
  }

  throw new Error('Provider response had no text content.');
}

function extractFinishReason(data: unknown): string | undefined {
  if (!isObject(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    return undefined;
  }
  const choice = data.choices[0];
  return isObject(choice) && typeof choice.finish_reason === 'string'
    ? choice.finish_reason
    : undefined;
}

function extractUsage(data: unknown): { input: number; output: number } | undefined {
  if (!isObject(data) || !isObject(data.usage)) {
    return undefined;
  }

  const input = typeof data.usage.prompt_tokens === 'number' ? data.usage.prompt_tokens : 0;
  const output = typeof data.usage.completion_tokens === 'number' ? data.usage.completion_tokens : 0;
  return { input, output };
}

function stripFences(value: string): string {
  let text = value.trim();
  if (!text.startsWith('```')) {
    return text;
  }

  text = text.replace(/^```[a-zA-Z]*\s*\n?/, '');
  text = text.replace(/\n?```\s*$/, '');
  return text.trim();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Provider response was not valid JSON.');
  }
}

function redact(value: string, apiKey: string): string {
  return apiKey ? value.replaceAll(apiKey, '[redacted]') : value;
}

function bound(value: string): string {
  return value.length <= MAX_ERROR_BODY ? value : `${value.slice(0, MAX_ERROR_BODY)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
