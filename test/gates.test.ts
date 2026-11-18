import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, gateList, loadConfig } from '../src/config.js';
import { DIR } from '../src/contract.js';
import { createRun, executeRun } from '../src/runner.js';
import { runDir } from '../src/state.js';
import { ScriptedEngine, done, fixture, workspace, writes } from './helpers.js';

const CONTRACT = `
goal: Ship a notes file
criteria:
  - { id: C1, text: notes.txt exists, proof: { command: "test -f notes.txt" } }
`;

const PLAN = `tasks:
  - { id: T1, title: write the notes, brief: create notes.txt, covers: [C1], needs: [] }
`;

// Stands in for a typecheck or a linter: green on the untouched code, red once someone leaves a TODO behind.
const LINT = { name: 'lint', run: '! grep -n TODO notes.txt 2>/dev/null' };

test('a gate the contract never mentioned catches the delivery, and the failure is sent back', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  fx.cfg.gates = [LINT];
  const engine = new ScriptedEngine({
    // Every line of the contract holds, and the builder says "done". Only the gate sees the leftover.
    T1: writes({ 'notes.txt': 'first note\nTODO finish this\n' }),
    FIX1: writes({ 'notes.txt': 'first note\nsecond note\n' }),
  });
  const ctx = fx.ctx(engine);

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'proven');
  assert.deepEqual(state.gateBaseline, { lint: 'pass' });
  assert.equal(state.rounds.length, 2);
  assert.deepEqual(state.rounds[0].results.map((r) => r.verdict), ['pass']);
  assert.deepEqual(state.rounds[0].gates?.map((g) => [g.gate, g.verdict]), [['lint', 'fail']]);
  assert.deepEqual(state.rounds[1].gates?.map((g) => [g.gate, g.verdict]), [['lint', 'pass']]);
  assert.equal(state.gateProgress, undefined);

  // The builder knew the gate was coming; the fixer got the command and what it printed.
  const t1 = engine.requests.find((r) => r.label === 'T1')!;
  assert.match(t1.prompt, /- lint: `! grep -n TODO notes\.txt/);
  const fix = engine.requests.find((r) => r.label === 'FIX1')!;
  assert.match(fix.prompt, /does not pass a required command/);
  assert.match(fix.prompt, /2:TODO finish this/);
  assert.doesNotMatch(fix.prompt, /Failed criteria/);
  assert.equal(state.tasks.FIX1.title, 'Fix lint');

  const report = readFileSync(path.join(runDir(fx.root, state.id), 'report.md'), 'utf8');
  assert.match(report, /Proven: 1 of 1 criteria/);
  assert.match(report, /## Gates\n[\s\S]*\*\*lint\*\* ✅ `! grep -n TODO/);
  assert.match(report, /Round 1 .* 1 of 1 proven, sent back: lint/);
  assert.match(report, /\*\*lint\*\*, round 1:\n\n```\nexit 1 in/);
  assert.match(readFileSync(path.join(runDir(fx.root, state.id), 'evidence', 'round-1', 'gate-1.log'), 'utf8'), /2:TODO finish this/);
  assert.match(readFileSync(path.join(runDir(fx.root, state.id), 'report.html'), 'utf8'), /<h2>Gates<\/h2>/);
});

test('a run whose every criterion holds is still not proven while a gate fails', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  fx.cfg.gates = [LINT];
  fx.cfg.maxFixRounds = 1;
  const engine = new ScriptedEngine({
    T1: writes({ 'notes.txt': 'TODO\n' }),
    FIX1: writes({ 'notes.txt': 'TODO, later\n' }),
  });
  const ctx = fx.ctx(engine);

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'unproven');
  assert.ok(state.rounds[1].results.every((r) => r.verdict === 'pass'));
  const report = readFileSync(path.join(runDir(fx.root, state.id), 'report.md'), 'utf8');
  assert.match(report, /Not proven: 1 of 1 criteria, and lint fails/);
});

test('a gate that was already red before the work is skipped, never blamed on the delivery', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  // Red on the untouched code: whatever it says after the work, it can not be this delivery's doing.
  fx.cfg.gates = [{ name: 'old debt', run: 'test -f never-written.txt' }, LINT];
  const engine = new ScriptedEngine({ T1: writes({ 'notes.txt': 'done\n' }) });
  const ctx = fx.ctx(engine);

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'proven');
  assert.deepEqual(state.gateBaseline, { 'old debt': 'fail', lint: 'pass' });
  assert.deepEqual(state.rounds[0].gates?.map((g) => g.verdict), ['skipped', 'pass']);
  // Nobody was asked to fix what this delivery did not break.
  assert.ok(!engine.requests.some((r) => r.label.startsWith('FIX')));
  assert.ok(fx.logs.some((l) => /warning: old debt already fails before any work/.test(l)));
  const report = readFileSync(path.join(runDir(fx.root, state.id), 'report.md'), 'utf8');
  assert.match(report, /\*\*old debt\*\* ➖ `test -f never-written\.txt` \(skipped, not counted\)/);
});

test('in a workspace a repository has its own gates, run inside it', async () => {
  const ws = await workspace(
    `
goal: A route and a screen
criteria:
  - { id: C1, text: The backend lists a route, proof: { command: "test -f api/routes.txt" } }
  - { id: C2, text: The frontend has a screen, proof: { command: "test -f web/screen.txt" } }
`,
    `tasks:
  - { id: T1, repo: api, title: route, brief: add routes.txt, covers: [C1], needs: [] }
  - { id: T2, repo: web, title: screen, brief: add screen.txt, covers: [C2], needs: [] }
`,
    `repos:
  - path: api
  - path: web
    gates:
      - { name: typecheck, run: "! grep -n 'any' screen.txt 2>/dev/null" }
gates:
  - { name: both sides, run: "test -d api && test -d web" }
`,
  );
  assert.deepEqual(
    gateList(ws.cfg).map((g) => [g.name, g.repo]),
    [['web: typecheck', 'web'], ['both sides', undefined]],
  );
  const engine = new ScriptedEngine({
    T1: writes({ 'routes.txt': 'GET /hello\n' }),
    T2: writes({ 'screen.txt': 'const x: any\n' }),
    FIX1: (req) => {
      writeFileSync(path.join(req.cwd, 'web', 'screen.txt'), 'const x: string\n');
      return done('typed it');
    },
  });
  const ctx = ws.ctx(engine);

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'proven');
  assert.deepEqual(state.gateBaseline, { 'web: typecheck': 'pass', 'both sides': 'pass' });
  assert.deepEqual(state.rounds[0].gates?.map((g) => [g.gate, g.verdict]), [['web: typecheck', 'fail'], ['both sides', 'pass']]);
  assert.ok(state.rounds[1].gates?.every((g) => g.verdict === 'pass'));
  // A repository's gate goes by the repository's name, so the fixer knows which side it is about.
  assert.match(engine.requests.find((r) => r.label === 'FIX1')!.prompt, /- web: typecheck: `! grep -n 'any' screen\.txt/);
});

test('the settings file keeps only gates that have a name and a command, once each', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  writeFileSync(
    path.join(fx.root, DIR, 'config.yaml'),
    `gates:
  - { name: typecheck, run: npx tsc --noEmit, timeoutSec: 900 }
  - { name: typecheck, run: something else }
  - { name: no command }
  - just a string
`,
  );
  assert.deepEqual(loadConfig(fx.root).gates, [{ name: 'typecheck', run: 'npx tsc --noEmit', timeoutSec: 900 }]);
  assert.deepEqual(DEFAULTS.gates, []);
});
