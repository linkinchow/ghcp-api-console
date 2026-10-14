import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATIC_CONTINUE_PROMPT, resolveRequestIntent } from './requestIntent.js';

test('normalizes a valid incoming initiator and lets it override inference', () => {
  const intent = resolveRequestIntent(
    '/v1/messages',
    { messages: [{ role: 'user', content: '<compact-summary>state</compact-summary>' }] },
    ' User ',
  );

  assert.deepEqual(intent, {
    initiator: 'user',
    interactionType: 'conversation-other',
  });
});

test('ignores an invalid incoming initiator and infers Anthropic tool continuations', () => {
  const intent = resolveRequestIntent(
    '/v1/messages',
    {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
      }],
    },
    'service',
  );

  assert.equal(intent.initiator, 'agent');
});

test('identifies Anthropic automatic continuation and ordinary user prompts', () => {
  assert.equal(
    resolveRequestIntent('/v1/messages', {
      messages: [{ role: 'user', content: [{ type: 'text', text: AUTOMATIC_CONTINUE_PROMPT }] }],
    }).initiator,
    'agent',
  );
  assert.equal(
    resolveRequestIntent('/v1/messages', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Explain this code.' }] }],
    }).initiator,
    'user',
  );
});

for (const content of [
  [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
  [{ type: 'text', text: AUTOMATIC_CONTINUE_PROMPT }],
]) {
  test(`effort-only control messages do not hide ${content[0]!.type} continuation intent`, () => {
    const intent = resolveRequestIntent('/v1/messages', {
      messages: [
        { role: 'user', content },
        { role: 'system', content: [], output_config: { effort: 'high' } },
        { role: 'system', content: [], output_config: { effort: 'low' } },
      ],
    });
    assert.equal(intent.initiator, 'agent');
  });
}

test('effort controls do not override an explicit initiator or reclassify nonempty system input', () => {
  const messages = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
    { role: 'system', content: [], output_config: { effort: 'high' } },
  ];
  assert.equal(resolveRequestIntent('/v1/messages', { messages }, 'user').initiator, 'user');
  assert.equal(resolveRequestIntent('/v1/messages', {
    messages: [messages[0], { role: 'system', content: [{ type: 'text', text: 'New operator instruction' }], output_config: { effort: 'high' } }],
  }).initiator, 'user');
});

test('identifies Chat Completions tool continuations', () => {
  assert.equal(
    resolveRequestIntent('/chat/completions', {
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'done' }],
    }).initiator,
    'agent',
  );
  assert.equal(
    resolveRequestIntent('/chat/completions', {
      messages: [{ role: 'user', content: 'Continue.' }],
    }).initiator,
    'user',
  );
});

test('identifies Responses tool call outputs', () => {
  assert.equal(
    resolveRequestIntent('/responses', {
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'done' }],
    }).initiator,
    'agent',
  );
  assert.equal(
    resolveRequestIntent('/responses', {
      input: [{ type: 'message', role: 'user', content: 'Continue.' }],
    }).initiator,
    'user',
  );
});
