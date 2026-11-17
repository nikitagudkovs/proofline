#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { draftContract, draftPlan } from './authoring.js';
import { CONFIG_TEMPLATE, configPath, loadConfig } from './config.js';
import { DIR, approveContract, contractPath, lintContract, loadApprovedContract, loadContract, renderContract } from './contract.js';
import { doctor } from './doctor.js';
import { ClaudeCodeEngine } from './engine.js';
import { loadPlan, planPath, renderPlan, validatePlan } from './plan.js';
import { writeReport } from './report.js';
import { cleanRun, createRun, excludeRunsDir, executeRun, makeCtx, type Ctx } from './runner.js';
import { latestRun, listRuns, loadState, runDir, saveState } from './state.js';
import type { RunState } from './types.js';
import { exec, git } from './util.js';
import { verifyRun } from './verify.js';

const HELP = `proofline: a contract-first orchestrator for coding agents

  proofline doctor              show which GitHub account and Claude login a run will use
  proofline init                add .proofline/ with default settings
  proofline contract "<goal>"   draft a contract: numbered criteria, each with a proof
  proofline approve             lock the contract as it stands (any later edit voids this)
  proofline plan                break the approved contract into tasks
  proofline run                 build in parallel worktrees, verify, send failures back
  proofline status              runs in this repository, or one run in detail
  proofline verify              run the proofs again on an existing run
  proofline report              print the path of the report
  proofline ship                push the branch and open a pull request with the report
  proofline clean               remove a run's worktrees (branch and records stay)
  proofline go "<goal>"         contract → approve → plan → run in one go

Options
  --run <id>        act on this run instead of the latest
  --resume          run: continue the latest unfinished run
  --concurrency N   run: builders at the same time
  --yes             go: approve the drafted contract without asking
  --draft           ship: open a draft pull request, allowed even when not proven
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: 'string' },
    resume: { type: 'boolean', default: false },
    concurrency: { type: 'string' },
    yes: { type: 'boolean', default: false },
    draft: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const tty = process.stdout.isTTY;
const paint = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint(2, s);
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const bold = (s: string) => paint(1, s);

function log(msg: string) {
  console.log(`${dim(new Date().toTimeString().slice(0, 8))} ${msg}`);
}

async function context(): Promise<Ctx> {
  const top = await exec('git', ['rev-parse', '--show-toplevel'], {});
  if (top.code !== 0) throw new Error('proofline works inside a git repository. Run it from one.');
  const root = top.stdout.trim();
  const cfg = loadConfig(root);
  if (flags.concurrency) cfg.concurrency = Math.max(1, Number(flags.concurrency) || cfg.concurrency);
  return makeCtx(root, cfg, new ClaudeCodeEngine(cfg), log);
}

const pickRun = (root: string): RunState => (flags.run ? loadState(root, flags.run) : latestRun(root));

function summary(state: RunState): string {
  const last = state.rounds[state.rounds.length - 1];
  const total = last?.results.length ?? 0;
  const passed = last?.results.filter((r) => r.verdict === 'pass').length ?? 0;
  const text = `${passed} of ${total} criteria`;
  return state.status === 'proven' ? green(`Proven: ${text}`) : red(`Not proven: ${text}`);
}

function finish(ctx: Ctx, state: RunState): number {
  const dir = path.relative(process.cwd(), runDir(ctx.root, state.id));
  console.log(`\n${bold(summary(state))}`);
  const last = state.rounds[state.rounds.length - 1];
  for (const r of last?.results.filter((x) => x.verdict === 'fail') ?? []) {
    console.log(`  ${red('✗')} ${r.criterion}  ${r.evidence.split('\n')[0]}`);
  }
  for (const t of Object.values(state.tasks)) {
    for (const c of t.concerns ?? []) console.log(`  ${paint(33, '!')} ${t.id} raised: ${c}`);
  }
  console.log(`\nReport:  ${path.join(dir, 'report.html')}`);
  console.log(`Branch:  ${state.branch}`);
  console.log(state.status === 'proven' ? 'Next:    proofline ship' : 'Next:    fix and "proofline run --resume", or "proofline ship --draft"');
  return state.status === 'proven' ? 0 : 2;
}

const commands: Record<string, (ctx: Ctx) => Promise<number>> = {
  async doctor(ctx) {
    const checks = await doctor(ctx.root, ctx.cfg);
    for (const c of checks) {
      const sign = c.ok ? green('✓') : c.shipOnly ? paint(33, '!') : red('✗');
      console.log(`${sign} ${c.label.padEnd(15)} ${c.detail}`);
    }
    return checks.every((c) => c.ok || c.shipOnly) ? 0 : 1;
  },

  async init(ctx) {
    mkdirSync(path.join(ctx.root, DIR), { recursive: true });
    if (!existsSync(configPath(ctx.root))) writeFileSync(configPath(ctx.root), CONFIG_TEMPLATE);
    await excludeRunsDir(ctx.root);
    console.log(`Ready. Settings are in ${DIR}/config.yaml.\nNext: proofline contract "<what you want built>"`);
    return 0;
  },

  async contract(ctx) {
    const goal = positionals.slice(1).join(' ').trim();
    if (!goal) throw new Error('Say what you want built: proofline contract "<goal>"');
    log('drafting the contract (the planner reads the repository first)');
    const contract = await draftContract(ctx, goal);
    console.log(`\n${renderContract(contract)}\n`);
    for (const w of lintContract(contract)) console.log(`${paint(33, 'note')} ${w}`);
    console.log(`Saved to ${path.relative(process.cwd(), contractPath(ctx.root))}. Edit it until it says what you mean, then: proofline approve`);
    return 0;
  },

  async approve(ctx) {
    const contract = loadContract(ctx.root);
    console.log(`${renderContract(contract)}\n`);
    for (const w of lintContract(contract)) console.log(`${paint(33, 'note')} ${w}`);
    const hash = approveContract(ctx.root);
    console.log(`Approved (${hash}). Editing the contract voids this approval.\nNext: proofline plan`);
    return 0;
  },

  async plan(ctx) {
    log('planning tasks for the approved contract');
    const plan = await draftPlan(ctx);
    console.log(`\n${renderPlan(plan)}\n`);
    console.log(`Saved to ${path.relative(process.cwd(), planPath(ctx.root))}.\nNext: proofline run`);
    return 0;
  },

  async run(ctx) {
    let state: RunState;
    if (flags.resume || flags.run) {
      state = pickRun(ctx.root);
      log(`resuming run ${state.id}`);
    } else {
      const dirty = await git(ctx.root, 'status', '--porcelain', '--untracked-files=no');
      if (dirty) log('note: uncommitted changes in your checkout are not part of the run; it starts from the last commit');
      state = await createRun(ctx);
      log(`run ${state.id} started on branch ${state.branch}`);
    }
    return finish(ctx, await executeRun(ctx, state));
  },

  async verify(ctx) {
    const state = pickRun(ctx.root);
    const { contract, hash } = loadApprovedContract(ctx.root);
    if (hash !== state.contractHash) throw new Error('The contract changed since this run. Start a new run.');
    const plan = loadPlan(ctx.root);
    const round = await verifyRun(ctx, state, contract);
    state.status = round.results.every((r) => r.verdict === 'pass') ? 'proven' : 'unproven';
    saveState(ctx.root, state);
    writeReport(ctx.root, state, contract, plan);
    return finish(ctx, state);
  },

  async status(ctx) {
    if (!flags.run) {
      const ids = listRuns(ctx.root);
      if (ids.length === 0) {
        console.log('No runs yet.');
        return 0;
      }
      for (const id of ids) {
        const s = loadState(ctx.root, id);
        console.log(`${id}  ${s.status.padEnd(9)}  ${s.branch}${s.prUrl ? `  ${s.prUrl}` : ''}`);
      }
      console.log('');
    }
    const state = pickRun(ctx.root);
    console.log(bold(`Run ${state.id}: ${state.status}`));
    for (const t of Object.values(state.tasks)) {
      console.log(`  ${t.id.padEnd(5)} ${t.status.padEnd(9)} ${t.title}${t.error ? dim(`  (${t.error})`) : ''}`);
    }
    const last = state.rounds[state.rounds.length - 1];
    for (const r of last?.results ?? []) {
      console.log(`  ${r.verdict === 'pass' ? green('✓') : red('✗')} ${r.criterion.padEnd(4)} ${r.evidence.split('\n')[0]}`);
    }
    return 0;
  },

  async report(ctx) {
    const state = pickRun(ctx.root);
    const { contract } = loadApprovedContract(ctx.root);
    const files = writeReport(ctx.root, state, contract, loadPlan(ctx.root));
    console.log(files.html);
    console.log(files.md);
    return 0;
  },

  async ship(ctx) {
    const state = pickRun(ctx.root);
    if (state.status !== 'proven' && !flags.draft) {
      throw new Error(`Run ${state.id} is not proven, so it does not ship. Use --draft to open a draft pull request anyway.`);
    }
    const { contract } = loadApprovedContract(ctx.root);
    const { md } = writeReport(ctx.root, state, contract, loadPlan(ctx.root));
    log(`pushing ${state.branch}`);
    await git(ctx.root, 'push', '-u', 'origin', state.branch);
    const title = contract.goal.split(/(?<=[.!?])\s/)[0].slice(0, 72);
    const args = ['pr', 'create', '--base', state.baseBranch, '--head', state.branch, '--title', title, '--body-file', md];
    if (flags.draft) args.push('--draft');
    const pr = await exec('gh', args, { cwd: ctx.root });
    if (pr.code !== 0) throw new Error(`gh pr create failed: ${pr.stderr.trim()}`);
    state.prUrl = pr.stdout.trim().split('\n').pop();
    saveState(ctx.root, state);
    console.log(state.prUrl);
    return 0;
  },

  async clean(ctx) {
    const state = pickRun(ctx.root);
    await cleanRun(ctx.root, state);
    console.log(`Removed the worktrees of run ${state.id}. Branch ${state.branch} and the report are kept.`);
    return 0;
  },

  async go(ctx) {
    const goal = positionals.slice(1).join(' ').trim();
    if (!goal) throw new Error('Say what you want built: proofline go "<goal>"');
    log('drafting the contract');
    const contract = await draftContract(ctx, goal);
    console.log(`\n${renderContract(contract)}\n`);
    for (const w of lintContract(contract)) console.log(`${paint(33, 'note')} ${w}`);
    if (!flags.yes) {
      if (!process.stdin.isTTY) throw new Error('The contract needs an approval. Review it and run "proofline approve", or pass --yes.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Approve this contract and build it? [y/N] ');
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log(`Not approved. Edit ${DIR}/contract.yaml, then: proofline approve`);
        return 0;
      }
    }
    const hash = approveContract(ctx.root);
    log(`contract approved (${hash}); planning`);
    const plan = await draftPlan(ctx);
    validatePlan(plan, contract, hash);
    console.log(`\n${renderPlan(plan)}\n`);
    const state = await createRun(ctx);
    log(`run ${state.id} started on branch ${state.branch}`);
    return finish(ctx, await executeRun(ctx, state));
  },
};

async function main(): Promise<number> {
  const name = positionals[0];
  if (flags.help || !name) {
    console.log(HELP);
    return 0;
  }
  const command = commands[name];
  if (!command) {
    console.error(`Unknown command "${name}".\n\n${HELP}`);
    return 1;
  }
  return command(await context());
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(red((e as Error).message));
    process.exit(1);
  },
);
