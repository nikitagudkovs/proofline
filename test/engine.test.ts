import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { agentEnv, claudeArgs, parseClaudeResult, parseStreamLine, type AgentRequest } from '../src/engine.js';

const req = (over: Partial<AgentRequest>): AgentRequest => ({
  role: 'builder',
  label: 'T1',
  prompt: 'p',
  cwd: '/tmp',
  schema: { type: 'object' },
  write: true,
  ...over,
});

test('subscription mode removes API keys from the agent environment', () => {
  const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't' };
  assert.deepEqual(agentEnv('subscription', env), { PATH: '/bin' });
  assert.deepEqual(agentEnv('inherit', env), env);
});

test('verifiers and planners get read-only tools; only builders can write', () => {
  const verifier = claudeArgs(req({ role: 'verifier', write: false }), DEFAULTS);
  assert.equal(verifier[verifier.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(verifier[verifier.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!verifier.includes('--allowedTools'));

  const builder = claudeArgs(req({}), DEFAULTS);
  assert.equal(builder[builder.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(builder.includes('--allowedTools'));
  assert.ok(!builder.includes('--tools'));
});

test('a model is passed only when one is configured for the role', () => {
  assert.ok(!claudeArgs(req({}), DEFAULTS).includes('--model'));
  const cfg = { ...DEFAULTS, models: { ...DEFAULTS.models, builder: 'sonnet' } };
  const args = claudeArgs(req({}), cfg);
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');

  // A model chosen for one task wins over the role's model.
  const perTask = claudeArgs(req({ model: 'opus' }), cfg);
  assert.equal(perTask[perTask.indexOf('--model') + 1], 'opus');
});

test('the live stream is reduced to the steps a person wants to see', () => {
  const line = (o: object) => JSON.stringify(o);
  assert.deepEqual(parseStreamLine(line({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' })).events, [
    { kind: 'start', text: 'session started on claude-sonnet-5-5', model: 'claude-sonnet-5-5' },
  ]);

  const assistant = line({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'hm' },
        { type: 'text', text: 'Adding the function.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'node --test\n  test/a.test.js' } },
        { type: 'tool_use', name: 'StructuredOutput', input: { status: 'done' } },
      ],
    },
  });
  assert.deepEqual(parseStreamLine(assistant).events, [
    { kind: 'text', text: 'Adding the function.' },
    { kind: 'tool', tool: 'Bash', text: 'node --test test/a.test.js' },
  ]);

  // Successful tool results are left out; a failed one is kept.
  const ok = line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'fine' }] } });
  const bad = line({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'exit 1' }] }] } });
  assert.deepEqual(parseStreamLine(ok).events, []);
  assert.deepEqual(parseStreamLine(bad).events, [{ kind: 'tool_result', failed: true, text: 'exit 1' }]);

  const result = line({ type: 'result', is_error: false, structured_output: { status: 'done' } });
  assert.equal(parseStreamLine(result).result, result);
  assert.deepEqual(parseStreamLine('not json').events, []);
});

test('the structured answer is read from the CLI result', () => {
  const out = JSON.stringify({
    is_error: false,
    structured_output: { verdict: 'pass', evidence: 'src/a.ts:3' },
    num_turns: 4,
    total_cost_usd: 0.12,
    duration_ms: 900,
    session_id: 'abc',
    modelUsage: { 'claude-sonnet-5-5': {} },
  });
  assert.deepEqual(parseClaudeResult(out), {
    output: { verdict: 'pass', evidence: 'src/a.ts:3' },
    turns: 4,
    costUsd: 0.12,
    durationMs: 900,
    sessionId: 'abc',
    model: 'claude-sonnet-5-5',
  });
});

test('a text-only answer is still parsed, and failures are not swallowed', () => {
  const text = JSON.stringify({ is_error: false, result: 'Here you go:\n{"verdict":"fail","evidence":"none"}' });
  assert.deepEqual(parseClaudeResult<{ verdict: string }>(text).output, { verdict: 'fail', evidence: 'none' });

  assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, result: 'usage limit reached' })), /usage limit reached/);
  assert.throws(() => parseClaudeResult('not json'), /no JSON result/);
});
