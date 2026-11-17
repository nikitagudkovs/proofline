import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Ctx } from './runner.js';
import { integrationDir } from './runner.js';
import { REVIEW_SCHEMA, reviewPrompt, type ReviewOutput } from './prompts.js';
import { runDir, saveState } from './state.js';
import type { Contract, Criterion, ProofResult, RunState, VerificationRound } from './types.js';
import { AbortError, exec, git, isAbort, mapLimit, tail } from './util.js';

/**
 * Check every criterion of the contract against the integration branch as it now stands.
 *
 * Command proofs are run by this process, not by an agent: an exit code cannot be argued with.
 * Review proofs go to a read-only agent that sees the criterion and the code, never the builder.
 */
export async function verifyRun(ctx: Ctx, state: RunState, contract: Contract): Promise<VerificationRound> {
  const cwd = integrationDir(state);
  const n = state.rounds.length + 1;
  const head = await git(cwd, 'rev-parse', 'HEAD');
  const evidenceDir = path.join(runDir(ctx.root, state.id), 'evidence', `round-${n}`);
  mkdirSync(evidenceDir, { recursive: true });
  state.status = 'verifying';
  state.progress = [];
  saveState(ctx.root, state);
  ctx.log(`verifying ${contract.criteria.length} criteria at ${head.slice(0, 7)} (round ${n})`);

  let setupFailure = '';
  if (ctx.cfg.setup) {
    const r = await runShell(ctx.cfg.setup, cwd, ctx.cfg.timeouts.commandSec);
    writeFileSync(path.join(evidenceDir, 'setup.log'), r.output);
    if (!r.ok) setupFailure = `setup command \`${ctx.cfg.setup}\` failed (${r.how}):\n${tail(r.output, 15)}`;
  }

  const results = new Map<string, ProofResult>();
  const record = (r: ProofResult) => {
    r.at = new Date().toISOString();
    results.set(r.criterion, r);
    state.progress?.push(r);
    saveState(ctx.root, state);
    ctx.log(`${r.verdict === 'pass' ? '✓' : '✗'} ${r.criterion} (${r.proofType})`);
  };

  // Command proofs run one at a time: they may share build output, ports or databases.
  for (const c of contract.criteria) {
    if (c.proof.type !== 'command') continue;
    if (ctx.signal?.aborted) throw new AbortError();
    if (setupFailure) {
      record({ criterion: c.id, proofType: 'command', verdict: 'fail', evidence: setupFailure, durationMs: 0 });
      continue;
    }
    const r = await runShell(c.proof.run, cwd, c.proof.timeoutSec ?? ctx.cfg.timeouts.commandSec);
    const logFile = path.join('evidence', `round-${n}`, `${c.id}.log`);
    writeFileSync(path.join(runDir(ctx.root, state.id), logFile), `$ ${c.proof.run}\n${r.output}\n[${r.how}]\n`);
    const shown = tail(r.output, r.ok ? 6 : 25);
    record({
      criterion: c.id,
      proofType: 'command',
      verdict: r.ok ? 'pass' : 'fail',
      evidence: `${r.how}${shown ? `\n${shown}` : ''}`,
      logFile,
      durationMs: r.ms,
    });
  }

  const reviews = contract.criteria.filter((c) => c.proof.type === 'review');
  if (reviews.length) {
    const diffStat = await git(cwd, 'diff', '--stat', `${state.baseSha}..HEAD`);
    await mapLimit(reviews, ctx.cfg.concurrency, async (c) => record(await review(ctx, state, c, cwd, diffStat)));
  }

  const round: VerificationRound = {
    n,
    head,
    at: new Date().toISOString(),
    results: contract.criteria.map((c) => results.get(c.id)!),
  };
  state.rounds.push(round);
  state.progress = undefined;
  saveState(ctx.root, state);
  return round;
}

/**
 * Run the command proofs on the base commit, before anything is built.
 * A proof worth having is red here and green after the work; one that is already green only guards.
 */
export async function runBaseline(ctx: Ctx, state: RunState, contract: Contract): Promise<void> {
  const cwd = integrationDir(state);
  const commands = contract.criteria.filter((c) => c.proof.type === 'command');
  const baseline: Record<string, 'pass' | 'fail'> = {};
  const setupOk = !ctx.cfg.setup || (await runShell(ctx.cfg.setup, cwd, ctx.cfg.timeouts.commandSec)).ok;
  for (const c of commands) {
    if (c.proof.type !== 'command') continue;
    const ok = setupOk && (await runShell(c.proof.run, cwd, c.proof.timeoutSec ?? ctx.cfg.timeouts.commandSec)).ok;
    baseline[c.id] = ok ? 'pass' : 'fail';
  }
  state.baseline = baseline;
  saveState(ctx.root, state);
  const guards = commands.filter((c) => baseline[c.id] === 'pass').map((c) => c.id);
  ctx.log(`baseline: ${commands.length - guards.length} of ${commands.length} command proofs fail before the work, as they should`);
  if (guards.length) {
    ctx.log(`note: ${guards.join(', ')} already ${guards.length === 1 ? 'passes' : 'pass'} before any work: a guard against regressions, not evidence of new work`);
  }
}

async function review(ctx: Ctx, state: RunState, c: Criterion, cwd: string, diffStat: string): Promise<ProofResult> {
  const check = c.proof.type === 'review' ? c.proof.check : '';
  const started = Date.now();
  try {
    const res = await ctx.engine.run<ReviewOutput>({
      role: 'verifier',
      label: c.id,
      cwd,
      prompt: reviewPrompt(c, check, diffStat),
      schema: REVIEW_SCHEMA,
      write: false,
      signal: ctx.signal,
    });
    ctx.track(state, 'verifier', res);
    return {
      criterion: c.id,
      proofType: 'review',
      verdict: res.output.verdict === 'pass' ? 'pass' : 'fail',
      evidence: res.output.evidence,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    if (isAbort(e)) throw e;
    // A verifier that could not answer has not proven anything.
    return {
      criterion: c.id,
      proofType: 'review',
      verdict: 'fail',
      evidence: `the verifier did not return a verdict: ${(e as Error).message}`,
      durationMs: Date.now() - started,
    };
  }
}

async function runShell(command: string, cwd: string, timeoutSec: number) {
  const started = Date.now();
  const r = await exec(command, [], {
    cwd,
    shell: true,
    timeoutMs: timeoutSec * 1000,
    env: { ...process.env, CI: '1' },
  });
  const ms = Date.now() - started;
  const how = r.timedOut ? `timed out after ${timeoutSec}s` : `exit ${r.code} in ${(ms / 1000).toFixed(1)}s`;
  return { ok: r.code === 0 && !r.timedOut, how, ms, output: (r.stdout + r.stderr).trimEnd() };
}
