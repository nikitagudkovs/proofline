import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixReview, reviewRun } from '../src/finish.js';
import { createRun, executeRun } from '../src/runner.js';
import { startServer } from '../src/server.js';
import { shipRun } from '../src/ship.js';
import { loadState, runDir } from '../src/state.js';
import { git } from '../src/util.js';
import { ScriptedEngine, done, fakeGitHub, fixture, workspace, writes } from './helpers.js';

const CONTRACT = `
goal: A hello endpoint and a screen that calls it
criteria:
  - { id: C1, text: The backend lists a hello route, proof: { command: "cd api && grep -q 'GET /hello' routes.txt" } }
  - { id: C2, text: The frontend calls the hello route, proof: { command: "cd web && grep -q 'fetch /hello' client.txt" } }
`;
const PLAN = `tasks:
  - { id: T1, repo: api, title: hello route, brief: add the route, covers: [C1], needs: [] }
  - { id: T2, repo: web, title: hello screen, brief: call the route, covers: [C2], needs: [T1] }
`;
const SETTINGS = `models: { verifier: sonnet, reviewer: opus }
reviewInstructions: |
  Every route checks who is asking.
`;

const FOUND = {
  verdict: 'approve', // the reviewer's own word is not trusted: a blocker decides
  summary: 'The route answers anyone.',
  findings: [
    { severity: 'note', where: 'web/client.txt:1', what: 'No retry.', why: 'Fine for now.' },
    { severity: 'blocker', where: 'api/routes.txt:1', what: 'The route has no sign-in check.', why: 'Anyone can call it.' },
    { severity: 'should', where: 'web/client.txt:1', what: 'The error is swallowed.', why: 'A failure looks like success.' },
  ],
};

