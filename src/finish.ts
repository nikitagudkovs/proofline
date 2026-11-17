import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ActionConfig, Stage } from './config.js';
import { loadApprovedContract } from './contract.js';
import { loadPlan } from './plan.js';
import { writeReport } from './report.js';
import { cleanRun, type Ctx } from './runner.js';
import { repoRuns, runDir, saveState, sessionsDir } from './state.js';
import type { RunState } from './types.js';
import { exec, gitTry, tail } from './util.js';

/** How far a run has come, for deciding which finishing steps are on offer. */
export function reached(state: RunState, stage: Stage): boolean {
  const runs = repoRuns(state);
  const shipped = runs.some((r) => r.prUrl);
  if (stage === 'proven') return state.status === 'proven';
  if (stage === 'shipped') return shipped;
  return shipped && runs.every((r) => !r.prUrl || (state.repos ? r.merged : state.merged));
}

/**
 * Merge the run's pull requests into the branches they target.
 * Only a proven run merges: the point of the contract is that nothing else reaches a shared branch.
 */
export async function mergeRun(ctx: Ctx, state: RunState): Promise<string[]> {
  if (state.status !== 'proven') throw new Error(`Run ${state.id} is not proven, so it is not merged.`);
  const open = repoRuns(state).filter((r) => r.prUrl);
  if (open.length === 0) throw new Error('This run has no pull request yet. Open one first.');
  const merged: string[] = [];
  for (const run of open) {
    const repo = ctx.repos.find((r) => r.name === run.name);
    if (!repo) throw new Error(`${run.name} is no longer in this workspace's settings.`);
    const where = run.name ? `${run.name}: ` : '';
    const done = state.repos ? run.merged : state.merged;
    if (!done) {
      ctx.log(`${where}merging ${run.prUrl} into ${run.baseBranch}`);
      const r = await exec('gh', ['pr', 'merge', run.prUrl!, `--${ctx.cfg.mergeMethod}`], { cwd: repo.root });
      if (r.code !== 0) throw new Error(`${where}gh pr merge failed: ${(r.stderr || r.stdout).trim()}`);
      // Trust the pull request's own state, not the exit code: a merge can be queued or held back by a check.
      const view = await exec('gh', ['pr', 'view', run.prUrl!, '--json', 'state', '-q', '.state'], { cwd: repo.root });
      if (view.stdout.trim() !== 'MERGED') {
        throw new Error(`${where}the pull request is not merged yet (${view.stdout.trim() || 'state unknown'}). Check it on GitHub.`);
      }
      if (state.repos) run.merged = true;
      else state.merged = true;
      saveState(ctx.root, state);
      // The branch has done its job. GitHub may already have removed it.
      await gitTry(repo.root, 'push', 'origin', '--delete', state.branch);
    }
    merged.push(run.prUrl!);
  }
  ctx.log(`merged: ${merged.join(', ')}`);
  await runAuto(ctx, state, 'merged');
  return merged;
}

/** Run one finishing action from the settings and keep its result with the run. */
export async function runAction(ctx: Ctx, state: RunState, action: ActionConfig): Promise<boolean> {
  if (!reached(state, action.needs)) {
    throw new Error(`"${action.name}" is for a run that is ${action.needs}. This one is not there yet.`);
  }
  const runs = repoRuns(state);
  ctx.log(`${action.name}: running`);
  const started = Date.now();
  const r = await exec(action.run, [], {
    cwd: ctx.root,
    shell: true,
    signal: ctx.signal,
    env: {
      ...process.env,
      PROOFLINE_RUN: state.id,
      PROOFLINE_STATUS: state.status,
      PROOFLINE_BRANCH: state.branch,
      PROOFLINE_ROOT: ctx.root,
      PROOFLINE_REPORT: path.join(runDir(ctx.root, state.id), 'report.md'),
      PROOFLINE_STATE: path.join(runDir(ctx.root, state.id), 'state.json'),
      PROOFLINE_REPOS: ctx.repos.map((x) => x.root).join('\n'),
      PROOFLINE_BASES: runs.map((x) => x.baseBranch).join('\n'),
      PROOFLINE_PRS: runs.map((x) => x.prUrl ?? '').join('\n'),
    },
  });
  const output = tail((r.stdout + r.stderr).trimEnd(), 20);
  const ok = r.code === 0;
  state.actions = [...(state.actions ?? []), { name: action.name, at: new Date().toISOString(), ok, output }];
  saveState(ctx.root, state);
  ctx.log(`${action.name}: ${ok ? 'done' : `failed (exit ${r.code})`} in ${Math.round((Date.now() - started) / 1000)}s${output ? `\n${output}` : ''}`);
  return ok;
}

/** Run the actions that are set to follow a stage by themselves. A failing one is reported, not fatal. */
export async function runAuto(ctx: Ctx, state: RunState, stage: Stage): Promise<void> {
  for (const action of ctx.cfg.actions.filter((a) => a.auto === stage)) {
    try {
      await runAction(ctx, state, action);
    } catch (e) {
      ctx.log(`${action.name}: ${(e as Error).message}`);
    }
  }
}

/**
 * Clean up after a finished run: the working copies, the session records and evidence, and the
 * run's local branches. A branch whose commits are neither merged nor on the remote is the only
 * copy of that work, so it is kept and named. The report and the run's summary stay.
 */
export async function purgeRun(ctx: Ctx, state: RunState): Promise<string[]> {
  try {
    const { contract } = loadApprovedContract(ctx.root);
    if (!existsSync(path.join(runDir(ctx.root, state.id), 'report.md'))) writeReport(ctx.root, state, contract, loadPlan(ctx.root));
  } catch {
    // the contract has moved on; whatever report exists is the record
  }
  await cleanRun(ctx, state);

  const kept: string[] = [];
  for (const [i, repo] of ctx.repos.entries()) {
    const head = (await gitTry(repo.root, 'rev-parse', '--verify', '-q', state.branch)).stdout.trim();
    if (!head) continue;
    const run = repoRuns(state)[i];
    const untouched = head === run?.baseSha;
    const merged = state.repos ? run?.merged : state.merged;
    const onRemote = (await gitTry(repo.root, 'rev-parse', '--verify', '-q', `origin/${state.branch}`)).stdout.trim() === head;
    const inBase = (await gitTry(repo.root, 'merge-base', '--is-ancestor', head, run?.baseBranch ?? 'HEAD')).code === 0;
    if (untouched || merged || onRemote || inBase) await gitTry(repo.root, 'branch', '-D', state.branch);
    else kept.push(`${repo.name ? `${repo.name}: ` : ''}${state.branch}`);
  }

  rmSync(sessionsDir(ctx.root, state.id), { recursive: true, force: true });
  rmSync(path.join(runDir(ctx.root, state.id), 'evidence'), { recursive: true, force: true });
  rmSync(path.join(runDir(ctx.root, state.id), 'log.jsonl'), { force: true });
  state.cleaned = true;
  saveState(ctx.root, state);
  ctx.log(
    kept.length
      ? `cleaned up; kept ${kept.join(', ')}: that work is not merged and not on the remote`
      : 'cleaned up: working copies, session records and local branches removed',
  );
  return kept;
}
