// Tests for src/lib/openai-compat.ts (provider selection, reply budgets,
// reply reading, JSON extraction).   node --test tests/ai-provider.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProvider, chatReplyText, extractJson, replyBudget } from '../src/lib/openai-compat.ts';

// Placeholder key values — never real credentials.
const get = (vars) => (name) => vars[name];

test('selectProvider: no keys -> null', () => {
  assert.equal(selectProvider(get({})), null);
});

test('selectProvider: only ZAI -> zai', () => {
  assert.equal(selectProvider(get({ ZAI_API_KEY: 'k' })), 'zai');
});

test('selectProvider: all three keys, AI_PROVIDER unset -> zai', () => {
  assert.equal(selectProvider(get({ ZAI_API_KEY: 'k', NVIDIA_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' })), 'zai');
});

test('selectProvider: NVIDIA + ANTHROPIC -> nvidia', () => {
  assert.equal(selectProvider(get({ NVIDIA_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' })), 'nvidia');
});

test('selectProvider: ANTHROPIC only -> anthropic', () => {
  assert.equal(selectProvider(get({ ANTHROPIC_API_KEY: 'k' })), 'anthropic');
});

test('selectProvider: AI_PROVIDER=nvidia with all keys -> nvidia', () => {
  assert.equal(
    selectProvider(get({ ZAI_API_KEY: 'k', NVIDIA_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', AI_PROVIDER: 'nvidia' })),
    'nvidia'
  );
});

test('selectProvider: AI_PROVIDER=Anthropic mixed case -> anthropic', () => {
  assert.equal(selectProvider(get({ ZAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', AI_PROVIDER: 'Anthropic' })), 'anthropic');
});

test('selectProvider: AI_PROVIDER=zai without ZAI key but NVIDIA key -> nvidia', () => {
  assert.equal(selectProvider(get({ NVIDIA_API_KEY: 'k', AI_PROVIDER: 'zai' })), 'nvidia');
});

const reply = (message, finish_reason) => ({ choices: [{ message, finish_reason }] });

test('chatReplyText: content wins', () => {
  assert.deepEqual(chatReplyText(reply({ content: '{"a":1}', reasoning_content: 'thinking' }, 'stop')), {
    text: '{"a":1}',
    finishReason: 'stop',
  });
});

test('chatReplyText: blank content falls back to reasoning_content', () => {
  assert.deepEqual(chatReplyText(reply({ content: '  ', reasoning_content: '{"a":1}', reasoning: 'other' }, 'stop')), {
    text: '{"a":1}',
    finishReason: 'stop',
  });
});

test('chatReplyText: null content falls back to reasoning', () => {
  assert.deepEqual(chatReplyText(reply({ content: null, reasoning: '{"a":1}' })), { text: '{"a":1}', finishReason: undefined });
});

test('chatReplyText: finish_reason passes through', () => {
  assert.equal(chatReplyText(reply({ content: 'x' }, 'length')).finishReason, 'length');
});

test('chatReplyText: empty choices -> empty text', () => {
  assert.deepEqual(chatReplyText({ choices: [] }), { text: '', finishReason: undefined });
});

test('extractJson: plain object', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson: fenced json', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJson: <think> prefix', () => {
  assert.deepEqual(extractJson('<think>reasoning {"b":2}</think>\n{"a":1}'), { a: 1 });
});

test('extractJson: prose around', () => {
  assert.deepEqual(extractJson('Here you go: {"a":1} — hope that helps'), { a: 1 });
});

test('extractJson: no object -> throws', () => {
  assert.throws(() => extractJson('no json here'));
});

test('replyBudget: zai thinking, no env cap -> 65536 (callMax ignored)', () => {
  assert.equal(replyBudget(16000, undefined, { zai: true, thinking: true }), 65536);
});

test('replyBudget: zai thinking, env cap 90000 -> 90000', () => {
  assert.equal(replyBudget(16000, '90000', { zai: true, thinking: true }), 90000);
});

test('replyBudget: zai thinking, env cap 200000 -> clamped to 131072', () => {
  assert.equal(replyBudget(16000, '200000', { zai: true, thinking: true }), 131072);
});

test('replyBudget: zai no thinking -> min(callMax, env cap)', () => {
  assert.equal(replyBudget(16000, '8000', { zai: true, thinking: false }), 8000);
});

test('replyBudget: nvidia, no env cap -> min(callMax, 8192)', () => {
  assert.equal(replyBudget(16000, undefined, { zai: false, thinking: false }), 8192);
});

test('replyBudget: nvidia, env cap 4000 -> 4000', () => {
  assert.equal(replyBudget(16000, '4000', { zai: false, thinking: false }), 4000);
});
