import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { draftContract } from '../src/authoring.js';
import { DIR, contractPath, loadApprovedContract, loadContract } from '../src/contract.js';
import { loadPlan, planPath } from '../src/plan.js';
import {
  ensureProject,
  latestRun,
  listProjects,
  newProject,
  openProject,
  openProjectId,
  projectDir,
  projectFiles,
  projectForGoal,
  projectRuns,
  unfiledRuns,
  updateProject,
} from '../src/projects.js';
import { createRun, executeRun } from '../src/runner.js';
import { startServer } from '../src/server.js';
import { loadState, runDir } from '../src/state.js';
import { roundProven, verifyRun } from '../src/verify.js';
import { ScriptedEngine, fixture, hangs, writes } from './helpers.js';

const CONTRACT = `
goal: Ship a notes file
criteria:
  - { id: C1, text: notes.txt exists, proof: { command: "test -f notes.txt" } }
`;
const PLAN = `tasks:
  - { id: T1, title: write the notes, brief: create notes.txt, covers: [C1], needs: [] }
`;

const CHANGELOG = {
  goal: 'Add a changelog',
  criteria: [{ id: 'x', text: 'CHANGELOG.md exists', proof_type: 'command', proof: 'test -f CHANGELOG.md' }],
};

test('a new goal never overwrites finished work: it starts a project, and the old one opens again as it was', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  const engine = new ScriptedEngine({ T1: writes({ 'notes.txt': 'done\n' }), contract: () => CHANGELOG });
  const ctx = fx.ctx(engine);

  const state = await executeRun(ctx, await createRun(ctx));
  assert.equal(state.status, 'proven');

  // The folder was used before any project existed: that work became the first project, named after its goal.
  const first = ensureProject(fx.root);
  assert.equal(first.title, 'Ship a notes file');
  assert.equal(state.project, first.id);
  // The run keeps the contract and plan it was made for.
  assert.match(readFileSync(path.join(runDir(fx.root, state.id), 'contract.yaml'), 'utf8'), /notes\.txt exists/);
  assert.ok(existsSync(path.join(runDir(fx.root, state.id), 'plan.yaml')));

  // A second goal. The first project has a run, so it is put away, not replaced.
  const second = projectForGoal(fx.root, 'Add a changelog\n\nKeep it short.');
  assert.notEqual(second.id, first.id);
  assert.equal(second.title, 'Add a changelog');
  assert.equal(second.goal, 'Add a changelog\n\nKeep it short.');
  assert.ok(!existsSync(contractPath(fx.root)));
  await draftContract(ctx, second.goal);
  assert.equal(loadContract(fx.root).goal, 'Add a changelog');
  assert.deepEqual(listProjects(fx.root).map((p) => p.id), [second.id, first.id]);
  assert.throws(() => latestRun(fx.root), /This project has no runs yet/);

  // The put-away project can be read without opening it.
  const away = projectFiles(fx.root, first.id);
  assert.equal(away.contract?.goal, 'Ship a notes file');
  assert.equal(away.approved, true);
  assert.equal(away.plan?.tasks.length, 1);

  // Open the first one again: contract, approval and plan are back, and its run can be continued.
  openProject(fx.root, first.id);
  assert.equal(openProjectId(fx.root), first.id);
  const { contract, hash } = loadApprovedContract(fx.root);
  assert.equal(hash, state.contractHash);
  assert.equal(loadPlan(fx.root).tasks[0].id, 'T1');
  assert.equal(latestRun(fx.root).id, state.id);
  assert.ok(roundProven(await verifyRun(ctx, loadState(fx.root, state.id), contract)));
  // And the second one rests where the first one did, draft and all.
  assert.equal(projectFiles(fx.root, second.id).contract?.goal, 'Add a changelog');
  assert.equal(projectFiles(fx.root, second.id).approved, false);
});

test('while a project has no run, a new goal refines it; a name a person chose stays', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  const first = ensureProject(fx.root);

  const again = projectForGoal(fx.root, 'Ship a notes file with today\'s date');
  assert.equal(again.id, first.id);
  assert.equal(again.title, 'Ship a notes file with today\'s date');
  assert.equal(listProjects(fx.root).length, 1);

  updateProject(fx.root, first.id, { title: 'Notes' });
  assert.equal(projectForGoal(fx.root, 'Something else entirely').title, 'Notes');

  // Asking for a new project twice does not leave an empty one behind, and neither does walking away from one.
  const blank = newProject(fx.root);
  assert.equal(newProject(fx.root).id, blank.id);
  assert.equal(listProjects(fx.root).length, 2);
  openProject(fx.root, first.id);
  assert.deepEqual(listProjects(fx.root).map((p) => p.id), [first.id]);
  assert.equal(loadApprovedContract(fx.root).contract.goal, 'Ship a notes file');

  // A long first line is cut; the goal itself is kept whole.
  const long = newProject(fx.root, `${'word '.repeat(40)}\nsecond line`);
  assert.ok(long.title.length <= 80 && long.title.endsWith('…'));
  assert.match(long.goal, /second line$/);
});

