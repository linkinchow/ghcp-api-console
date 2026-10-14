import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { prepareClaudeCodeMessagesRequest, preprocessClaudeCodeMessagesBody } from './claudeCodeCompat.js';

test('keeps text outside a tool result that contains a tool reference', () => {
  const prepared = preprocessClaudeCodeMessagesBody({
    model: 'claude-opus-4.7',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_search',
          content: [{ tool_name: 'Bash', type: 'tool_reference' }],
        },
        { type: 'text', text: 'Tool loaded.' },
        { type: 'text', text: 'Run the loaded tool.' },
      ],
    }],
  });

  assert.deepEqual(prepared.messages, [{
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_search',
        content: [{ tool_name: 'Bash', type: 'tool_reference' }],
      },
      { type: 'text', text: 'Run the loaded tool.' },
    ],
  }]);
});

test('still merges sibling text into a normal tool result', () => {
  const prepared = preprocessClaudeCodeMessagesBody({
    model: 'claude-opus-4.7',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_bash',
          content: [{ type: 'text', text: 'command output' }],
        },
        { type: 'text', text: 'Continue from this output.' },
      ],
    }],
  });

  assert.deepEqual(prepared.messages, [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_bash',
      content: [
        { type: 'text', text: 'command output' },
        { type: 'text', text: 'Continue from this output.' },
      ],
    }],
  }]);
});

test('keeps model selection for the live catalog resolver', () => {
  for (const model of ['claude-opus-4.8', 'claude-opus-4-8', 'claude-opus-5-2']) {
    const prepared = preprocessClaudeCodeMessagesBody({ model, messages: [] });
    assert.equal(prepared.model, model);
  }
});

test('classifies an optimized generated continuation as agent initiated', () => {
  const prepared = prepareClaudeCodeMessagesRequest(request(), {
    model: 'claude-opus-4.7',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Partial answer' }] }],
  });

  assert.equal(prepared.forwardOptions.initiator, 'agent');
  assert.deepEqual(
    (prepared.body.messages as Array<Record<string, unknown>>).at(-1),
    { role: 'user', content: [{ type: 'text', text: 'Please continue.' }] },
  );
});

test('lets a valid incoming initiator override optimized compact inference', () => {
  const prepared = prepareClaudeCodeMessagesRequest(request(' User '), {
    model: 'claude-opus-4.7',
    messages: [{ role: 'user', content: '<compact-summary>state</compact-summary>' }],
  });

  assert.equal(prepared.forwardOptions.initiator, 'user');
  assert.equal(prepared.forwardOptions.interactionType, 'conversation-other');
});

function protocolRequest(beta?: string): Request {
  const header = (name: string): string | undefined => {
    if (name.toLowerCase() === 'anthropic-beta') return beta;
    if (name.toLowerCase() === 'anthropic-version') return '2023-06-01';
    return undefined;
  };
  return { get: header, header } as Request;
}

const effortBeta = 'mid-conversation-output-config-2026-07-01';

function effortBody(content: unknown = []): Record<string, unknown> {
  return {
    model: 'claude-opus-5.5',
    max_tokens: 8192,
    output_config: { effort: 'xhigh' },
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: "# currentDate\nToday's date is 2026-10-13.\n", cache_control: { type: 'ephemeral', scope: 'global' } }],
    tools: [{ name: 'mcp__ide__executeCode', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'Initial question' },
      { role: 'system', content, output_config: { effort: 'high' } },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Thinking...', signature: 'opaque@signature' }, { type: 'text', text: 'Prior answer' }] },
    ],
  };
}

for (const content of [[], [{ type: 'text', text: 'Operator instruction' }]]) {
  test(`preserves message-level effort protocol and all prior context with ${Array.isArray(content) && !content.length ? 'empty' : 'nonempty'} content`, () => {
    const body = effortBody(content);
    const original = structuredClone(body);
    const prepared = prepareClaudeCodeMessagesRequest(protocolRequest(effortBeta), body);
    assert.deepEqual(prepared.body, original);
    assert.deepEqual(body, original, 'caller input is not mutated');
    assert.notEqual(prepared.body, body);
    assert.equal(prepared.forwardOptions.anthropicBeta, effortBeta);
    assert.equal(prepared.forwardOptions.anthropicVersion, '2023-06-01');
  });
}

test('preserves the complete client beta value rather than a stale allowlist for message-level effort', () => {
  const beta = `${effortBeta},future-compatible-beta-2026-10-01,structured-outputs-2025-11-13`;
  const prepared = prepareClaudeCodeMessagesRequest(protocolRequest(beta), effortBody());
  assert.equal(prepared.forwardOptions.anthropicBeta, beta);
});

test('does not silently invent a beta or fix invalid message-level output_config', () => {
  const body = effortBody();
  (body.messages as Array<Record<string, unknown>>)[1] = { role: 'user', content: [], output_config: null };
  const prepared = prepareClaudeCodeMessagesRequest(protocolRequest(), body);
  assert.deepEqual(prepared.body, body);
  assert.equal(prepared.forwardOptions.anthropicBeta, undefined);
});

test('message-level effort keeps unsupported web-search preflight errors', () => {
  const body = effortBody();
  body.tools = [{ type: 'web_search_20260209', name: 'web_search' }];
  const prepared = prepareClaudeCodeMessagesRequest(protocolRequest(effortBeta), body);
  assert.equal(prepared.preflightError?.status, 400);
  assert.deepEqual(prepared.body, body);
});

test('keeps effort-only directives at every position without changing their order', () => {
  const messages = [
    { role: 'system', content: [], output_config: { effort: 'low' } },
    { role: 'user', content: 'Question' },
    { role: 'system', content: [], output_config: { effort: 'high' } },
    { role: 'assistant', content: 'Answer' },
    { role: 'system', content: [], output_config: { effort: 'xhigh' } },
  ];
  const prepared = prepareClaudeCodeMessagesRequest(protocolRequest(effortBeta), { model: 'claude-opus-5.5', messages });
  assert.deepEqual(prepared.body.messages, messages);
  assert.notEqual(prepared.body.messages, messages);
});

test('output_config text inside content does not disable legacy adaptation', () => {
  const prepared = prepareClaudeCodeMessagesRequest(protocolRequest(effortBeta), {
    model: 'claude-opus-4.7', messages: [{ role: 'assistant', content: 'Discuss output_config here.' }],
  });
  assert.equal(prepared.forwardOptions.anthropicBeta, undefined);
  assert.equal((prepared.body.messages as Array<Record<string, unknown>>).length, 2);
});

test('legacy requests retain the existing beta filtering and body adaptation', () => {
  const prepared = prepareClaudeCodeMessagesRequest(protocolRequest(`${effortBeta},context-1m-2025-08-07`), {
    model: 'claude-opus-4.7', messages: [{ role: 'assistant', content: 'Partial' }],
  });
  assert.equal(prepared.forwardOptions.anthropicBeta, 'context-1m-2025-08-07');
  assert.equal((prepared.body.messages as Array<Record<string, unknown>>).at(-1)?.role, 'user');
});

function request(initiator?: string): Request {
  const header = (name: string): string | undefined =>
    name.toLowerCase() === 'x-initiator' ? initiator : undefined;
  return { get: header, header } as Request;
}
