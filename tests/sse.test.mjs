// Tests for the SSE accumulator in src/lib/openai-compat.ts (streaming
// chat completions).   node --test tests/sse.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseAccumulator } from '../src/lib/openai-compat.ts';

const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d, finish_reason = null) => ({ choices: [{ delta: d, finish_reason }] });
// Push a stream in small pieces so every chunk boundary (mid-line, mid-JSON,
// mid multi-byte-looking escape) gets exercised.
const pushChopped = (acc, text, size = 7) => {
  for (let i = 0; i < text.length; i += size) acc.push(text.slice(i, i + size));
};

test('content split across chunks mid-line and mid-JSON reassembles', () => {
  const acc = createSseAccumulator('Z.ai');
  pushChopped(
    acc,
    frame(delta({ content: 'Hello' })) + frame(delta({ content: ' world' }, 'stop')) + 'data: [DONE]\n\n'
  );
  assert.deepEqual(acc.end(), { text: 'Hello world', finishReason: 'stop' });
});

test('\\r\\n line endings are handled', () => {
  const acc = createSseAccumulator('Z.ai');
  pushChopped(
    acc,
    'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"b"},"finish_reason":"length"}]}\r\n\r\ndata: [DONE]\r\n\r\n'
  );
  assert.deepEqual(acc.end(), { text: 'ab', finishReason: 'length' });
});

test('comment, event: and id: lines are ignored', () => {
  const acc = createSseAccumulator('Z.ai');
  pushChopped(
    acc,
    ': keepalive\n\nid: 42\nevent: message\ndata: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n: keepalive\ndata: [DONE]\n'
  );
  assert.deepEqual(acc.end(), { text: 'x', finishReason: 'stop' });
});

test('a data line whose JSON does not parse is ignored, stream continues', () => {
  const acc = createSseAccumulator('Z.ai');
  pushChopped(acc, 'data: {oops\n\ndata: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n');
  assert.deepEqual(acc.end(), { text: 'ok', finishReason: 'stop' });
});

test('reasoning-only stream: text is the reasoning', () => {
  const acc = createSseAccumulator('Z.ai');
  pushChopped(acc, frame(delta({ reasoning_content: 'first ' })) + frame(delta({ reasoning_content: 'thoughts' }, 'stop')) + 'data: [DONE]\n');
  assert.deepEqual(acc.end(), { text: 'first thoughts', finishReason: 'stop' });
});

test('reasoning-only stream via delta.reasoning field', () => {
  const acc = createSseAccumulator('NVIDIA');
  pushChopped(acc, frame(delta({ reasoning: 'plan B' }, 'stop')) + 'data: [DONE]\n');
  assert.deepEqual(acc.end(), { text: 'plan B', finishReason: 'stop' });
});

test('content plus reasoning: text is the content', () => {
  const acc = createSseAccumulator('Z.ai');
  pushChopped(
    acc,
    frame(delta({ reasoning_content: 'let me think' })) + frame(delta({ content: '{"a":1}' }, 'stop')) + 'data: [DONE]\n'
  );
  assert.deepEqual(acc.end(), { text: '{"a":1}', finishReason: 'stop' });
});

test('last non-null finish_reason wins (length over stop, null does not clobber)', () => {
  const acc = createSseAccumulator('Z.ai');
  pushChopped(
    acc,
    frame(delta({ content: 'long' }, 'stop')) + frame(delta({}, 'length')) + frame(delta({})) + 'data: [DONE]\n'
  );
  assert.deepEqual(acc.end(), { text: 'long', finishReason: 'length' });
});

test('[DONE] terminates: frames after it are ignored', () => {
  const acc = createSseAccumulator('Z.ai');
  acc.push('data: {"choices":[{"delta":{"content":"before"},"finish_reason":"stop"}]}\n');
  acc.push('data: [DONE]\n');
  acc.push('data: {"choices":[{"delta":{"content":"AFTER"}}]}\n');
  assert.deepEqual(acc.end(), { text: 'before', finishReason: 'stop' });
});

test('an error frame throws with the provider name', () => {
  const acc = createSseAccumulator('Z.ai');
  assert.throws(
    () => acc.push(frame({ error: { message: 'Rate limited', code: 429 } })),
    /Z\.ai API error: \{"message":"Rate limited","code":429\}/
  );
});

test('plain non-SSE JSON body falls back to chatReplyText', () => {
  const acc = createSseAccumulator('Z.ai');
  pushChopped(acc, '{"choices":[{"message":{"content":"{\\"ok\\":true}","reasoning_content":"why"},"finish_reason":"stop"}]}');
  assert.deepEqual(acc.end(), { text: '{"ok":true}', finishReason: 'stop' });
});

test('plain JSON body with blank content falls back to reasoning_content', () => {
  const acc = createSseAccumulator('Z.ai');
  pushChopped(acc, '{"choices":[{"message":{"content":"  ","reasoning_content":"the answer"},"finish_reason":"stop"}]}');
  assert.deepEqual(acc.end(), { text: 'the answer', finishReason: 'stop' });
});
