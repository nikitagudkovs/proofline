import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createRun, executeRun } from '../src/runner.js';
import { loadState, runDir } from '../src/state.js';
import { git } from '../src/util.js';
import { ScriptedEngine, done, fixture, writes } from './helpers.js';

const CONTRACT = `
goal: Ship three files and document them
criteria:
  - { id: C1, text: a.txt exists, proof: { command: "test -f a.txt" } }
  - { id: C2, text: b.txt says hello, proof: { command: "grep -q hello b.txt" } }
  - { id: C3, text: c.txt lists both files, proof: { command: "grep -q a.txt c.txt && grep -q b.txt c.txt" } }
  - { id: C4, text: The README names the files, proof: { review: "Does README.md name a.txt and b.txt?" } }
`;

const PLAN = `tasks:
  - { id: T1, title: write a, brief: create a.txt, covers: [C1], needs: [] }
  - { id: T2, title: write b, brief: create b.txt, covers: [C2], needs: [] }
  - { id: T3, title: index and docs, brief: create c.txt and update the README, covers: [C3, C4], needs: [T1, T2] }
`;

test('a run builds in parallel, catches a false "done", sends it back and ends proven', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  const engine = new ScriptedEngine({
    T1: writes({ 'a.txt': 'a\n' }, 'a.txt is at the repository root'),
    // The builder says "done", but the file does not say hello. Only the proof notices.
    T2: writes({ 'b.txt': 'hi\n' }),
    T3: writes({ 'c.txt': 'a.txt\nb.txt\n', 'README.md': '# demo\n\nFiles: a.txt, b.txt\n' }),
    FIX1: writes({ 'b.txt': 'hello\n' }),
    C4: () => ({ verdict: 'pass', evidence: 'README.md:3 names a.txt and b.txt' }),
  });
  const ctx = fx.ctx(engine);

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'proven');
  assert.equal(state.rounds.length, 2);
  assert.deepEqual(
    state.rounds[0].results.map((r) => [r.criterion, r.verdict]),
    [['C1', 'pass'], ['C2', 'fail'], ['C3', 'pass'], ['C4', 'pass']],
  );
  assert.ok(state.rounds[1].results.every((r) => r.verdict === 'pass'));

  // Before any work, every command proof was shown to fail: each one can tell done from not done.
  assert.deepEqual(state.baseline, { C1: 'fail', C2: 'fail', C3: 'fail' });

  // T1 and T2 have no dependency between them, so they were built at the same time.
  assert.ok(engine.maxParallel >= 2);
  for (const id of ['T1', 'T2', 'T3', 'FIX1']) assert.equal(state.tasks[id].status, 'merged');
  assert.deepEqual(state.tasks.FIX1.covers, ['C2']);

  // The dependent task was told what the tasks before it left behind.
  const t3 = engine.requests.find((r) => r.label === 'T3')!;
  assert.match(t3.prompt, /a\.txt is at the repository root/);

  // A builder is shown the whole contract, so parallel tasks agree on the details, but only its own proofs.
  const t1 = engine.requests.find((r) => r.label === 'T1')!;
  assert.match(t1.prompt, /stay consistent with them:\n- C2: b\.txt says hello/);
  assert.doesNotMatch(t1.prompt, /grep -q hello/);

  // The fixer was given the verifier's evidence, and the verifier never had write access.
  const fix = engine.requests.find((r) => r.label === 'FIX1')!;
  assert.match(fix.prompt, /grep -q hello b\.txt/);
  const verifier = engine.requests.find((r) => r.role === 'verifier')!;
  assert.equal(verifier.write, false);
  assert.doesNotMatch(verifier.prompt, /wrote c\.txt/);

  // The work is on the integration branch; the checkout the person is working in was never touched.
  assert.equal(await git(fx.root, 'show', `${state.branch}:b.txt`), 'hello');
  assert.equal(await git(fx.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.ok(!existsSync(path.join(fx.root, 'a.txt')));
  assert.equal(await git(fx.root, 'status', '--porcelain', '--untracked-files=no'), '');

  // The report ties each criterion to the tasks and commits behind it.
  const report = readFileSync(path.join(runDir(fx.root, state.id), 'report.md'), 'utf8');
  assert.match(report, /Proven: 4 of 4 criteria/);
  assert.match(report, /\*\*C2\*\* b\.txt says hello .* T2, FIX1 /);
  assert.match(report, /Round 1 .* 3 of 4 proven, sent back: C2/);
  assert.match(report, /## Caught by verification and sent back\n\n\*\*C2\*\*, round 1:\n\n```\nexit 1 in/);
  assert.ok(existsSync(path.join(runDir(fx.root, state.id), 'report.html')));
  assert.ok(existsSync(path.join(runDir(fx.root, state.id), 'evidence', 'round-1', 'C2.log')));
});

test('a run that cannot be fixed ends unproven and says which line failed', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  fx.cfg.maxFixRounds = 1;
  const engine = new ScriptedEngine({
    T1: writes({ 'a.txt': 'a\n' }),
    T2: writes({ 'b.txt': 'hi\n' }),
    T3: writes({ 'c.txt': 'a.txt\nb.txt\n' }),
    // A builder cannot change the contract, but it can tell its owner that a line is wrong.
    FIX1: (req) => {
      writeFileSync(path.join(req.cwd, 'b.txt'), 'still wrong\n');
      return { status: 'done', summary: 'tried', concerns: ['C2 expects "hello" but the brief says "hi"'] };
    },
    C4: () => ({ verdict: 'fail', evidence: 'README.md does not name the files' }),
  });
  const ctx = fx.ctx(engine);

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'unproven');
  assert.equal(state.rounds.length, 2);
  const failed = state.rounds[1].results.filter((r) => r.verdict === 'fail').map((r) => r.criterion);
  assert.deepEqual(failed, ['C2', 'C4']);
  const report = readFileSync(path.join(runDir(fx.root, state.id), 'report.md'), 'utf8');
  assert.match(report, /Not proven: 2 of 4 criteria/);
  assert.match(report, /\*\*FIX1\*\*: C2 expects "hello" but the brief says "hi"/);
});

