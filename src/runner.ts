import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { repoList, type Config, type Repo } from './config.js';
import { readPlannerUsage } from './authoring.js';
import { loadApprovedContract } from './contract.js';
import { runAuto } from './finish.js';
import type { AgentResult, Engine, Role } from './engine.js';
import { loadPlan, validatePlan, waves } from './plan.js';
import { BUILD_SCHEMA, buildPrompt, fixPrompt, type BuildOutput } from './prompts.js';
import { writeReport } from './report.js';
import { recordSessions, type SessionListener } from './sessions.js';
import { newRunId, repoRuns, saveState, sessionsDir } from './state.js';
import type { Contract, Plan, RepoRun, RunState, Task, TaskState, Usage } from './types.js';
import { AbortError, createLock, git, gitTry, isAbort, mapLimit, tail } from './util.js';
import { runBaseline, runSetup, verifyRun } from './verify.js';

export interface Ctx {
  /** The repository, or the workspace folder that holds several. Contract, plan and run records live here. */
  root: string;
  cfg: Config;
  /** The repositories a run works on. One, with an empty name, unless the settings list a workspace. */
  repos: Repo[];
  engine: Engine;
  log: (msg: string) => void;
  track: (state: RunState, role: Role, res: AgentResult<unknown>) => void;
  /** Aborting stops the run: agents are killed and the run is left resumable. */
  signal?: AbortSignal;
}

/** The same context, with every agent run of this run recorded under its folder. */
export function withSessions(ctx: Ctx, runId: string, listener?: SessionListener): Ctx {
  return { ...ctx, engine: recordSessions(ctx.engine, sessionsDir(ctx.root, runId), listener) };
}

export function makeCtx(root: string, cfg: Config, engine: Engine, log: (msg: string) => void = () => {}): Ctx {
  return {
    root,
    cfg,
    repos: repoList(root, cfg),
    engine,
    log,
    track(state, role, res) {
      const u = state.usage[role];
      u.calls += 1;
      u.turns += res.turns;
      u.costUsd += res.costUsd;
      u.durationMs += res.durationMs;
    },
  };
}

const emptyUsage = (): Usage => ({ calls: 0, turns: 0, costUsd: 0, durationMs: 0 });

/** Folder names of the workspace's repositories; empty when the run is on a single repository. */
export const repoNames = (ctx: Ctx): string[] => ctx.repos.map((r) => r.name).filter(Boolean);
const label = (repo: Repo) => repo.name || 'the repository';

const sub = (dir: string, name: string) => (name ? path.join(dir, name) : dir);
/**
 * Where everything merged so far lives, and where proofs run. For one repository it is that
 * repository's worktree; for a workspace it is a folder with one worktree per repository, side by side.
 */
export const integrationDir = (state: RunState) => path.join(state.worktreeRoot, 'integration');
export const integrationRepo = (state: RunState, repo: Repo) => sub(integrationDir(state), repo.name);
/** Workspace only: a copy of each repository's merged work for builders of the other repositories to read. */
const referenceDir = (state: RunState, repo: Repo) => path.join(state.worktreeRoot, 'reference', repo.name);
const taskDir = (state: RunState, name: string) => path.join(state.worktreeRoot, name);
const taskRepo = (state: RunState, name: string, repo: Repo) => sub(taskDir(state, name), repo.name);
const taskBranch = (state: RunState, name: string) => `proofline-task/${state.id}/${name}`;

/** One repository must not run two worktree commands at the same moment. */
const repoLock = createLock();

/**
 * Keep run state, evidence and worktree bookkeeping out of `git status` without touching .gitignore.
 * In a workspace the folder itself may be a repository too (notes, scripts); the delivery is not
 * part of it, so the whole .proofline folder stays out of it.
 */
