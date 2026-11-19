import assert from 'node:assert/strict';
import test from 'node:test';
import { completeJson } from '../src/provider';

test('lowers max_tokens when a provider rejects the requested cap', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  let call = 0;

  globalThis.fetch = (async (_input: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    headers.push(init.headers as Record<string, string>);
    call += 1;

    if (call <= 2) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'invalid max_tokens'
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const result = await completeJson('system', 'user', {
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      apiKey: 'test-key',
      jsonMode: false,
      timeoutMs: 1000,
      maxTokens: 32768,
      reasoningEffort: 'low'
    });

    assert.equal(result.text, '{"ok":true}');
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0].max_tokens, 32768);
    assert.equal(bodies[1].max_tokens, 32768);
    assert.equal('reasoning_effort' in bodies[1], false);
    assert.equal(bodies[2].max_tokens, 8192);
    assert.equal(headers[0]['User-Agent'], 'derust');
    assert.equal('x-opencode-session' in headers[0], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
