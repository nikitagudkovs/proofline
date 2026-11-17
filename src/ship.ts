import { loadApprovedContract } from './contract.js';
import { runAuto } from './finish.js';
import { loadPlan } from './plan.js';
import { writeReport } from './report.js';
import type { Ctx } from './runner.js';
import { repoRuns, saveState } from './state.js';
import type { RunState } from './types.js';
import { exec, git } from './util.js';

/**
 * Push the run's branch and open a pull request whose description is the report.
 * A workspace run opens one per repository it changed, each into the branch that repository
 * started from, and tells each pull request about the others.
 */
export async function shipRun(ctx: Ctx, state: RunState, draft: boolean): Promise<string> {
  if (state.status !== 'proven' && !draft) {
    throw new Error(`Run ${state.id} is not proven, so it does not ship. A draft pull request is still allowed.`);
  }
  const { contract } = loadApprovedContract(ctx.root);
  const plan = loadPlan(ctx.root);
  const { md } = writeReport(ctx.root, state, contract, plan);
  const title = contract.goal.split(/(?<=[.!?])\s/)[0].slice(0, 72);

  const opened: { root: string; url: string }[] = [];
  let fresh = false;
  for (const run of repoRuns(state)) {
    const repo = ctx.repos.find((r) => r.name === run.name);
    if (!repo) throw new Error(`${run.name} is no longer in this workspace's settings.`);
    const where = run.name ? `${run.name}: ` : '';
    if (run.prUrl) {
      opened.push({ root: repo.root, url: run.prUrl }); // opened by an earlier, interrupted ship
      continue;
    }
    if ((await git(repo.root, 'rev-parse', state.branch)) === run.baseSha) {
      ctx.log(`${where}nothing changed here, so no pull request`);
      continue;
    }
    ctx.log(`${where}pushing ${state.branch}`);
    await git(repo.root, 'push', '-u', 'origin', state.branch);
    const args = ['pr', 'create', '--base', run.baseBranch, '--head', state.branch, '--title', title, '--body-file', md];
    if (draft) args.push('--draft');
    const pr = await exec('gh', args, { cwd: repo.root });
    if (pr.code !== 0) throw new Error(`${where}gh pr create failed: ${pr.stderr.trim()}`);
    const url = pr.stdout.trim().split('\n').pop() ?? '';
    if (state.repos) run.prUrl = url;
    state.prUrl ??= url;
    saveState(ctx.root, state);
    opened.push({ root: repo.root, url });
    fresh = true;
  }
  if (opened.length === 0) throw new Error(`Run ${state.id} changed nothing, so there is nothing to ship.`);

  // Two halves of one delivery should not be merged without each other.
  if (opened.length > 1) {
    for (const pr of opened) {
      const others = opened.filter((o) => o !== pr).map((o) => `- ${o.url}`);
      const note = `This is one part of a delivery that spans ${opened.length} repositories. It was verified together with:\n${others.join('\n')}`;
      const r = await exec('gh', ['pr', 'comment', pr.url, '--body', note], { cwd: pr.root });
      if (r.code !== 0) ctx.log(`could not link ${pr.url} to the others: ${r.stderr.trim()}`);
    }
    writeReport(ctx.root, state, contract, plan);
  }
  if (fresh) await runAuto(ctx, state, 'shipped');
  return opened.map((o) => o.url).join('\n');
}
