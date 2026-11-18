import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gateList, type Gate } from './config.js';
import type { Ctx } from './runner.js';
import { integrationDir, integrationRepo, repoNames } from './runner.js';
import { REVIEW_SCHEMA, reviewPrompt, type ReviewOutput } from './prompts.js';
import { repoRuns, runDir, saveState } from './state.js';
import type { Contract, Criterion, GateResult, ProofResult, RunState, VerificationRound } from './types.js';
import { AbortError, exec, git, isAbort, mapLimit, tail } from './util.js';

/**
 * Check every criterion of the contract against the integration branch as it now stands.
 *
 * Command proofs are run by this process, not by an agent: an exit code cannot be argued with.
 * Review proofs go to a read-only agent that sees the criterion and the code, never the builder.
 * The gates from the settings run in between: the same commit, the same rule.
 */
export async function verifyRun(ctx: Ctx, state: RunState, contract: Contract): Promise<VerificationRound> {
  const cwd = integrationDir(state);
  const n = state.rounds.length + 1;
  const heads: string[] = [];
  for (const repo of ctx.repos) heads.push(await git(integrationRepo(state, repo), 'rev-parse', 'HEAD'));
  const head = state.repos ? ctx.repos.map((r, i) => `${r.name}@${heads[i].slice(0, 7)}`).join(' ') : heads[0];
  const evidenceDir = path.join(runDir(ctx.root, state.id), 'evidence', `round-${n}`);
  mkdirSync(evidenceDir, { recursive: true });
  state.status = 'verifying';
  state.progress = [];
  const gates = gateList(ctx.cfg);
  state.gateProgress = gates.length ? [] : undefined;
  saveState(ctx.root, state);
  ctx.log(`verifying ${contract.criteria.length} criteria${gates.length ? ` and ${gates.length} ${gates.length === 1 ? 'gate' : 'gates'}` : ''} at ${shortHead(head)} (round ${n})`);

  const setup = await setUp(ctx, state);
  if (setup.output) writeFileSync(path.join(evidenceDir, 'setup.log'), setup.output);
  const setupFailure = setup.failure;

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

  // Gates before the review proofs: a command costs nothing, and its verdict is known before any agent starts.
  const gateResults: GateResult[] = [];
  for (const [i, g] of gates.entries()) {
    if (ctx.signal?.aborted) throw new AbortError();
    let r: GateResult;
    if (state.gateBaseline?.[g.name] === 'fail') {
      r = { gate: g.name, run: g.run, verdict: 'skipped', evidence: 'Already failed before the work, so it can not tell whether this change broke anything. Not counted.', durationMs: 0 };
    } else if (setupFailure) {
      r = { gate: g.name, run: g.run, verdict: 'fail', evidence: setupFailure, durationMs: 0 };
    } else {
      const ran = await runGate(ctx, state, g);
      const logFile = path.join('evidence', `round-${n}`, `gate-${i + 1}.log`);
      writeFileSync(path.join(runDir(ctx.root, state.id), logFile), `$ ${g.run}\n${ran.output}\n[${ran.how}]\n`);
      const shown = tail(ran.output, ran.ok ? 6 : 25);
      r = { gate: g.name, run: g.run, verdict: ran.ok ? 'pass' : 'fail', evidence: `${ran.how}${shown ? `\n${shown}` : ''}`, logFile, durationMs: ran.ms };
    }
    r.at = new Date().toISOString();
    gateResults.push(r);
    state.gateProgress?.push(r);
    saveState(ctx.root, state);
    ctx.log(`${r.verdict === 'pass' ? '✓' : r.verdict === 'fail' ? '✗' : '–'} ${g.name} (gate${r.verdict === 'skipped' ? ', skipped: it already failed before the work' : ''})`);
  }

  const reviews = contract.criteria.filter((c) => c.proof.type === 'review');
  if (reviews.length) {
    const stats: string[] = [];
    for (const [i, repo] of ctx.repos.entries()) {
      const stat = await git(integrationRepo(state, repo), 'diff', '--stat', `${repoRuns(state)[i].baseSha}..HEAD`);
      if (stat) stats.push(repo.name ? `${repo.name}/\n${stat}` : stat);
    }
    const diffStat = stats.join('\n');
    await mapLimit(reviews, ctx.cfg.concurrency, async (c) => record(await review(ctx, state, c, cwd, diffStat)));
  }

  const round: VerificationRound = {
    n,
    head,
    at: new Date().toISOString(),
    results: contract.criteria.map((c) => results.get(c.id)!),
    ...(gates.length ? { gates: gateResults } : {}),
  };
  state.rounds.push(round);
  state.progress = undefined;
  state.gateProgress = undefined;
  saveState(ctx.root, state);
  return round;
}

