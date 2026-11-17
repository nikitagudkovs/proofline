import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { readPlannerUsage } from './authoring.js';
import { loadApprovedContract } from './contract.js';
import type { AgentResult, Engine, Role } from './engine.js';
import { loadPlan, validatePlan, waves } from './plan.js';
import { BUILD_SCHEMA, buildPrompt, fixPrompt, type BuildOutput } from './prompts.js';
import { writeReport } from './report.js';
import { recordSessions, type SessionListener } from './sessions.js';
import { newRunId, saveState, sessionsDir } from './state.js';
import type { Contract, Plan, RunState, Task, TaskState, Usage } from './types.js';
import { AbortError, createLock, git, gitTry, isAbort, mapLimit } from './util.js';
import { runBaseline, verifyRun } from './verify.js';

export interface Ctx {
  root: string;
  cfg: Config;
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

export const integrationDir = (state: RunState) => path.join(state.worktreeRoot, 'integration');
const taskDir = (state: RunState, name: string) => path.join(state.worktreeRoot, name);
const taskBranch = (state: RunState, name: string) => `proofline-task/${state.id}/${name}`;

/** One repository must not run two worktree commands at the same moment. */
const repoLock = createLock();

/** Keep run state, evidence and worktree bookkeeping out of `git status` without touching .gitignore. */
export async function excludeRunsDir(root: string): Promise<void> {
  const common = await git(root, 'rev-parse', '--git-common-dir');
  const file = path.join(path.resolve(root, common), 'info', 'exclude');
  const line = '.proofline/runs/';
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').includes(line)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/** Start a run: an integration branch off the current commit, in its own worktree. Your checkout is never touched. */
export async function createRun(ctx: Ctx): Promise<RunState> {
  const { contract, hash } = loadApprovedContract(ctx.root);
  const plan = loadPlan(ctx.root);
  validatePlan(plan, contract, hash);

  const baseBranch = await git(ctx.root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (baseBranch === 'HEAD') throw new Error('You are on a detached HEAD. Check out a branch first.');
  const baseSha = await git(ctx.root, 'rev-parse', 'HEAD');
  await excludeRunsDir(ctx.root);

  const id = newRunId();
  const repoKey = `${path.basename(ctx.root)}-${createHash('sha1').update(ctx.root).digest('hex').slice(0, 8)}`;
  const state: RunState = {
    id,
    status: 'building',
    contractHash: hash,
    baseBranch,
    baseSha,
    branch: `proofline/${id}`,
    worktreeRoot: path.join(ctx.cfg.worktreeDir, repoKey, id),
    startedAt: new Date().toISOString(),
    tasks: {},
    rounds: [],
    usage: { planner: readPlannerUsage(ctx.root), builder: emptyUsage(), verifier: emptyUsage() },
  };
  for (const t of plan.tasks) state.tasks[t.id] = newTaskState(t.id, t.title, t.covers);

  mkdirSync(state.worktreeRoot, { recursive: true });
  await git(ctx.root, 'worktree', 'add', '-b', state.branch, integrationDir(state), baseSha);
  saveState(ctx.root, state);
  return state;
}

function newTaskState(id: string, title: string, covers: string[]): TaskState {
  return { id, title, covers, status: 'pending', attempts: 0, commits: [] };
}

/** Build, verify, send failures back, verify again. Safe to call again on an interrupted run. */
export async function executeRun(ctx: Ctx, state: RunState): Promise<RunState> {
  try {
    return await execute(ctx, state);
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
  const plan = loadPlan(ctx.root);
  validatePlan(plan, contract, hash);
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
    await attemptBuild(ctx, state, fix, fixPrompt(contract, failures), ctx.cfg.models.builder);
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
  if (existsSync(path.join(integrationDir(state), '.git'))) return;
  await git(ctx.root, 'worktree', 'prune');
  mkdirSync(state.worktreeRoot, { recursive: true });
  await git(ctx.root, 'worktree', 'add', integrationDir(state), state.branch);
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

    const prompt = (t: Task) => buildPrompt(contract, t, notesFor(state, t));
    await mapLimit(runnable, ctx.cfg.concurrency, (t) => attemptBuild(ctx, state, state.tasks[t.id], prompt(t), t.model));

    // Merge one at a time, in plan order, so the history reads the same on every run.
    for (const t of runnable) {
      const ts = state.tasks[t.id];
      if (ts.status !== 'built') continue;
      if (await merge(ctx, state, ts)) continue;
      // Two tasks of one wave touched the same lines. Rebuild the later one on top of what is merged now.
      ctx.log(`${t.id} conflicts with work merged in the same wave: rebuilding it on the merged result`);
      await attemptBuild(ctx, state, ts, prompt(t), t.model);
      if (ts.status === 'built') await mergeOrFail(ctx, state, ts);
    }
  }
}

function notesFor(state: RunState, task: Task): string[] {
  return task.needs.map((n) => {
    const s = state.tasks[n];
    return `- ${s.id} (${s.title}): ${[s.summary, s.notes].filter(Boolean).join(' ')}`;
  });
}

/** Run one builder in a fresh worktree off the integration branch. Sets the task to built or failed. */
async function attemptBuild(ctx: Ctx, state: RunState, ts: TaskState, prompt: string, model?: string): Promise<void> {
  const wt = taskDir(state, ts.id);
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
        await dropWorktree(ctx.root, wt, branch);
        await git(ctx.root, 'worktree', 'add', '-b', branch, wt, state.branch);
      });
      const base = await git(wt, 'rev-parse', 'HEAD');
      const res = await ctx.engine.run<BuildOutput>({
        role: 'builder',
        label: ts.id,
        cwd: wt,
        prompt,
        schema: BUILD_SCHEMA,
        write: true,
        model,
        signal: ctx.signal,
      });
      ctx.track(state, 'builder', res);

      await git(wt, 'add', '-A');
      if ((await gitTry(wt, 'diff', '--cached', '--quiet')).code !== 0) {
        // The contract's proofs are the gate here; the repository's own hooks run again when a person merges.
        await git(wt, 'commit', '--no-verify', '-m', `${ts.id}: ${ts.title}`);
      }
      const log = await git(wt, 'rev-list', '--reverse', `${base}..HEAD`);
      ts.commits = log ? log.split('\n') : [];
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

/** Merge a built task into the integration branch. False means a conflict; the merge is rolled back. */
async function merge(ctx: Ctx, state: RunState, ts: TaskState): Promise<boolean> {
  const cwd = integrationDir(state);
  if (ts.commits.length > 0) {
    const r = await gitTry(cwd, 'merge', '--no-ff', '--no-verify', '-m', `Merge ${ts.id}: ${ts.title}`, taskBranch(state, ts.id));
    if (r.code !== 0) {
      await gitTry(cwd, 'merge', '--abort');
      return false;
    }
  }
  ts.status = 'merged';
  await repoLock(() => dropWorktree(ctx.root, taskDir(state, ts.id), taskBranch(state, ts.id)));
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

async function dropWorktree(root: string, dir: string, branch: string): Promise<void> {
  await gitTry(root, 'worktree', 'remove', '--force', dir);
  rmSync(dir, { recursive: true, force: true });
  await gitTry(root, 'worktree', 'prune');
  await gitTry(root, 'branch', '-D', branch);
}

/** Remove the run's worktrees. The integration branch and the run's records stay. */
export async function cleanRun(root: string, state: RunState): Promise<void> {
  await gitTry(root, 'worktree', 'remove', '--force', integrationDir(state));
  for (const name of Object.keys(state.tasks)) await dropWorktree(root, taskDir(state, name), taskBranch(state, name));
  rmSync(state.worktreeRoot, { recursive: true, force: true });
  try {
    rmdirSync(path.dirname(state.worktreeRoot)); // the repository's folder, once its last run is gone
  } catch {
    // other runs still live there
  }
  await gitTry(root, 'worktree', 'prune');
}
