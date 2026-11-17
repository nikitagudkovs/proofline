import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { hashContract, lintContract, loadContract } from '../src/contract.js';
import { loadPlan, planProblems } from '../src/plan.js';
import { loadConfig } from '../src/config.js';
import { doctor } from '../src/doctor.js';
import { cleanRun, createRun, executeRun, makeCtx } from '../src/runner.js';
import { startServer } from '../src/server.js';
import { shipRun } from '../src/ship.js';
import { runDir } from '../src/state.js';
import { git, gitTry } from '../src/util.js';
import { ScriptedEngine, done, fakeGitHub, fixture, workspace, writes } from './helpers.js';

const CONTRACT = `
goal: A hello endpoint and a screen that calls it
criteria:
  - { id: C1, text: The backend lists a hello route, proof: { command: "cd api && grep -q 'GET /hello' routes.txt" } }
  - { id: C2, text: The frontend calls the hello route, proof: { command: "cd web && grep -q 'fetch /hello' client.txt" } }
  - { id: C3, text: Both sides agree on the route, proof: { review: "Does web/client.txt call a route that api/routes.txt defines?" } }
`;

const PLAN = `tasks:
  - { id: T1, repo: api, title: hello route, brief: add the route to routes.txt, covers: [C1], needs: [] }
  - { id: T2, repo: web, title: hello screen, brief: call the route from client.txt, covers: [C2, C3], needs: [T1] }
`;

const read = (...parts: string[]) => readFileSync(path.join(...parts), 'utf8');

