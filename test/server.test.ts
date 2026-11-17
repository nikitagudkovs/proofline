import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { startServer } from '../src/server.js';
import { ScriptedEngine, fixture, writes } from './helpers.js';

const CONTRACT = `
goal: Ship two files
criteria:
  - { id: C1, text: a.txt exists, proof: { command: "test -f a.txt" } }
  - { id: C2, text: The README names a.txt, proof: { review: "Does README.md name a.txt?" } }
`;
const PLAN = `tasks:
  - { id: T1, title: write a, brief: create a.txt, covers: [C1, C2], needs: [] }
`;

async function boot() {
  const fx = await fixture(CONTRACT, PLAN);
  const engine = new ScriptedEngine({
    T1: writes({ 'a.txt': 'a\n', 'README.md': '# demo\n\na.txt\n' }),
    C2: () => ({ verdict: 'pass', evidence: 'README.md:3' }),
    contract: () => ({
      goal: 'Add a changelog',
      criteria: [{ id: 'x', text: 'CHANGELOG.md exists', proof_type: 'command', proof: 'test -f CHANGELOG.md' }],
    }),
  });
  const server = await startServer(fx.root, { port: 0, host: '127.0.0.1', engine: () => engine });
  const call = async (method: string, path: string, body?: unknown, token = server.token) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { 'x-proofline-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  /** Wait until the background job has finished. */
  const idle = async () => {
    for (let i = 0; i < 200; i++) {
      const { json } = await call('GET', '/api/overview');
      if (!json.job) return json;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the job never finished');
  };
  return { fx, engine, server, call, idle };
}

test('the server answers only to requests that carry its token and a known host', async () => {
  const { server, call } = await boot();
  try {
    assert.equal((await call('GET', '/api/overview', undefined, 'wrong')).status, 403);
    assert.equal((await call('POST', '/api/runs', {}, '')).status, 403);

    // A page on another site that resolves its own name to this machine (DNS rebinding) is refused,
    // even with the right token.
    const rebound = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.port, path: '/api/overview', headers: { host: 'evil.example', 'x-proofline-token': server.token } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
    assert.equal(rebound, 403);

    const ok = await call('GET', '/api/overview');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.contract.approved, true);
    assert.deepEqual(ok.json.plan.problems, []);
  } finally {
    await server.close();
  }
});

test('a run started from the UI is built, verified and readable session by session', async () => {
  const { server, call, idle } = await boot();
  try {
    const started = await call('POST', '/api/runs', {});
    assert.equal(started.status, 200);
    // Only one job at a time: they share the repository.
    assert.equal((await call('POST', '/api/plan/draft', {})).status, 409);

    const overview = await idle();
    assert.equal(overview.lastError, '');
    assert.deepEqual(overview.runs.map((r: any) => [r.status, r.proven, r.total]), [['proven', 1 + 1, 2]]);

    const run = (await call('GET', `/api/runs/${started.json.id}`)).json;
    assert.equal(run.state.status, 'proven');
    assert.equal(run.current, true);
    assert.deepEqual(run.sessions.map((s: any) => s.id).sort(), ['C2-1', 'T1-1']);
    assert.equal(run.sessions[0].prompt, undefined); // briefs are sent only with the session itself
    assert.ok(run.log.some((l: any) => /T1 merged/.test(l.msg)));

    const session = (await call('GET', `/api/runs/${started.json.id}/sessions/T1-1`)).json;
    assert.match(session.meta.prompt, /Your task T1/);
    assert.deepEqual(session.events.map((e: any) => e.kind), ['start', 'tool', 'tool']);
    assert.match(session.changes, /a\.txt/);

    const report = await fetch(`http://127.0.0.1:${server.port}/api/runs/${started.json.id}/report.html?token=${server.token}`);
    assert.match(await report.text(), /Proven: 2 of 2 criteria/);
  } finally {
    await server.close();
  }
});

test('the contract can be edited from the UI, and an edit voids the approval and the plan', async () => {
  const { server, call, idle } = await boot();
  try {
    const bad = await call('PUT', '/api/contract', { goal: '', outOfScope: [], criteria: [] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.problems.join('\n'), /goal is missing/);

    const saved = await call('PUT', '/api/contract', {
      goal: 'Ship two files',
      outOfScope: [],
      criteria: [{ id: 'C1', text: 'b.txt exists', proof: { type: 'command', run: 'test -f b.txt' } }],
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.contract.approved, false);
    assert.match(saved.json.plan.problems.join('\n'), /different version of the contract/);
    assert.equal((await call('POST', '/api/runs', {})).status, 500); // nothing runs on an unapproved contract

    // The planner drafts a new contract in the background; its session is kept too.
    assert.equal((await call('POST', '/api/contract/draft', { goal: 'Add a changelog' })).status, 200);
    const after = await idle();
    assert.equal(after.contract.contract.goal, 'Add a changelog');
    assert.equal(after.contract.contract.criteria[0].id, 'C1');
    assert.deepEqual(after.authoring.sessions.map((s: any) => [s.id, s.role, s.status]), [['contract-1', 'planner', 'done']]);
  } finally {
    await server.close();
  }
});

test('models and run settings are saved from the UI without touching other settings', async () => {
  const { server, call } = await boot();
  try {
    await call('PUT', '/api/config', { models: { builder: 'sonnet' }, concurrency: 5 });
    const { json } = await call('PUT', '/api/config', { models: { verifier: 'haiku' } });
    assert.deepEqual(json.config.models, { planner: '', builder: 'sonnet', verifier: 'haiku' });
    assert.equal(json.config.concurrency, 5);
    assert.equal(json.config.maxFixRounds, 2);
  } finally {
    await server.close();
  }
});