/** A round proves the delivery when every criterion holds and no gate fails. */
export const roundProven = (round: VerificationRound) => round.results.every((r) => r.verdict === 'pass') && failedGates(round).length === 0;
export const failedGates = (round?: VerificationRound) => (round?.gates ?? []).filter((g) => g.verdict === 'fail');

/** A repository's gate runs inside that repository; the others run where the proofs run. */
function runGate(ctx: Ctx, state: RunState, g: Gate) {
  const repo = ctx.repos.find((r) => r.name && r.name === g.repo);
  return runShell(g.run, repo ? integrationRepo(state, repo) : integrationDir(state), g.timeoutSec ?? ctx.cfg.timeouts.commandSec);
}

/**
 * Run the command proofs on the base commit, before anything is built.
 * A proof worth having is red here and green after the work; one that is already green only guards.
 * A gate is the other way round: it should be green here, and one that is not is skipped for the run.
 */
export async function runBaseline(ctx: Ctx, state: RunState, contract: Contract): Promise<void> {
  const cwd = integrationDir(state);
  const commands = contract.criteria.filter((c) => c.proof.type === 'command');
  const baseline: Record<string, 'pass' | 'fail'> = {};
  const setupOk = !(await setUp(ctx, state)).failure;
  for (const c of commands) {
    if (c.proof.type !== 'command') continue;
    const ok = setupOk && (await runShell(c.proof.run, cwd, c.proof.timeoutSec ?? ctx.cfg.timeouts.commandSec)).ok;
    baseline[c.id] = ok ? 'pass' : 'fail';
  }
  state.baseline = baseline;
  // With a broken setup nothing is known about the gates, so they stay in and count.
  const gates = setupOk ? gateList(ctx.cfg) : [];
  if (gates.length) {
    state.gateBaseline = {};
    for (const g of gates) {
      if (ctx.signal?.aborted) throw new AbortError();
      state.gateBaseline[g.name] = (await runGate(ctx, state, g)).ok ? 'pass' : 'fail';
    }
    const red = gates.filter((g) => state.gateBaseline![g.name] === 'fail').map((g) => g.name);
    if (red.length) ctx.log(`warning: ${red.join(', ')} already ${red.length === 1 ? 'fails' : 'fail'} before any work, so ${red.length === 1 ? 'it is' : 'they are'} skipped in this run: fix ${red.length === 1 ? 'it' : 'them'} on the base branch first`);
    else ctx.log(`baseline: ${gates.length === 1 ? 'the gate passes' : `all ${gates.length} gates pass`} before the work`);
  }
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
      prompt: reviewPrompt(c, check, diffStat, repoNames(ctx)),
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

/** A full commit id is shown short; a workspace head is already one short id per repository. */
export const shortHead = (head: string) => (/^[0-9a-f]{40}$/.test(head) ? head.slice(0, 7) : head);

/**
 * Run a setup command in one copy of a repository. PROOFLINE_SOURCE points at the person's own
 * checkout, so the command can link or copy what git does not track (dependencies, key files).
 */
export function runSetup(ctx: Ctx, command: string, cwd: string, source: string) {
  return runShell(command, cwd, ctx.cfg.timeouts.commandSec, { PROOFLINE_SOURCE: source });
}

/** Prepare the place the proofs run in: each repository's setup, then the workspace's own, if any. */
async function setUp(ctx: Ctx, state: RunState): Promise<{ output: string; failure: string }> {
  const steps = ctx.repos.filter((r) => r.setup).map((r) => ({ command: r.setup, cwd: integrationRepo(state, r), source: r.root }));
  if (state.repos && ctx.cfg.setup) steps.push({ command: ctx.cfg.setup, cwd: integrationDir(state), source: ctx.root });
  let output = '';
  for (const step of steps) {
    const r = await runSetup(ctx, step.command, step.cwd, step.source);
    output += `$ ${step.command}\n${r.output}\n[${r.how}]\n`;
    if (!r.ok) return { output, failure: `setup command \`${step.command}\` failed (${r.how}):\n${tail(r.output, 15)}` };
  }
  return { output, failure: '' };
}

async function runShell(command: string, cwd: string, timeoutSec: number, env: Record<string, string> = {}) {
  const started = Date.now();
  const r = await exec(command, [], {
    cwd,
    shell: true,
    timeoutMs: timeoutSec * 1000,
    env: { ...process.env, CI: '1', ...env },
  });
  const ms = Date.now() - started;
  const how = r.timedOut ? `timed out after ${timeoutSec}s` : `exit ${r.code} in ${(ms / 1000).toFixed(1)}s`;
  return { ok: r.code === 0 && !r.timedOut, how, ms, output: (r.stdout + r.stderr).trimEnd() };
}