test('a review reads the whole change across the repositories and records what it finds', async () => {
  const ws = await workspace(CONTRACT, PLAN, SETTINGS);
  const engine = new ScriptedEngine({
    T1: writes({ 'routes.txt': 'GET /hello\n' }),
    T2: writes({ 'client.txt': 'fetch /hello\n' }),
    REVIEW: () => FOUND,
  });
  const ctx = ws.ctx(engine);
  const state = await executeRun(ctx, await createRun(ctx));
  assert.equal(state.status, 'proven');

  const review = await reviewRun(ctx, state);
  const asked = engine.requests.find((r) => r.label === 'REVIEW')!;

  // Independent and read-only, on the reviewer's own model, standing above both repositories.
  assert.equal(asked.write, false);
  assert.equal(asked.model, 'opus');
  assert.equal(asked.cwd, path.dirname(await git(path.join(asked.cwd, 'api'), 'rev-parse', '--show-toplevel')));
  // It is handed the change itself, with paths as they read from where it stands, and the team's own checklist.
  assert.match(asked.prompt, /\+\+\+ b\/api\/routes\.txt\n@@.*\n\+GET \/hello/);
  assert.match(asked.prompt, /\+\+\+ b\/web\/client\.txt/);
  assert.match(asked.prompt, /Every route checks who is asking\./);
  assert.match(asked.prompt, /The seam:/);

  // A blocker means changes are needed, whatever the reviewer called it; the worst comes first.
  assert.equal(review.verdict, 'changes');
  assert.deepEqual(review.findings.map((f) => f.severity), ['blocker', 'should', 'note']);
  assert.match(review.head, /^api@[0-9a-f]{7} web@[0-9a-f]{7}$/);

  // It is saved with the run and written into the report, and it does not change what is proven.
  const saved = loadState(ws.root, state.id);
  assert.equal(saved.review?.findings.length, 3);
  assert.equal(saved.status, 'proven');
  const report = readFileSync(path.join(runDir(ws.root, state.id), 'report.md'), 'utf8');
  assert.match(report, /## Review of the whole change\n\n\*\*Changes needed\*\*/);
  assert.match(report, /- \*\*Blocker\*\* `api\/routes\.txt:1`: The route has no sign-in check\. Anyone can call it\./);
  assert.match(readFileSync(path.join(runDir(ws.root, state.id), 'report.html'), 'utf8'), /Review of the whole change/);
});

test('findings go back to one builder, the contract is proven again and the open pull requests are updated', async () => {
  const ws = await workspace(CONTRACT, PLAN);
  const gh = await fakeGitHub(ws.root);
  try {
    const engine = new ScriptedEngine({
      T1: writes({ 'routes.txt': 'GET /hello\n' }),
      T2: writes({ 'client.txt': 'fetch /hello\n' }),
      REVIEW: () => FOUND,
      // The fixer stands above both repositories and may change either.
      RFIX1: (req) => {
        writeFileSync(path.join(req.cwd, 'api', 'routes.txt'), 'GET /hello (signed in)\n');
        return done('added the check');
      },
    });
    const ctx = ws.ctx(engine);
    const state = await executeRun(ctx, await createRun(ctx));
    await assert.rejects(fixReview(ctx, state), /not been reviewed yet/);

    await shipRun(ctx, state, false);
    await reviewRun(ctx, state);
    const name = await fixReview(ctx, state);

    assert.equal(name, 'RFIX1');
    const sent = engine.requests.find((r) => r.label === 'RFIX1')!;
    // Blockers and "fix soon" go back; a note does not.
    assert.match(sent.prompt, /1\. api\/routes\.txt:1\n   The route has no sign-in check\./);
    assert.match(sent.prompt, /2\. web\/client\.txt:1/);
    assert.doesNotMatch(sent.prompt, /No retry\./);

    // The fix is merged, every line was checked again, and the pull request shows it.
    assert.equal(state.rounds.length, 2);
    assert.equal(state.status, 'proven');
    assert.equal(state.review?.sentBack, 'RFIX1');
    assert.equal(await git(gh.remote('api'), 'show', `${state.branch}:routes.txt`), 'GET /hello (signed in)');
    assert.match(readFileSync(path.join(runDir(ws.root, state.id), 'report.md'), 'utf8'), /These findings went back to a builder \(RFIX1\)/);

    // The same findings are not sent twice.
    await assert.rejects(fixReview(ctx, state), /already went back/);
  } finally {
    gh.restore();
  }
});

test('a fix that breaks a line of the contract leaves the run not proven', async () => {
  const fx = await fixture(
    `goal: A greeting\ncriteria:\n  - { id: C1, text: It greets, proof: { command: "grep -q hello greeting.txt" } }\n`,
    `tasks:\n  - { id: T1, title: greet, brief: write it, covers: [C1], needs: [] }\n`,
  );
  const engine = new ScriptedEngine({
    T1: writes({ 'greeting.txt': 'hello\n' }),
    REVIEW: () => ({ verdict: 'approve', summary: 'Works.', findings: [{ severity: 'should', where: 'greeting.txt:1', what: 'Too informal.', why: 'Tone.' }] }),
    RFIX1: writes({ 'greeting.txt': 'good day\n' }),
  });
  const ctx = fx.ctx(engine);
  const state = await executeRun(ctx, await createRun(ctx));

  const review = await reviewRun(ctx, state);
  // One repository: plain paths in the change, no seam to look at, and no blocker means it may merge.
  const asked = engine.requests.find((r) => r.label === 'REVIEW')!;
  assert.match(asked.prompt, /\+\+\+ b\/greeting\.txt/);
  assert.doesNotMatch(asked.prompt, /The seam:/);
  assert.equal(review.verdict, 'approve');

  // Only blockers were asked for, and there are none.
  await assert.rejects(fixReview(ctx, state, false), /nothing to send back/);

  await fixReview(ctx, state);
  assert.equal(state.status, 'unproven');
  assert.equal(loadState(fx.root, state.id).rounds.at(-1)?.results[0].verdict, 'fail');
});

test('the control room starts a review, shows its findings and sends them back', async () => {
  const ws = await workspace(CONTRACT, PLAN);
  const engine = () =>
    new ScriptedEngine({
      T1: writes({ 'routes.txt': 'GET /hello\n' }),
      T2: writes({ 'client.txt': 'fetch /hello\n' }),
      REVIEW: () => FOUND,
      RFIX1: (req) => {
        writeFileSync(path.join(req.cwd, 'web', 'client.txt'), 'fetch /hello, show errors\n');
        return done('shows errors');
      },
    });
  const server = await startServer(ws.root, { port: 0, host: '127.0.0.1', engine });
  const call = async (url: string, body: unknown = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${url}`, {
      method: body === null ? 'GET' : 'POST',
      headers: { 'x-proofline-token': server.token, 'content-type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const idle = async () => {
    for (let i = 0; i < 200 && (await call('/api/overview', null)).json.job; i++) await new Promise((r) => setTimeout(r, 25));
  };
  try {
    const { id } = (await call('/api/runs')).json;
    await idle();
    // Nothing to send back before there is a review.
    assert.equal((await call(`/api/runs/${id}/review/fix`)).status, 409);

    assert.equal((await call(`/api/runs/${id}/review`)).status, 200);
    await idle();
    const reviewed = (await call(`/api/runs/${id}`, null)).json;
    assert.equal(reviewed.state.review.verdict, 'changes');
    // The reviewer's session is kept like any other, so a person can read how it got there.
    assert.ok(reviewed.sessions.some((s: any) => s.label === 'REVIEW' && s.role === 'verifier'));
    assert.ok(reviewed.log.some((l: any) => /review: 1 blocker, 1 to fix soon, 1 notes/.test(l.msg)));

    assert.equal((await call(`/api/runs/${id}/review/fix`)).status, 200);
    await idle();
    const fixed = (await call(`/api/runs/${id}`, null)).json;
    assert.equal(fixed.state.review.sentBack, 'RFIX1');
    assert.equal(fixed.state.tasks.RFIX1.status, 'merged');
    assert.equal(fixed.state.status, 'proven');
  } finally {
    await server.close();
  }
});