test('a workspace run builds each side in its own repository and verifies them together', async () => {
  const ws = await workspace(CONTRACT, PLAN);
  const seen: Record<string, unknown> = {};
  const engine = new ScriptedEngine({
    T1: writes({ 'routes.txt': 'GET /hello\n' }, 'the route is GET /hello, in routes.txt'),
    T2: (req) => {
      // The frontend builder works inside its own repository and can read the merged backend next to it.
      seen.t2Dir = path.basename(req.cwd);
      seen.t2ReadsBackend = read(req.cwd, '..', 'api', 'routes.txt');
      // It gets the route wrong, and scribbles in the backend, which is not its to change.
      writeFileSync(path.join(req.cwd, 'client.txt'), 'fetch /helo\n');
      appendFileSync(path.join(req.cwd, '..', 'api', 'routes.txt'), 'GET /helo\n');
      return done('screen added');
    },
    C3: (req, attempt) => {
      // The reviewer stands above both repositories, with everything merged.
      seen[`review${attempt}`] = [read(req.cwd, 'api', 'routes.txt'), read(req.cwd, 'web', 'client.txt')];
      return attempt === 1
        ? { verdict: 'fail', evidence: 'web/client.txt:1 calls /helo; api/routes.txt:1 defines /hello' }
        : { verdict: 'pass', evidence: 'web/client.txt:1 and api/routes.txt:1 both say /hello' };
    },
    FIX1: (req) => {
      // The fixer may change either side of the seam.
      seen.fixSees = [existsSync(path.join(req.cwd, 'api', 'routes.txt')), existsSync(path.join(req.cwd, 'web', 'client.txt'))];
      writeFileSync(path.join(req.cwd, 'web', 'client.txt'), 'fetch /hello\n');
      appendFileSync(path.join(req.cwd, 'api', 'routes.txt'), '# used by web/client.txt\n');
      return done('aligned the screen with the route');
    },
  });
  const ctx = ws.ctx(engine);

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'proven');
  assert.deepEqual(state.repos?.map((r) => [r.name, r.baseBranch]), [['api', 'develop'], ['web', 'main']]);
  assert.deepEqual(state.baseline, { C1: 'fail', C2: 'fail' });
  assert.deepEqual(state.rounds[0].results.map((r) => r.verdict), ['pass', 'fail', 'fail']);
  assert.match(state.rounds[1].head, /^api@[0-9a-f]{7} web@[0-9a-f]{7}$/);

  assert.equal(seen.t2Dir, 'web');
  assert.equal(seen.t2ReadsBackend, 'GET /hello\n');
  // What the frontend builder wrote into the backend never reached the proofs or the branch.
  assert.deepEqual(seen.review1, ['GET /hello\n', 'fetch /helo\n']);
  assert.deepEqual(seen.fixSees, [true, true]);
  assert.deepEqual(seen.review2, ['GET /hello\n# used by web/client.txt\n', 'fetch /hello\n']);

  const t2 = engine.requests.find((r) => r.label === 'T2')!;
  assert.match(t2.prompt, /You are in `web` and change only this one/);
  assert.match(t2.prompt, /the route is GET \/hello, in routes\.txt/);
  assert.ok(t2.addDirs?.some((d) => d.endsWith(path.join('reference', 'api'))));
  assert.equal(engine.requests.find((r) => r.label === 'T1')!.addDirs?.length, 2);
  assert.match(engine.requests.find((r) => r.label === 'FIX1')!.prompt, /You may change any of the repositories/);
  assert.match(engine.requests.find((r) => r.role === 'verifier')!.prompt, /spans 2 repositories/);

  // Each repository carries its own half on a branch of the same name; neither checkout was touched.
  assert.equal(state.tasks.T1.repo, 'api');
  assert.deepEqual(Object.keys(state.tasks.FIX1.byRepo ?? {}).sort(), ['api', 'web']);
  assert.equal(await git(path.join(ws.root, 'api'), 'show', `${state.branch}:routes.txt`), 'GET /hello\n# used by web/client.txt');
  assert.equal(await git(path.join(ws.root, 'web'), 'show', `${state.branch}:client.txt`), 'fetch /hello');
  assert.equal((await gitTry(path.join(ws.root, 'web'), 'show', `${state.branch}:routes.txt`)).code, 128);
  assert.equal(await git(path.join(ws.root, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
  assert.ok(!existsSync(path.join(ws.root, 'api', 'routes.txt')));

  const report = read(runDir(ws.root, state.id), 'report.md');
  assert.match(report, /Proven: 3 of 3 criteria/);
  assert.match(report, /in api off `develop@[0-9a-f]{7}`, web off `main@[0-9a-f]{7}`/);
  assert.match(report, /\*\*T2\*\* \[web\] hello screen \(after T1\)/);

  await cleanRun(ctx, state);
  assert.ok(!existsSync(state.worktreeRoot));
  assert.equal((await git(path.join(ws.root, 'api'), 'worktree', 'list')).split('\n').length, 1);
});

test('in a workspace every task must name one of its repositories', async () => {
  const ws = await workspace(CONTRACT, PLAN.replace('repo: web, ', '').replace('repo: api', 'repo: mobile'));
  const contract = loadContract(ws.root);
  const problems = planProblems(loadPlan(ws.root), contract, hashContract(contract), ['api', 'web']);
  assert.deepEqual(problems, ['T1: repo "mobile" is not in this workspace (one of: api, web)', 'T2: repo is missing (one of: api, web)']);
  await assert.rejects(createRun(ws.ctx(new ScriptedEngine({}))), /repo is missing/);

  // A command that never enters a repository would run in the folder above them.
  const loose = { ...contract, criteria: [{ ...contract.criteria[0], proof: { type: 'command' as const, run: 'grep -q hello routes.txt' } }] };
  assert.match(lintContract(loose, ['api', 'web'])[0], /C1's command names no repository folder/);
  assert.deepEqual(lintContract(contract, ['api', 'web']), []);
});

test('a workspace run opens one pull request per repository, each into the branch it started from', async () => {
  const ws = await workspace(CONTRACT, PLAN);
  const gh = await fakeGitHub(ws.root);
  try {
    const ctx = ws.ctx(
      new ScriptedEngine({
        T1: writes({ 'routes.txt': 'GET /hello\n' }),
        T2: writes({ 'client.txt': 'fetch /hello\n' }),
        C3: () => ({ verdict: 'pass', evidence: 'web/client.txt:1, api/routes.txt:1' }),
      }),
    );
    const state = await executeRun(ctx, await createRun(ctx));
    assert.equal(state.status, 'proven');

    const urls = await shipRun(ctx, state, false);

    assert.equal(urls, 'https://example.test/api/pull/1\nhttps://example.test/web/pull/1');
    assert.deepEqual(state.repos?.map((r) => r.prUrl), urls.split('\n'));
    const log = gh.calls();
    assert.match(log, new RegExp(`^api pr create --base develop --head ${state.branch} `, 'm'));
    assert.match(log, new RegExp(`^web pr create --base main --head ${state.branch} `, 'm'));
    // Each pull request is told about the other half.
    assert.match(log, /^api pr comment https:\/\/example\.test\/api\/pull\/1 --body .*spans 2 repositories/m);
    assert.match(log, /example\.test\/web\/pull\/1$/m);
    assert.equal(await git(gh.remote('api'), 'show', `${state.branch}:routes.txt`), 'GET /hello');
    assert.match(read(runDir(ws.root, state.id), 'report.md'), /Pull request for web: https:\/\/example\.test\/web\/pull\/1/);

    // Shipping again opens nothing new.
    assert.equal(await shipRun(ctx, state, false), urls);
    assert.equal(log.split('\n').filter((l) => / pr create /.test(l)).length, 2);
  } finally {
    gh.restore();
  }
});

test('the setup command prepares every copy, and what it leaves behind is never committed', async () => {
  const fx = await fixture(
    `
goal: Add a file that needs the dependencies
criteria:
  - { id: C1, text: a.txt exists and the dependencies are in place, proof: { command: "test -f a.txt && test -f deps/lib.txt" } }
`,
    `tasks:
  - { id: T1, title: write a, brief: create a.txt, covers: [C1], needs: [] }
`,
  );
  // Dependencies live in the person's checkout, outside git, as node_modules would.
  mkdirSync(path.join(fx.root, 'deps'));
  writeFileSync(path.join(fx.root, 'deps', 'lib.txt'), 'lib\n');
  fx.cfg.setup = 'ln -sfn "$PROOFLINE_SOURCE/deps" deps';
  let builderHadDeps = false;
  const ctx = fx.ctx(
    new ScriptedEngine({
      T1: (req) => {
        builderHadDeps = existsSync(path.join(req.cwd, 'deps', 'lib.txt'));
        writeFileSync(path.join(req.cwd, 'a.txt'), 'a\n');
        return done();
      },
    }),
  );

  const state = await executeRun(ctx, await createRun(ctx));

  assert.equal(state.status, 'proven');
  assert.ok(builderHadDeps);
  assert.equal(await git(fx.root, 'ls-tree', '-r', '--name-only', state.branch), 'README.md\na.txt');
});

test('the control room shows the workspace and keeps each task in its repository', async () => {
  const ws = await workspace(CONTRACT, PLAN, 'setup: ""\n');
  const engine = new ScriptedEngine({
    T1: writes({ 'routes.txt': 'GET /hello\n' }),
    T2: writes({ 'client.txt': 'fetch /hello\n' }),
    C3: () => ({ verdict: 'pass', evidence: 'web/client.txt:1, api/routes.txt:1' }),
  });
  const server = await startServer(ws.root, { port: 0, host: '127.0.0.1', engine: () => engine });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${url}`, {
      method,
      headers: { 'x-proofline-token': server.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as any;
  };
  try {
    const overview = await call('GET', '/api/overview');
    assert.deepEqual(overview.repo.repos, ['api', 'web']);
    assert.deepEqual(overview.plan.problems, []);
    assert.deepEqual(overview.plan.plan.tasks.map((t: any) => t.repo), ['api', 'web']);

    // A task saved without its repository is a plan problem, shown before anything runs.
    const tasks = overview.plan.plan.tasks.map((t: any) => (t.id === 'T2' ? { ...t, repo: undefined } : t));
    assert.match((await call('PUT', '/api/plan', { tasks })).plan.problems.join(), /T2: repo is missing/);
    await call('PUT', '/api/plan', { tasks: overview.plan.plan.tasks });

    const saved = await call('PUT', '/api/config', { repoSetup: { web: 'true' } });
    assert.deepEqual(saved.config.repos, [{ path: 'api', setup: '' }, { path: 'web', setup: 'true' }]);

    const { id } = await call('POST', '/api/runs', {});
    for (let i = 0; i < 200 && (await call('GET', '/api/overview')).job; i++) await new Promise((r) => setTimeout(r, 25));
    const run = await call('GET', `/api/runs/${id}`);
    assert.equal(run.state.status, 'proven');
    assert.match((await call('GET', `/api/runs/${id}/sessions/T2-1`)).changes, /^web\/\n[0-9a-f]+ T2: hello screen\n\n client\.txt/);
  } finally {
    await server.close();
  }
});

test('with a base set, a run starts from the remote branch, not from a checkout that is elsewhere or behind', async () => {
  const ws = await workspace(CONTRACT, PLAN);
  const gh = await fakeGitHub(ws.root);
  try {
    // The shared branch moves on the remote while the checkout sits on someone's side branch, one commit behind.
    const api = path.join(ws.root, 'api');
    await git(api, 'push', '-q', 'origin', 'develop');
    await git(api, 'checkout', '-q', '-b', 'side-work');
    writeFileSync(path.join(api, 'NEWS.md'), 'landed on the remote\n');
    await git(api, 'add', '-A');
    await git(api, 'commit', '-q', '-m', 'news');
    await git(api, 'push', '-q', 'origin', 'side-work:develop');
    await git(api, 'reset', '-q', '--hard', 'HEAD~1');

    const file = path.join(ws.root, '.proofline', 'config.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('repos: [api, web]', 'repos: [{ path: api, base: develop }, web]'));
    const cfg = loadConfig(ws.root);
    assert.match((await doctor(ws.root, cfg)).find((c) => c.label === 'starts from (api)')!.detail, /develop as it is on the remote.*Your checkout \(on side-work\) is not used/);

    const engine = new ScriptedEngine({
      // The builder sees what landed on the remote, although the checkout never had it.
      T1: (req) => {
        assert.ok(existsSync(path.join(req.cwd, 'NEWS.md')));
        return writes({ 'routes.txt': 'GET /hello\n' })(req, 1);
      },
      T2: writes({ 'client.txt': 'fetch /hello\n' }),
      C3: () => ({ verdict: 'pass', evidence: 'web/client.txt:1 calls the route in api/routes.txt:1' }),
    });
    const ctx = makeCtx(ws.root, cfg, engine);
    const state = await executeRun(ctx, await createRun(ctx));
    assert.equal(state.status, 'proven');

    const [apiRun, webRun] = state.repos!;
    assert.equal(apiRun.baseBranch, 'develop');
    assert.equal(apiRun.baseSha, await git(gh.remote('api'), 'rev-parse', 'develop'));
    assert.equal(webRun.baseBranch, 'main'); // no base set: the checkout's own branch, as before

    // The pull request goes into the shared branch, and the checkout was left exactly where it was.
    await shipRun(ctx, state, false);
    assert.match(gh.calls(), /^api pr create --base develop /m);
    assert.equal(await git(api, 'rev-parse', '--abbrev-ref', 'HEAD'), 'side-work');
    assert.ok(!existsSync(path.join(api, 'NEWS.md')));
  } finally {
    gh.restore();
  }
});