test('runs from before projects existed go to the project whose contract they were made for', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  const ctx = fx.ctx(new ScriptedEngine({ T1: writes({ 'notes.txt': 'done\n' }) }));
  const state = await executeRun(ctx, await createRun(ctx));

  // Put the folder back to how an older version left it: no projects, runs that name none.
  rmSync(path.join(fx.root, DIR, 'projects'), { recursive: true });
  const file = path.join(runDir(fx.root, state.id), 'state.json');
  const old = JSON.parse(readFileSync(file, 'utf8'));
  delete old.project;
  writeFileSync(file, JSON.stringify(old));
  // And one more run, made for a contract that has since been replaced.
  mkdirSync(runDir(fx.root, '20200101-000000'), { recursive: true });
  writeFileSync(path.join(runDir(fx.root, '20200101-000000'), 'state.json'), JSON.stringify({ ...old, id: '20200101-000000', contractHash: 'replaced' }));

  const project = ensureProject(fx.root);
  assert.deepEqual(project.adopted, [state.id]);
  assert.deepEqual(projectRuns(fx.root, project), [state.id]);
  assert.deepEqual(unfiledRuns(fx.root), ['20200101-000000']);
  // The run's own file was not rewritten: another process may be in the middle of that run.
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).project, undefined);
});

test('opening a project that was interrupted half-way still ends with its files in place', async () => {
  const fx = await fixture(CONTRACT, PLAN);
  const first = ensureProject(fx.root);
  // As if the process died after putting the files away and before bringing the next ones back.
  for (const name of ['contract.yaml', 'approval.json', 'plan.yaml']) renameSync(path.join(fx.root, DIR, name), path.join(projectDir(fx.root, first.id), name));

  assert.equal(ensureProject(fx.root).id, first.id);
  assert.equal(loadApprovedContract(fx.root).contract.goal, 'Ship a notes file');
  assert.ok(existsSync(planPath(fx.root)));
});

async function boot(handlers: ConstructorParameters<typeof ScriptedEngine>[0]) {
  const fx = await fixture(CONTRACT, PLAN);
  const engine = new ScriptedEngine(handlers);
  const server = await startServer(fx.root, { port: 0, host: '127.0.0.1', engine: () => engine });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${url}`, {
      method,
      headers: { 'x-proofline-token': server.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const idle = async () => {
    for (let i = 0; i < 200; i++) {
      const { json } = await call('GET', '/api/overview');
      if (!json.job) return json;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the job never finished');
  };
  return { fx, server, call, idle };
}

test('the control room lists every project with its runs, and switches between them', async () => {
  const { fx, server, call, idle } = await boot({ T1: writes({ 'notes.txt': 'done\n' }), contract: () => CHANGELOG });
  try {
    const { json: started } = await call('POST', '/api/runs', {});
    let ov = await idle();
    const first = ov.project.id;
    assert.equal(ov.projects.length, 1);
    assert.deepEqual(ov.projects[0].runs.map((r: any) => [r.id, r.status]), [[started.id, 'proven']]);
    assert.equal(ov.projects[0].open, true);
    assert.equal(ov.projects[0].contract.goal, 'Ship a notes file');

    // Drafting a new goal now: the proven project is kept, and the Run screen starts empty for the new one.
    assert.equal((await call('POST', '/api/contract/draft', { goal: 'Add a changelog' })).status, 200);
    ov = await idle();
    assert.notEqual(ov.project.id, first);
    assert.equal(ov.project.goal, 'Add a changelog');
    assert.equal(ov.contract.contract.goal, 'Add a changelog');
    assert.deepEqual(ov.runs, []);
    assert.equal(ov.projects.length, 2);
    const kept = ov.projects.find((p: any) => p.id === first);
    assert.equal(kept.open, false);
    assert.equal(kept.approved, true);
    assert.equal(kept.runs.length, 1);

    // The old run is still readable, with the contract it was made for, though that contract is not the open one.
    const { json: run } = await call('GET', `/api/runs/${started.id}`);
    assert.equal(run.current, false);
    assert.equal(run.contract.criteria[0].text, 'notes.txt exists');

    // Open the first project again: its run is current and can be checked again.
    ov = (await call('POST', `/api/projects/${first}/open`, {})).json;
    assert.equal(ov.project.id, first);
    assert.equal(ov.contract.approved, true);
    assert.deepEqual(ov.runs.map((r: any) => r.id), [started.id]);
    assert.equal((await call('GET', `/api/runs/${started.id}`)).json.current, true);
    assert.equal((await call('POST', `/api/runs/${started.id}/verify`, {})).status, 200);
    await idle();
    assert.equal(loadState(fx.root, started.id).rounds.length, 2);

    // A name of one's own, and a project that does not exist.
    ov = (await call('PUT', `/api/projects/${first}`, { title: 'Notes file' })).json;
    assert.equal(ov.project.title, 'Notes file');
    assert.equal((await call('POST', '/api/projects/nope/open', {})).status, 404);

    // "New project" puts the open one away and leaves an empty contract screen.
    ov = (await call('POST', '/api/projects', { goal: 'Third thing' })).json;
    assert.equal(ov.projects.length, 3);
    assert.equal(ov.project.goal, 'Third thing');
    assert.equal(ov.contract.exists, false);
  } finally {
    await server.close();
  }
});

test('projects cannot be switched while a job is using the open one', async () => {
  const { server, call } = await boot({ T1: hangs });
  try {
    const first = (await call('GET', '/api/overview')).json.project.id;
    await call('POST', '/api/runs', {});
    assert.equal((await call('POST', '/api/projects', {})).status, 409);
    assert.equal((await call('POST', `/api/projects/${first}/open`, {})).status, 409);
    assert.equal((await call('POST', '/api/contract/draft', { goal: 'Another goal' })).status, 409);
    assert.equal((await call('GET', '/api/overview')).json.projects.length, 1);
  } finally {
    await server.close();
  }
});
