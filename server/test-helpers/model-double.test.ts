/**
 * Proves the model double, because a stub that answers in the wrong shape does not fail — it makes
 * the code under test take its error branch, and the test then passes while asserting the wrong
 * thing. The specific trap these cover is the difference between the chat envelope
 * (`choices[0].message.content`, a JSON *string*) and the transcription envelope (`text`, plain);
 * they are not variations of one shape, and a stub that confuses them reads as a model that
 * replied with nothing.
 *
 * The last two tests are about the other half of the double's job: it must not be possible for a
 * test to reach the real provider through it, and restoring must not open the network either —
 * under `npm test` the `fetch` that was in place beforehand is the refusal installed by
 * `seal-network.mjs`, and putting that back is the point.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  chatCompletion,
  installModelDouble,
  providerError,
  transcription,
  type ModelCall,
} from './model-double.ts';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const nativeFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = nativeFetch;
});

describe('the reply envelopes', () => {
  test('a chat reply carries the content where the server reads it', async () => {
    const body = (await chatCompletion('plain words').json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(body.choices[0]?.message.content, 'plain words');
  });

  test('an object answer arrives as a JSON string, because the content is parsed and not read', async () => {
    const body = (await chatCompletion({ amount: 1250, currency: 'INR' }).json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = body.choices[0]?.message.content ?? '';
    assert.equal(typeof content, 'string');
    assert.deepEqual(JSON.parse(content), { amount: 1250, currency: 'INR' });
  });

  test('a transcription is not a chat reply, and says so', async () => {
    const body = (await transcription('the tenant agreed to pay by Friday').json()) as {
      text: string;
      choices?: unknown;
    };
    assert.equal(body.text, 'the tenant agreed to pay by Friday');
    assert.equal(body.choices, undefined);
  });

  test('a refusal keeps the status and the message where the server looks for them', async () => {
    const response = providerError(429, 'Rate limit reached', 'rate_limit_exceeded');
    assert.equal(response.status, 429);
    const body = (await response.json()) as { error: { message: string; code?: string } };
    assert.equal(body.error.message, 'Rate limit reached');
    assert.equal(body.error.code, 'rate_limit_exceeded');
  });
});

describe('what the double records', () => {
  test('names the host, path, method and model of each call', async () => {
    const double = installModelDouble(() => 'ok');
    try {
      await fetch(GROQ, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-fixture-only', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const call = double.calls[0] as ModelCall;
      assert.equal(call.host, 'api.groq.com');
      assert.equal(call.path, '/openai/v1/chat/completions');
      assert.equal(call.method, 'POST');
      assert.equal(call.model, 'openai/gpt-oss-120b');
      assert.equal(call.headers['authorization'], 'Bearer test-fixture-only');
      assert.equal(double.count, 1);
    } finally {
      double.restore();
    }
  });

  test('flattens the messages into one string, so a marker can be looked for', async () => {
    const double = installModelDouble(() => 'ok');
    try {
      await fetch(GROQ, {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'Answer only in JSON.' },
            { role: 'user', content: 'LABEL_MARKER: the electricity bill' },
          ],
        }),
      });
      assert.match(double.prompts[0] ?? '', /LABEL_MARKER/);
      assert.match(double.prompts[0] ?? '', /Answer only in JSON/);
    } finally {
      double.restore();
    }
  });

  test('flattens the text parts of a vision call, where the content is an array and not a string', async () => {
    const double = installModelDouble(() => 'ok');
    try {
      await fetch(GROQ, {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Read this receipt.' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
              ],
            },
          ],
        }),
      });
      assert.equal(double.prompts[0], 'Read this receipt.');
    } finally {
      double.restore();
    }
  });

  test('keeps a body it cannot parse, so an audio upload can still be asserted on', async () => {
    const double = installModelDouble(() => transcription('words'));
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'meeting.wav');
      form.append('model', 'whisper-large-v3');
      await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', body: form });
      const call = double.calls[0] as ModelCall;
      assert.equal(call.path, '/openai/v1/audio/transcriptions');
      assert.equal(call.body, undefined);
      assert.ok(call.raw instanceof FormData);
      assert.equal((call.raw as FormData).get('model'), 'whisper-large-v3');
    } finally {
      double.restore();
    }
  });

  test('records the hosts in order, which is the shape a failover assertion needs', async () => {
    const double = installModelDouble((call) =>
      call.host === 'api.groq.com' ? providerError(503, 'upstream unavailable') : 'ok',
    );
    try {
      await fetch(GROQ, { method: 'POST', body: '{}' });
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
      assert.deepEqual([...double.hosts], ['api.groq.com', 'api.openai.com']);
    } finally {
      double.restore();
    }
  });
});

describe('how an answer is given', () => {
  test('a Response is used exactly as returned, so a broken body can be tested', async () => {
    const double = installModelDouble(() => new Response('not json at all', { status: 200 }));
    try {
      const response = await fetch(GROQ, { method: 'POST', body: '{}' });
      assert.equal(await response.text(), 'not json at all');
    } finally {
      double.restore();
    }
  });

  test('a thrown answer stays thrown rather than falling through to anything else', async () => {
    const double = installModelDouble(() => {
      throw new Error('the test decided this call should fail');
    });
    try {
      await assert.rejects(() => fetch(GROQ, { method: 'POST', body: '{}' }), /should fail/);
      assert.equal(double.count, 1);
    } finally {
      double.restore();
    }
  });
});

describe('restoring', () => {
  test('puts back the fetch that was there before, not the real one', async () => {
    const sealed = async () => {
      throw new Error('network refused by the suite');
    };
    globalThis.fetch = sealed as typeof globalThis.fetch;
    const double = installModelDouble(() => 'ok');
    assert.notEqual(globalThis.fetch, sealed);
    double.restore();
    assert.equal(globalThis.fetch, sealed);
    await assert.rejects(() => fetch(GROQ), /network refused by the suite/);
    globalThis.fetch = nativeFetch;
  });

  test('is safe to call twice, so a second restore cannot re-open a stub', () => {
    const marker = (async () => new Response('marker')) as typeof globalThis.fetch;
    globalThis.fetch = marker;
    const first = installModelDouble(() => 'ok');
    const second = installModelDouble(() => 'also ok');
    second.restore();
    second.restore();
    first.restore();
    assert.equal(globalThis.fetch, marker);
    globalThis.fetch = nativeFetch;
  });
});
