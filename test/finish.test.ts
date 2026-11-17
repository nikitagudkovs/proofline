import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mergeRun, purgeRun, reached, runAction } from '../src/finish.js';
import { createRun, executeRun, withSessions } from '../src/runner.js';
import { startServer } from '../src/server.js';
import { shipRun } from '../src/ship.js';
import { loadState, runDir, sessionsDir } from '../src/state.js';
import { git, gitTry } from '../src/util.js';
import { ScriptedEngine, fakeGitHub, fixture, workspace, writes } from './helpers.js';

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
const ACTIONS = `actions:
  - name: Tell the tracker
    run: 'printf "%s %s\\n%s\\n" "$PROOFLINE_RUN" "$PROOFLINE_STATUS" "$PROOFLINE_PRS" > told.txt'
    auto: merged
  - name: Deploy
    run: 'echo deploying; exit 3'
    needs: merged
    confirm: Really deploy?
`;
const builders = () => new ScriptedEngine({ T1: writes({ 'routes.txt': 'GET /hello\n' }), T2: writes({ 'client.txt': 'fetch /hello\n' }) });

test('a proven run is merged where its pull requests point, and the team\'s own last steps follow', async () => {
  const ws = await workspace(CONTRACT, PLAN, ACTIONS);
  const gh = await fakeGitHub(ws.root);
  try {
    const ctx = ws.ctx(builders());
    const state = await executeRun(ctx, await createRun(ctx));
    assert.equal(state.status, 'proven');

    // Nothing is merged, and no later step runs, before there is a pull request.
    await assert.rejects(mergeRun(ctx, state), /no pull request yet/);
    await assert.rejects(runAction(ctx, state, ctx.cfg.actions[1]), /is for a run that is merged/);

    await shipRun(ctx, state, false);
    assert.deepEqual([reached(state, 'shipped'), reached(state, 'merged')], [true, false]);
    await mergeRun(ctx, state);

    assert.ok(reached(state, 'merged'));
    assert.match(gh.calls(), /^api pr merge https:\/\/example\.test\/api\/pull\/1 --merge$/m);
    assert.match(gh.calls(), /^web pr merge https:\/\/example\.test\/web\/pull\/1 --merge$/m);
    // The pushed branch is removed once it is merged.
    assert.notEqual((await gitTry(gh.remote('api'), 'rev-parse', '--verify', '-q', state.branch)).code, 0);

    // The action set to follow a merge ran by itself, in the workspace folder, knowing the run and its pull requests.
    assert.equal(
      readFileSync(path.join(ws.root, 'told.txt'), 'utf8'),
      `${state.id} proven\nhttps://example.test/api/pull/1\nhttps://example.test/web/pull/1\n`,
    );
    assert.deepEqual(state.actions?.map((a) => [a.name, a.ok]), [['Tell the tracker', true]]);

    // A failing action is recorded as failed, with what it printed.
    assert.equal(await runAction(ctx, state, ctx.cfg.actions[1]), false);
    assert.deepEqual(loadState(ws.root, state.id).actions?.map((a) => [a.name, a.ok, a.output]).pop(), ['Deploy', false, 'deploying']);

    // Merging again does nothing new.
    await mergeRun(ctx, state);
    assert.equal(gh.calls().split('\n').filter((l) => / pr merge /.test(l)).length, 2);
  } finally {
    gh.restore();
  }
});

test('a run that is not proven is never merged', async () => {
  const ws = await workspace(CONTRACT, PLAN);
  const gh = await fakeGitHub(ws.root);
  try {
    ws.cfg.maxFixRounds = 0;
    const ctx = ws.ctx(new ScriptedEngine({ T1: writes({ 'routes.txt': 'GET /hello\n' }), T2: writes({ 'client.txt': 'fetch /helo\n' }) }));
    const state = await executeRun(ctx, await createRun(ctx));
    await shipRun(ctx, state, true); // a draft is allowed
    await assert.rejects(mergeRun(ctx, state), /not proven, so it is not merged/);
    assert.doesNotMatch(gh.calls(), / pr merge /);
  } finally {
    gh.restore();
  }
});

test('cleaning up removes copies, session records and merged branches, and keeps work that exists nowhere else', async () => {
  const ws = await workspace(CONTRACT, PLAN);
  const gh = await fakeGitHub(ws.root);
  try {
    const base = ws.ctx(builders());
    const state = await createRun(base);
    const ctx = withSessions(base, state.id);
    await executeRun(ctx, state);
    await shipRun(ctx, state, false);
    await mergeRun(ctx, state);

    assert.deepEqual(await purgeRun(ctx, state), []);
    assert.ok(!existsSync(state.worktreeRoot));
    assert.ok(!existsSync(sessionsDir(ws.root, state.id)));
    assert.ok(existsSync(path.join(runDir(ws.root, state.id), 'report.md')));
    assert.equal(loadState(ws.root, state.id).cleaned, true);
    for (const repo of ['api', 'web']) {
      assert.equal(await git(path.join(ws.root, repo), 'branch', '--list', 'proofline*'), '');
      assert.equal((await git(path.join(ws.root, repo), 'worktree', 'list')).split('\n').length, 1);
    }
  } finally {
    gh.restore();
  }

  // Not shipped, not merged: the branch is the only copy of the work, so it stays and is named.
  const fx = await fixture(
    `goal: Add a file\ncriteria:\n  - { id: C1, text: a.txt exists, proof: { command: "test -f a.txt" } }\n`,
    `tasks:\n  - { id: T1, title: write a, brief: create a.txt, covers: [C1], needs: [] }\n`,
  );
  const ctx = fx.ctx(new ScriptedEngine({ T1: writes({ 'a.txt': 'a\n' }) }));
  const state = await executeRun(ctx, await createRun(ctx));
  assert.deepEqual(await purgeRun(ctx, state), [state.branch]);
  assert.equal(await git(fx.root, 'show', `${state.branch}:a.txt`), 'a');
  assert.ok(!existsSync(state.worktreeRoot));
});

test('the control room runs only the actions the settings file names', async () => {
  const ws = await workspace(CONTRACT, PLAN, `actions:\n  - name: Note it\n    run: 'echo noted > noted.txt'\n`);
  const server = await startServer(ws.root, { port: 0, host: '127.0.0.1', engine: () => builders() });
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
    assert.deepEqual((await call(`/api/runs/${id}`, null)).json.stage, { proven: true, shipped: false, merged: false });

    // The browser names an action; it cannot supply a command of its own.
    assert.equal((await call(`/api/runs/${id}/actions`, { name: 'rm -rf', run: 'touch hacked' })).status, 404);
    const put = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
      method: 'PUT',
      headers: { 'x-proofline-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ actions: [{ name: 'x', run: 'touch hacked' }] }),
    });
    assert.deepEqual(((await put.json()) as any).config.actions.map((x: any) => x.name), ['Note it']);

    assert.equal((await call(`/api/runs/${id}/actions`, { name: 'Note it' })).status, 200);
    await idle();
    assert.equal(readFileSync(path.join(ws.root, 'noted.txt'), 'utf8'), 'noted\n');
    const run = (await call(`/api/runs/${id}`, null)).json;
    assert.deepEqual(run.state.actions.map((a: any) => [a.name, a.ok]), [['Note it', true]]);

    const cleaned = (await call(`/api/runs/${id}/clean`, { all: true })).json;
    assert.equal(cleaned.kept.length, 2); // nothing was pushed, so both branches stay
    assert.equal((await call(`/api/runs/${id}`, null)).json.state.cleaned, true);
  } finally {
    await server.close();
  }
});