test('two tasks that collide are not lost: the later one is rebuilt on the merged result', async () => {
  const fx = await fixture(
    `
goal: Two notes in one file
criteria:
  - { id: C1, text: notes has alpha, proof: { command: "grep -q alpha notes.txt" } }
  - { id: C2, text: notes has beta, proof: { command: "grep -q beta notes.txt" } }
`,
    `tasks:
  - { id: T1, title: alpha, brief: add alpha to notes.txt, covers: [C1], needs: [] }
  - { id: T2, title: beta, brief: add beta to notes.txt, covers: [C2], needs: [] }
`,
  );
  const engine = new ScriptedEngine({
    T1: writes({ 'notes.txt': 'alpha\n' }),
    T2: (req) => {
      // Like a real builder, it works with whatever the worktree holds when it starts.
      const file = path.join(req.cwd, 'notes.txt');
      const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
      writeFileSync(file, `${before}beta\n`);
      return done();
    },
  });
  const ctx = fx.ctx(engine);

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'proven');
  assert.equal(state.tasks.T2.attempts, 2);
  assert.equal(await git(fx.root, 'show', `${state.branch}:notes.txt`), 'alpha\nbeta');
  assert.ok(fx.logs.some((l) => /T2 conflicts/.test(l)));
});

test('an interrupted run resumes without rebuilding what is already merged', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  const handlers = {
    T1: writes({ 'a.txt': 'a\n' }),
    T2: (): never => {
      throw new Error('usage limit reached');
    },
    T3: writes({ 'c.txt': 'a.txt\nb.txt\n' }),
    C4: () => ({ verdict: 'pass', evidence: 'README.md:1' }),
  };
  fx.cfg.maxFixRounds = 0;
  const first = new ScriptedEngine(handlers);
  let ctx = fx.ctx(first);

  let state = await executeRun(ctx, await createRun(ctx));
  assert.equal(state.status, 'unproven');
  assert.equal(state.tasks.T1.status, 'merged');
  assert.equal(state.tasks.T2.status, 'failed');
  assert.match(state.tasks.T2.error!, /usage limit reached/);
  assert.equal(state.tasks.T3.status, 'blocked');

  const second = new ScriptedEngine({ ...handlers, T2: writes({ 'b.txt': 'hello\n' }) });
  ctx = fx.ctx(second);
  state = await executeRun(ctx, loadState(fx.root, state.id));

  assert.equal(state.status, 'proven');
  assert.deepEqual(second.requests.filter((r) => r.role === 'builder').map((r) => r.label).sort(), ['T2', 'T3']);
});

test('a proof that already passes before the work is reported as a guard, not as new evidence', async () => {
  const fx = await fixture(
    `
goal: Add a changelog
criteria:
  - { id: C1, text: CHANGELOG.md exists, proof: { command: "test -f CHANGELOG.md" } }
  - { id: C2, text: The README is still there, proof: { command: "test -f README.md" } }
`,
    `tasks:
  - { id: T1, title: changelog, brief: add CHANGELOG.md, covers: [C1, C2], needs: [] }
`,
  );
  const ctx = fx.ctx(new ScriptedEngine({ T1: writes({ 'CHANGELOG.md': '# Changelog\n' }) }));

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'proven');
  assert.deepEqual(state.baseline, { C1: 'fail', C2: 'pass' });
  assert.ok(fx.logs.some((l) => /C2 already passes before any work/.test(l)));
  const report = readFileSync(path.join(runDir(fx.root, state.id), 'report.md'), 'utf8');
  assert.match(report, /\*\*C2\*\* .* already passed \(guard\)/);
});

test('a run refuses to continue when the contract changed underneath it', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  const ctx = fx.ctx(new ScriptedEngine({}));
  const state = await createRun(ctx);

  const file = path.join(fx.root, '.proofline', 'contract.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('grep -q hello b.txt', 'true'));

  await assert.rejects(executeRun(ctx, state), /changed after it was approved/);
});
