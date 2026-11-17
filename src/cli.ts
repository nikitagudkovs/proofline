#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { draftContract, draftPlan } from './authoring.js';
import { CONFIG_TEMPLATE, configPath, findWorkspace, loadConfig, workspaceTemplate } from './config.js';
import { DIR, approveContract, contractPath, lintContract, loadApprovedContract, loadContract, renderContract } from './contract.js';
import { doctor } from './doctor.js';
import { ClaudeCodeEngine } from './engine.js';
import { loadPlan, planPath, renderPlan, validatePlan } from './plan.js';
import { writeReport } from './report.js';
import { appendLog, startServer } from './server.js';
import { shipRun } from './ship.js';
import { cleanRun, createRun, excludeRunsDir, executeRun, makeCtx, repoNames, withSessions, type Ctx } from './runner.js';
import { AUTHORING, latestRun, listRuns, loadState, repoRuns, runDir, saveState } from './state.js';
import type { RunState } from './types.js';
import { exec, git } from './util.js';
import { verifyRun } from './verify.js';

const HELP = `proofline: a contract-first orchestrator for coding agents

  proofline ui                  open the control room in your browser: contract, tasks,
                                live agent sessions, models, reports
  proofline doctor              show which GitHub account and Claude login a run will use
  proofline init                add .proofline/ with default settings
  proofline init --repos a,b    make this folder a workspace: repositories a/ and b/ are
                                planned, built and verified as one delivery
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
  --repos a,b       init: the repositories of a workspace, as folders below this one
  --port N          ui: port to listen on (default 4717)
  --no-open         ui: do not open the browser
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: 'string' },
    resume: { type: 'boolean', default: false },
    concurrency: { type: 'string' },
    yes: { type: 'boolean', default: false },
    draft: { type: 'boolean', default: false },
    repos: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
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

/** The workspace this folder belongs to, if its settings list several repositories; otherwise the repository. */
async function findRoot(): Promise<string> {
  if (positionals[0] === 'init' && flags.repos) return process.cwd();
  const workspace = findWorkspace(process.cwd());
  if (workspace) return workspace;
  const top = await exec('git', ['rev-parse', '--show-toplevel'], {});
  if (top.code !== 0) {
    throw new Error('proofline works inside a git repository, or in a folder of several: proofline init --repos <folder>,<folder>');
  }
  return top.stdout.trim();
}

async function context(): Promise<Ctx> {
  const root = await findRoot();
  const cfg = loadConfig(root);
  if (flags.concurrency) cfg.concurrency = Math.max(1, Number(flags.concurrency) || cfg.concurrency);
  return makeCtx(root, cfg, new ClaudeCodeEngine(cfg), log);
}

/** A run started in a terminal keeps the same records as one started in the control room, so either can show it. */
function recorded(ctx: Ctx, runId: string): Ctx {
  const tee = (msg: string) => {
    ctx.log(msg);
    appendLog(ctx.root, runId, msg);
  };
  return withSessions({ ...ctx, log: tee }, runId);
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
      console.log(`${sign} ${c.label.padEnd(checks.reduce((n, x) => Math.max(n, x.label.length), 0))}  ${c.detail}`);
    }
    return checks.every((c) => c.ok || c.shipOnly) ? 0 : 1;
  },

  async init(ctx) {
    const repos = (flags.repos ?? '').split(',').map((r) => r.trim().replace(/\/+$/, '')).filter(Boolean);
    for (const repo of repos) {
      if (!existsSync(path.join(ctx.root, repo, '.git'))) throw new Error(`${repo} is not a git repository inside this folder.`);
    }
    mkdirSync(path.join(ctx.root, DIR), { recursive: true });
    if (!existsSync(configPath(ctx.root))) {
      writeFileSync(configPath(ctx.root), repos.length ? workspaceTemplate(repos) : CONFIG_TEMPLATE);
    } else if (repos.length && repoNames(ctx).join() !== repos.join()) {
      throw new Error(`${DIR}/config.yaml already exists. Add the repositories there:\n\nrepos:\n${repos.map((r) => `  - path: ${r}`).join('\n')}`);
    }
    await excludeRunsDir(ctx.root, repos.length > 0 || repoNames(ctx).length > 0);
    console.log(
      repos.length
        ? `Ready. This folder is a workspace of ${repos.join(' and ')}: one contract, one plan, a pull request per repository.`
        : 'Ready.',
    );
    console.log(`Settings are in ${DIR}/config.yaml.\nNext: proofline ui, or proofline contract "<what you want built>"`);
    return 0;
  },

  async contract(ctx) {
    const goal = positionals.slice(1).join(' ').trim();
    if (!goal) throw new Error('Say what you want built: proofline contract "<goal>"');
    log('drafting the contract (the planner reads the repository first)');
    const contract = await draftContract(withSessions(ctx, AUTHORING), goal);
    console.log(`\n${renderContract(contract)}\n`);
    for (const w of lintContract(contract, repoNames(ctx))) console.log(`${paint(33, 'note')} ${w}`);
    console.log(`Saved to ${path.relative(process.cwd(), contractPath(ctx.root))}. Edit it until it says what you mean, then: proofline approve`);
    return 0;
  },

  async approve(ctx) {
    const contract = loadContract(ctx.root);
    console.log(`${renderContract(contract)}\n`);
    for (const w of lintContract(contract, repoNames(ctx))) console.log(`${paint(33, 'note')} ${w}`);
    const hash = approveContract(ctx.root);
    console.log(`Approved (${hash}). Editing the contract voids this approval.\nNext: proofline plan`);
    return 0;
  },

  async plan(ctx) {
    log('planning tasks for the approved contract');
    const plan = await draftPlan(withSessions(ctx, AUTHORING));
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
      for (const repo of ctx.repos) {
        const dirty = await git(repo.root, 'status', '--porcelain', '--untracked-files=no');
        if (dirty) log(`note: uncommitted changes in ${repo.name || 'your checkout'} are not part of the run; it starts from the last commit`);
      }
      state = await createRun(ctx);
      log(`run ${state.id} started on branch ${state.branch}`);
    }
    return finish(ctx, await executeRun(recorded(ctx, state.id), state));
  },

  async verify(ctx) {
    const state = pickRun(ctx.root);
    const { contract, hash } = loadApprovedContract(ctx.root);
    if (hash !== state.contractHash) throw new Error('The contract changed since this run. Start a new run.');
    const plan = loadPlan(ctx.root);
    validatePlan(plan, contract, hash, repoNames(ctx));
    const round = await verifyRun(recorded(ctx, state.id), state, contract);
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
        console.log(`${id}  ${s.status.padEnd(9)}  ${s.branch}${repoRuns(s).map((r) => (r.prUrl ? `  ${r.prUrl}` : '')).join('')}`);
      }
      console.log('');
    }
    const state = pickRun(ctx.root);
    console.log(bold(`Run ${state.id}: ${state.status}`));
    for (const t of Object.values(state.tasks)) {
      console.log(`  ${t.id.padEnd(5)} ${t.status.padEnd(9)} ${t.repo ? `[${t.repo}] ` : ''}${t.title}${t.error ? dim(`  (${t.error})`) : ''}`);
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
    console.log(await shipRun(ctx, state, flags.draft));
    return 0;
  },

  async ui(ctx) {
    const server = await startServer(ctx.root, {
      port: Number(flags.port ?? 4717),
      host: flags.host ?? '127.0.0.1',
      allowedHosts: process.env.PROOFLINE_ALLOWED_HOSTS?.split(','),
    });
    console.log(`proofline control room for ${path.basename(ctx.root)}: ${bold(server.url)}`);
    console.log(dim('It answers only on this machine. Press Ctrl+C to stop it; a run in progress can be resumed.'));
    if (!flags['no-open']) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(opener, [server.url], {}).catch(() => {});
    }
    await new Promise<void>((resolve) => process.once('SIGINT', resolve));
    await server.close();
    return 0;
  },

  async clean(ctx) {
    const state = pickRun(ctx.root);
    await cleanRun(ctx, state);
    console.log(`Removed the worktrees of run ${state.id}. Branch ${state.branch} and the report are kept.`);
    return 0;
  },

  async go(ctx) {
    const goal = positionals.slice(1).join(' ').trim();
    if (!goal) throw new Error('Say what you want built: proofline go "<goal>"');
    log('drafting the contract');
    const contract = await draftContract(withSessions(ctx, AUTHORING), goal);
    console.log(`\n${renderContract(contract)}\n`);
    for (const w of lintContract(contract, repoNames(ctx))) console.log(`${paint(33, 'note')} ${w}`);
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
    const plan = await draftPlan(withSessions(ctx, AUTHORING));
    validatePlan(plan, contract, hash, repoNames(ctx));
    console.log(`\n${renderPlan(plan)}\n`);
    const state = await createRun(ctx);
    log(`run ${state.id} started on branch ${state.branch}`);
    return finish(ctx, await executeRun(recorded(ctx, state.id), state));
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
