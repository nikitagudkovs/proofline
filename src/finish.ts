import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ActionConfig, Stage } from './config.js';
import { loadApprovedContract } from './contract.js';
import { loadPlan } from './plan.js';
import { writeReport } from './report.js';
import { CHANGE_REVIEW_SCHEMA, changeReviewPrompt, findingsFixPrompt } from './prompts.js';
import { attemptBuild, cleanRun, ensureIntegration, integrationDir, integrationRepo, mergeOrFail, newTaskState, repoNames, type Ctx } from './runner.js';
import { repoRuns, runDir, saveState, sessionsDir } from './state.js';
import type { Finding, Review, RunState } from './types.js';
import { exec, git, gitTry, tail } from './util.js';
import { verifyRun } from './verify.js';

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
    const inBase =
      (await gitTry(repo.root, 'merge-base', '--is-ancestor', head, run?.baseBranch ?? 'HEAD')).code === 0 ||
      (!!run && (await gitTry(repo.root, 'merge-base', '--is-ancestor', head, `origin/${run.baseBranch}`)).code === 0);
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

/** The most a reviewer is handed inline. A larger change is cut here and read from the files instead. */
const DIFF_LIMIT = 150_000;

/**
 * One independent read of the whole change, on request: what the contract's lines could not see.
 * It never blocks anything by itself. A person reads the findings and decides.
 */
export async function reviewRun(ctx: Ctx, state: RunState): Promise<Review> {
  if (state.cleaned) throw new Error('This run was cleaned up, so there is nothing left to review here.');
  const { contract, hash } = loadApprovedContract(ctx.root);
  if (hash !== state.contractHash) throw new Error(`The contract changed since run ${state.id}. A review is of the current contract's run.`);
  await ensureIntegration(ctx, state);

  const parts: string[] = [];
  const heads: string[] = [];
  for (const [i, repo] of ctx.repos.entries()) {
    const dir = integrationRepo(state, repo);
    heads.push(await git(dir, 'rev-parse', 'HEAD'));
    // With the folder as a prefix, every path in the diff reads as it does from where the reviewer stands.
    const prefix = repo.name ? [`--src-prefix=a/${repo.name}/`, `--dst-prefix=b/${repo.name}/`] : [];
    const diff = await git(dir, 'diff', ...prefix, `${repoRuns(state)[i].baseSha}..HEAD`);
    if (diff) parts.push(diff);
  }
  let diff = parts.join('\n');
  if (diff.length > DIFF_LIMIT) {
    diff = `${diff.slice(0, DIFF_LIMIT)}\n[The change is larger than fits here and was cut at this point. Read the remaining changed files directly.]`;
  }

  ctx.log('reviewing the change as a whole');
  const res = await ctx.engine.run<{ verdict: string; summary: string; findings?: Finding[] }>({
    role: 'verifier',
    label: 'REVIEW',
    cwd: integrationDir(state),
    prompt: changeReviewPrompt(contract, diff, repoNames(ctx), ctx.cfg.reviewInstructions),
    schema: CHANGE_REVIEW_SCHEMA,
    write: false,
    model: ctx.cfg.models.reviewer || undefined,
    timeoutMin: ctx.cfg.timeouts.reviewerMin,
    signal: ctx.signal,
  });
  ctx.track(state, 'verifier', res);

  const order = { blocker: 0, should: 1, note: 2 };
  const findings = (res.output.findings ?? [])
    .filter((f) => f && f.what)
    .map((f) => ({ ...f, severity: f.severity in order ? f.severity : 'note' }) as Finding)
    .sort((a, b) => order[a.severity] - order[b.severity]);
  const review: Review = {
    at: new Date().toISOString(),
    head: state.repos ? ctx.repos.map((r, i) => `${r.name}@${heads[i].slice(0, 7)}`).join(' ') : heads[0],
    // The verdict follows from the findings, whatever the reviewer called it.
    verdict: findings.some((f) => f.severity === 'blocker') ? 'changes' : 'approve',
    summary: res.output.summary,
    findings,
  };
  state.review = review;
  saveState(ctx.root, state);
  writeReport(ctx.root, state, contract, loadPlan(ctx.root));
  const count = (s: Finding['severity']) => findings.filter((f) => f.severity === s).length;
  ctx.log(`review: ${review.verdict === 'approve' ? 'no blockers' : `${count('blocker')} blocker${count('blocker') === 1 ? '' : 's'}`}, ${count('should')} to fix soon, ${count('note')} notes`);
  return review;
}

/**
 * Hand the reviewer's findings to one builder, merge what it changes, and prove the whole
 * contract again. `all` includes the "fix soon" ones; notes are never sent.
 */
export async function fixReview(ctx: Ctx, state: RunState, all = true): Promise<string> {
  const review = state.review;
  if (!review) throw new Error('This run has not been reviewed yet.');
  if (review.sentBack) throw new Error(`These findings already went back (${review.sentBack}). Review again to see what is left.`);
  if (state.merged || repoRuns(state).some((r) => r.merged)) throw new Error('This run is already merged. Fix what is left in a new run.');
  const findings = review.findings.filter((f) => f.severity === 'blocker' || (all && f.severity === 'should'));
  if (findings.length === 0) throw new Error('The review found nothing to send back.');
  const { contract, hash } = loadApprovedContract(ctx.root);
  if (hash !== state.contractHash) throw new Error(`The contract changed since run ${state.id}. Start a new run for the new contract.`);
  const plan = loadPlan(ctx.root);
  await ensureIntegration(ctx, state);

  const name = `RFIX${Object.keys(state.tasks).filter((k) => k.startsWith('RFIX')).length + 1}`;
  const fix = (state.tasks[name] = newTaskState(name, `Fix ${findings.length} review finding${findings.length === 1 ? '' : 's'}`, []));
  ctx.log(`sending ${findings.length} review finding${findings.length === 1 ? '' : 's'} back (${name})`);
  try {
    await attemptBuild(ctx, state, fix, findingsFixPrompt(contract, findings, repoNames(ctx)), ctx.cfg.models.builder, ctx.repos);
  } catch (e) {
    // Stopped half-way: nothing was merged, so the findings can be sent again.
    fix.status = 'failed';
    fix.error = 'stopped before it finished';
    saveState(ctx.root, state);
    throw e;
  }
  if (fix.status !== 'built' || fix.commits.length === 0) {
    fix.status = 'failed';
    fix.error ??= 'the fix changed nothing';
    saveState(ctx.root, state);
    writeReport(ctx.root, state, contract, plan);
    throw new Error(`${name}: ${fix.error}`);
  }
  if (!(await mergeOrFail(ctx, state, fix))) throw new Error(`${name} could not be merged: ${fix.error ?? 'conflict'}`);
  review.sentBack = name;

  // The fix is new code, so the contract's own lines are proven again before anything else.
  const round = await verifyRun(ctx, state, contract);
  state.status = round.results.every((r) => r.verdict === 'pass') ? 'proven' : 'unproven';
  state.finishedAt = new Date().toISOString();
  saveState(ctx.root, state);
  writeReport(ctx.root, state, contract, plan);

  // An open pull request should show what is now on the branch.
  for (const run of repoRuns(state).filter((r) => r.prUrl)) {
    const repo = ctx.repos.find((r) => r.name === run.name);
    if (!repo) continue;
    const pushed = await gitTry(repo.root, 'push', 'origin', state.branch);
    ctx.log(pushed === null ? `${run.name ? `${run.name}: ` : ''}could not push the fix to ${run.prUrl}; push ${state.branch} by hand` : `${run.name ? `${run.name}: ` : ''}pull request updated`);
  }
  return name;
}