export async function excludeRunsDir(root: string, workspace = false): Promise<void> {
  const found = await gitTry(root, 'rev-parse', '--git-common-dir');
  if (found.code !== 0) return; // a workspace folder need not be a repository itself
  const file = path.join(path.resolve(root, found.stdout.trim()), 'info', 'exclude');
  const line = workspace ? '.proofline/' : '.proofline/runs/';
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').includes(line)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/** Where a repository stands now: the branch a run would start from and its pull request would target. */
async function startingPoint(repo: Repo, workspace: boolean): Promise<RepoRun> {
  const top = await gitTry(repo.root, 'rev-parse', '--show-toplevel');
  if (top.code !== 0) throw new Error(`${repo.root} is not a git repository.`);
  // A plain subfolder of some other repository cannot have branches and worktrees of its own.
  if (workspace && realpathSync(top.stdout.trim()) !== realpathSync(repo.root)) {
    throw new Error(`${repo.name} is a folder inside another repository, not a repository of its own.`);
  }
  const baseBranch = await git(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (baseBranch === 'HEAD') throw new Error(`${workspace ? `${repo.name} is` : 'You are'} on a detached HEAD. Check out a branch first.`);
  return { name: repo.name, baseBranch, baseSha: await git(repo.root, 'rev-parse', 'HEAD') };
}

/** Start a run: an integration branch off the current commit of each repository, in its own worktree. Your checkout is never touched. */
export async function createRun(ctx: Ctx): Promise<RunState> {
  const { contract, hash } = loadApprovedContract(ctx.root);
  const plan = loadPlan(ctx.root);
  validatePlan(plan, contract, hash, repoNames(ctx));

  const workspace = repoNames(ctx).length > 0;
  const starts: RepoRun[] = [];
  for (const repo of ctx.repos) starts.push(await startingPoint(repo, workspace));
  await excludeRunsDir(ctx.root, workspace);

  const id = newRunId();
  const repoKey = `${path.basename(ctx.root)}-${createHash('sha1').update(ctx.root).digest('hex').slice(0, 8)}`;
  const state: RunState = {
    id,
    status: 'building',
    contractHash: hash,
    baseBranch: workspace ? '' : starts[0].baseBranch,
    baseSha: workspace ? '' : starts[0].baseSha,
    branch: `proofline/${id}`,
    ...(workspace ? { repos: starts } : {}),
    worktreeRoot: path.join(ctx.cfg.worktreeDir, repoKey, id),
    startedAt: new Date().toISOString(),
    tasks: {},
    rounds: [],
    usage: { planner: readPlannerUsage(ctx.root), builder: emptyUsage(), verifier: emptyUsage() },
  };
  for (const t of plan.tasks) state.tasks[t.id] = newTaskState(t.id, t.title, t.covers, workspace ? t.repo : undefined);

  for (const [i, repo] of ctx.repos.entries()) {
    mkdirSync(path.dirname(integrationRepo(state, repo)), { recursive: true });
    await git(repo.root, 'worktree', 'add', '-b', state.branch, integrationRepo(state, repo), starts[i].baseSha);
  }
  saveState(ctx.root, state);
  return state;
}

function newTaskState(id: string, title: string, covers: string[], repo?: string): TaskState {
  return { id, title, covers, status: 'pending', attempts: 0, commits: [], ...(repo ? { repo } : {}) };
}

/** Build, verify, send failures back, verify again. Safe to call again on an interrupted run. */
export async function executeRun(ctx: Ctx, state: RunState): Promise<RunState> {
  try {
    await execute(ctx, state);
    if (state.status === 'proven') await runAuto(ctx, state, 'proven');
    return state;
  } catch (e) {
    if (!isAbort(e)) throw e;
    for (const t of Object.values(state.tasks)) if (t.status === 'building') t.status = 'pending';
    state.progress = undefined;
    state.status = 'stopped';
    saveState(ctx.root, state);
    ctx.log(`run ${state.id} stopped; "run --resume" continues it`);
    return state;
  }
}

async function execute(ctx: Ctx, state: RunState): Promise<RunState> {
  const { contract, hash } = loadApprovedContract(ctx.root);
  if (hash !== state.contractHash) {
    throw new Error(`The contract changed since run ${state.id} started. Start a new run for the new contract.`);
  }
  if (repoRuns(state).map((r) => r.name).join() !== ctx.repos.map((r) => r.name).join()) {
    throw new Error(`The list of repositories changed since run ${state.id} started. Start a new run.`);
  }
  const plan = loadPlan(ctx.root);
  validatePlan(plan, contract, hash, repoNames(ctx));
  await ensureIntegration(ctx, state);

  if (!state.baseline) await runBaseline(ctx, state, contract);
  state.status = 'building';
  state.finishedAt = undefined;
  await buildAll(ctx, state, contract, plan);

  let round = await verifyRun(ctx, state, contract);
  let fixRound = Object.keys(state.tasks).filter((k) => k.startsWith('FIX')).length;
  for (;;) {
    const failures = round.results.filter((r) => r.verdict === 'fail');
    if (failures.length === 0 || fixRound >= ctx.cfg.maxFixRounds) break;
    writeReport(ctx.root, state, contract, plan);
    fixRound += 1;
    ctx.log(`${failures.length} ${failures.length === 1 ? 'criterion' : 'criteria'} not proven: sending ${failures.map((f) => f.criterion).join(', ')} back (fix round ${fixRound})`);

    const name = `FIX${fixRound}`;
    const fix = (state.tasks[name] = newTaskState(name, `Fix ${failures.map((f) => f.criterion).join(', ')}`, failures.map((f) => f.criterion)));
    // A failed line may sit on either side of a seam, so the fixer gets every repository, all of them writable.
    await attemptBuild(ctx, state, fix, fixPrompt(contract, failures, repoNames(ctx)), ctx.cfg.models.builder, ctx.repos);
    if (fix.status !== 'built' || fix.commits.length === 0) {
      fix.status = 'failed';
      fix.error ??= 'the fix changed nothing';
      break;
    }
    if (!(await mergeOrFail(ctx, state, fix))) break;
    round = await verifyRun(ctx, state, contract);
  }

  state.status = round.results.every((r) => r.verdict === 'pass') ? 'proven' : 'unproven';
  state.finishedAt = new Date().toISOString();
  saveState(ctx.root, state);
  writeReport(ctx.root, state, contract, plan);
  return state;
}

async function ensureIntegration(ctx: Ctx, state: RunState): Promise<void> {
  for (const repo of ctx.repos) {
    const dir = integrationRepo(state, repo);
    if (existsSync(path.join(dir, '.git'))) continue;
    await git(repo.root, 'worktree', 'prune');
    mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo.root, 'worktree', 'add', dir, state.branch);
  }
}

/**
 * Workspace only: bring the read-only copies up to what is merged now.
 * Builders read the other repositories there, never in the integration worktrees, so a stray
 * edit can not reach the proofs: it is wiped the next time this runs.
 */
async function syncReferences(ctx: Ctx, state: RunState): Promise<void> {
  if (!state.repos) return;
  await repoLock(async () => {
    for (const repo of ctx.repos) {
      const ref = referenceDir(state, repo);
      const head = await git(integrationRepo(state, repo), 'rev-parse', 'HEAD');
      if (existsSync(path.join(ref, '.git'))) {
        await git(ref, 'checkout', '-q', '--detach', '-f', head);
        await git(ref, 'clean', '-fdq');
      } else {
        rmSync(ref, { recursive: true, force: true });
        await gitTry(repo.root, 'worktree', 'prune');
        mkdirSync(path.dirname(ref), { recursive: true });
        await git(repo.root, 'worktree', 'add', '--detach', ref, head);
      }
    }
  });
}

async function buildAll(ctx: Ctx, state: RunState, contract: Contract, plan: Plan): Promise<void> {
  for (const wave of waves(plan)) {
    const runnable: Task[] = [];
    for (const t of wave) {
      const ts = state.tasks[t.id];
      if (ts.status === 'merged') continue;
      const missing = t.needs.find((n) => state.tasks[n].status !== 'merged');
      if (missing) {
        ts.status = 'blocked';
        ts.error = `needs ${missing}, which was not merged`;
        ctx.log(`${t.id} blocked: ${ts.error}`);
      } else {
        runnable.push(t);
      }
    }
    saveState(ctx.root, state);
    if (runnable.length === 0) continue;
    await syncReferences(ctx, state);

    const own = (t: Task) => ctx.repos.filter((r) => r.name === (state.repos ? t.repo : ''));
    const neighbours = (t: Task) => (state.repos ? ctx.repos.filter((r) => r.name !== t.repo).map((r) => ({ name: r.name, dir: referenceDir(state, r) })) : []);
    const prompt = (t: Task) => buildPrompt(contract, state.repos ? t : { ...t, repo: undefined }, notesFor(state, t), neighbours(t));
    await mapLimit(runnable, ctx.cfg.concurrency, (t) => attemptBuild(ctx, state, state.tasks[t.id], prompt(t), t.model, own(t)));

    // Merge one at a time, in plan order, so the history reads the same on every run.
    for (const t of runnable) {
      const ts = state.tasks[t.id];
      if (ts.status !== 'built') continue;
      if (await merge(ctx, state, ts)) continue;
      // Two tasks of one wave touched the same lines. Rebuild the later one on top of what is merged now.
      ctx.log(`${t.id} conflicts with work merged in the same wave: rebuilding it on the merged result`);
      await syncReferences(ctx, state);
      await attemptBuild(ctx, state, ts, prompt(t), t.model, own(t));
      if (ts.status === 'built') await mergeOrFail(ctx, state, ts);
    }
  }
}

function notesFor(state: RunState, task: Task): string[] {
  return task.needs.map((n) => {
    const s = state.tasks[n];
    return `- ${s.id} (${s.title}${s.repo ? `, in ${s.repo}` : ''}): ${[s.summary, s.notes].filter(Boolean).join(' ')}`;
  });
}

/** Run the repository's setup command in a fresh copy. Returns what it left behind that git would otherwise pick up. */
async function prepare(ctx: Ctx, repo: Repo, dir: string): Promise<string[]> {
  if (!repo.setup) return [];
  const r = await runSetup(ctx, repo.setup, dir, repo.root);
  if (!r.ok) throw new Error(`the setup command failed in ${label(repo)} (${r.how}): ${tail(r.output, 8)}`);
  // A symlinked node_modules or a copied key file must never end up in a commit.
  const left = await git(dir, 'ls-files', '--others', '--exclude-standard', '--directory', '-z');
  return left.split('\0').filter(Boolean).map((f) => f.replace(/\/$/, ''));
}

/**
 * Run one builder in fresh worktrees off the integration branch. Sets the task to built or failed.
 * `writable` is the repositories it may change: the task's own, or all of them for a fix.
 */
async function attemptBuild(ctx: Ctx, state: RunState, ts: TaskState, prompt: string, model: string | undefined, writable: Repo[]): Promise<void> {
  const dir = taskDir(state, ts.id);
  const branch = taskBranch(state, ts.id);
  for (let i = 0; i < 2; i++) {
    if (ctx.signal?.aborted) throw new AbortError();
    ts.attempts += 1;
    ts.status = 'building';
    ts.error = undefined;
    saveState(ctx.root, state);
    ctx.log(`${ts.id} building${ts.attempts > 1 ? ` (attempt ${ts.attempts})` : ''}: ${ts.title}`);
    try {
      await repoLock(async () => {
        await dropTask(ctx, state, ts.id);
        for (const repo of writable) {
          mkdirSync(path.dirname(taskRepo(state, ts.id, repo)), { recursive: true });
          await git(repo.root, 'worktree', 'add', '-b', branch, taskRepo(state, ts.id, repo), state.branch);
        }
      });
      const work: { repo: Repo; dir: string; base: string; leftovers: string[] }[] = [];
      for (const repo of writable) {
        const wt = taskRepo(state, ts.id, repo);
        work.push({ repo, dir: wt, base: await git(wt, 'rev-parse', 'HEAD'), leftovers: await prepare(ctx, repo, wt) });
      }

      // In a workspace the task folder mirrors the workspace: the task's own repository to work in,
      // the others linked in to read, so the contract's commands run from it as they are written.
      let cwd = work[0].dir;
      const addDirs: string[] = [];
      if (state.repos && writable.length === 1) {
        addDirs.push(dir);
        for (const other of ctx.repos.filter((r) => r !== writable[0])) {
          mkdirSync(path.dirname(taskRepo(state, ts.id, other)), { recursive: true });
          symlinkSync(referenceDir(state, other), taskRepo(state, ts.id, other), 'dir');
          addDirs.push(referenceDir(state, other));
        }
      } else if (state.repos) {
        cwd = dir;
      }

      const res = await ctx.engine.run<BuildOutput>({
        role: 'builder',
        label: ts.id,
        cwd,
        prompt,
        schema: BUILD_SCHEMA,
        write: true,
        model,
        ...(addDirs.length ? { addDirs } : {}),
        signal: ctx.signal,
      });
      ctx.track(state, 'builder', res);

      ts.commits = [];
      ts.byRepo = state.repos ? {} : undefined;
      for (const w of work) {
        await git(w.dir, 'add', '-A', '--', '.', ...w.leftovers.map((f) => `:(exclude,literal)${f}`));
        if ((await gitTry(w.dir, 'diff', '--cached', '--quiet')).code !== 0) {
          // The contract's proofs are the gate here; the repository's own hooks run again when a person merges.
          await git(w.dir, 'commit', '--no-verify', '-m', `${ts.id}: ${ts.title}`);
        }
        const log = await git(w.dir, 'rev-list', '--reverse', `${w.base}..HEAD`);
        const commits = log ? log.split('\n') : [];
        ts.commits.push(...commits);
        if (ts.byRepo && commits.length) ts.byRepo[w.repo.name] = commits;
      }
      ts.summary = res.output.summary;
      ts.notes = res.output.notes;
      ts.concerns = res.output.concerns?.filter(Boolean);
      for (const c of ts.concerns ?? []) ctx.log(`${ts.id} raised a concern about the contract: ${c}`);
      ts.sessionId = res.sessionId;
      if (res.output.status === 'blocked') {
        ts.status = 'failed';
        ts.error = `the builder reported it was blocked: ${res.output.summary}`;
      } else {
        ts.status = 'built';
      }
      saveState(ctx.root, state);
      ctx.log(`${ts.id} ${ts.status === 'built' ? `built (${ts.commits.length} commit${ts.commits.length === 1 ? '' : 's'})` : `failed: ${ts.error}`}`);
      return;
    } catch (e) {
      if (isAbort(e) || ctx.signal?.aborted) {
        ts.status = 'pending';
        saveState(ctx.root, state);
        throw new AbortError();
      }
      ts.status = 'failed';
      ts.error = (e as Error).message;
      saveState(ctx.root, state);
      ctx.log(`${ts.id} failed: ${ts.error}`);
    }
  }
}

/** Merge a built task into the integration branch of each repository it changed. False means a conflict; that merge is rolled back. */
async function merge(ctx: Ctx, state: RunState, ts: TaskState): Promise<boolean> {
  for (const repo of ctx.repos) {
    const commits = state.repos ? (ts.byRepo?.[repo.name] ?? []) : ts.commits;
    if (commits.length === 0) continue;
    const cwd = integrationRepo(state, repo);
    const r = await gitTry(cwd, 'merge', '--no-ff', '--no-verify', '-m', `Merge ${ts.id}: ${ts.title}`, taskBranch(state, ts.id));
    if (r.code !== 0) {
      await gitTry(cwd, 'merge', '--abort');
      return false;
    }
  }
  ts.status = 'merged';
  await repoLock(() => dropTask(ctx, state, ts.id));
  saveState(ctx.root, state);
  ctx.log(`${ts.id} merged`);
  return true;
}

async function mergeOrFail(ctx: Ctx, state: RunState, ts: TaskState): Promise<boolean> {
  if (await merge(ctx, state, ts)) return true;
  ts.status = 'failed';
  ts.error = 'could not be merged into the integration branch (conflict)';
  saveState(ctx.root, state);
  ctx.log(`${ts.id} failed: ${ts.error}`);
  return false;
}

async function dropWorktree(root: string, dir: string, branch?: string): Promise<void> {
  await gitTry(root, 'worktree', 'remove', '--force', dir);
  rmSync(dir, { recursive: true, force: true });
  await gitTry(root, 'worktree', 'prune');
  if (branch) await gitTry(root, 'branch', '-D', branch);
}

/** Remove a task's worktrees and branches in every repository, and its folder. */
async function dropTask(ctx: Ctx, state: RunState, name: string): Promise<void> {
  for (const repo of ctx.repos) {
    const dir = taskRepo(state, name, repo);
    // A link to the read-only copy of another repository: remove the link, never what it points to.
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(dir);
    else await dropWorktree(repo.root, dir, taskBranch(state, name));
  }
  rmSync(taskDir(state, name), { recursive: true, force: true });
}

/** Remove the run's worktrees. The integration branches and the run's records stay. */
export async function cleanRun(ctx: Ctx, state: RunState): Promise<void> {
  for (const name of Object.keys(state.tasks)) await dropTask(ctx, state, name);
  for (const repo of ctx.repos) {
    await dropWorktree(repo.root, integrationRepo(state, repo));
    if (state.repos) await dropWorktree(repo.root, referenceDir(state, repo));
  }
  rmSync(state.worktreeRoot, { recursive: true, force: true });
  try {
    rmdirSync(path.dirname(state.worktreeRoot)); // the repository's folder, once its last run is gone
  } catch {
    // other runs still live there
  }
}
