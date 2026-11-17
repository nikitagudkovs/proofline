import { loadApprovedContract } from './contract.js';
import { loadPlan } from './plan.js';
import { writeReport } from './report.js';
import type { Ctx } from './runner.js';
import { saveState } from './state.js';
import type { RunState } from './types.js';
import { exec, git } from './util.js';

/** Push the run's branch and open a pull request whose description is the report. */
export async function shipRun(ctx: Ctx, state: RunState, draft: boolean): Promise<string> {
  if (state.status !== 'proven' && !draft) {
    throw new Error(`Run ${state.id} is not proven, so it does not ship. A draft pull request is still allowed.`);
  }
  const { contract } = loadApprovedContract(ctx.root);
  const { md } = writeReport(ctx.root, state, contract, loadPlan(ctx.root));
  ctx.log(`pushing ${state.branch}`);
  await git(ctx.root, 'push', '-u', 'origin', state.branch);
  const title = contract.goal.split(/(?<=[.!?])\s/)[0].slice(0, 72);
  const args = ['pr', 'create', '--base', state.baseBranch, '--head', state.branch, '--title', title, '--body-file', md];
  if (draft) args.push('--draft');
  const pr = await exec('gh', args, { cwd: ctx.root });
  if (pr.code !== 0) throw new Error(`gh pr create failed: ${pr.stderr.trim()}`);
  state.prUrl = pr.stdout.trim().split('\n').pop();
  saveState(ctx.root, state);
  return state.prUrl ?? '';
}
