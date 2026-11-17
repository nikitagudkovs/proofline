import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig, type Config } from '../src/config.js';
import { DIR, approveContract } from '../src/contract.js';
import type { AgentRequest, AgentResult, Engine } from '../src/engine.js';
import { makeCtx, type Ctx } from '../src/runner.js';
import { AbortError, git } from '../src/util.js';

type Handler = (req: AgentRequest, attempt: number) => unknown | Promise<unknown>;

/** Stands in for real agents: each label (task or criterion id) gets a scripted behaviour. */
export class ScriptedEngine implements Engine {
  readonly requests: AgentRequest[] = [];
  maxParallel = 0;
  private active = 0;
  private attempts = new Map<string, number>();

  constructor(public handlers: Record<string, Handler>) {}

  async run<T>(req: AgentRequest): Promise<AgentResult<T>> {
    this.requests.push(req);
    const attempt = (this.attempts.get(req.label) ?? 0) + 1;
    this.attempts.set(req.label, attempt);
    const handler = this.handlers[req.label];
    if (!handler) throw new Error(`no scripted behaviour for ${req.role} ${req.label}`);
    this.active += 1;
    this.maxParallel = Math.max(this.maxParallel, this.active);
    try {
      req.onEvent?.({ kind: 'start', text: 'session started on scripted', model: 'scripted' });
      await new Promise((r) => setTimeout(r, 30));
      if (req.signal?.aborted) throw new AbortError();
      const output = (await handler(req, attempt)) as T;
      return { output, turns: 1, costUsd: 0.01, durationMs: 30, sessionId: `s-${req.label}-${attempt}` };
    } finally {
      this.active -= 1;
    }
  }
}

export const done = (summary = 'built', notes = '') => ({ status: 'done', summary, notes });

/** A builder that never finishes by itself: it works until the run is stopped. */
export const hangs: Handler = (req) =>
  new Promise((_, reject) => req.signal!.addEventListener('abort', () => reject(new AbortError()), { once: true }));

/** A builder that writes files into its worktree. */
export const writes =
  (files: Record<string, string>, notes = ''): Handler =>
  (req) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(req.cwd, name)), { recursive: true });
      writeFileSync(path.join(req.cwd, name), content);
      req.onEvent?.({ kind: 'tool', tool: 'Write', text: name });
    }
    return done(`wrote ${Object.keys(files).join(', ')}`, notes);
  };

export interface Fixture {
  root: string;
  cfg: Config;
  ctx: (engine: Engine) => Ctx;
  logs: string[];
}

/** A throwaway git repository with an approved contract and a plan. */
export async function fixture(contractYaml: string, planTasksYaml: string): Promise<Fixture> {
  const base = mkdtempSync(path.join(os.tmpdir(), 'proofline-test-'));
  const root = path.join(base, 'repo');
  mkdirSync(path.join(root, DIR), { recursive: true });
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'README.md'), '# demo\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'initial');

  writeFileSync(path.join(root, DIR, 'contract.yaml'), contractYaml);
  const hash = approveContract(root);
  writeFileSync(path.join(root, DIR, 'plan.yaml'), `contract_hash: ${hash}\n${planTasksYaml}`);

  // Worktrees go next to the throwaway repository, also for code that reads the settings file itself.
  const cfg: Config = { ...DEFAULTS, worktreeDir: path.join(base, 'worktrees') };
  writeFileSync(path.join(root, DIR, 'config.yaml'), `worktreeDir: ${cfg.worktreeDir}\n`);
  const logs: string[] = [];
  return { root, cfg, logs, ctx: (engine) => makeCtx(root, cfg, engine, (m) => logs.push(m)) };
}

async function emptyRepo(root: string, branch: string): Promise<void> {
  mkdirSync(root, { recursive: true });
  await git(root, 'init', '-q', '-b', branch);
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'README.md'), `# ${path.basename(root)}\n`);
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'initial');
}

/**
 * A throwaway workspace: a plain folder holding two repositories, `api` (on branch develop)
 * and `web` (on main), with one approved contract and one plan for both.
 */
export async function workspace(contractYaml: string, planTasksYaml: string, settings = ''): Promise<Fixture> {
  const base = mkdtempSync(path.join(os.tmpdir(), 'proofline-test-'));
  const root = path.join(base, 'ws');
  await emptyRepo(path.join(root, 'api'), 'develop');
  await emptyRepo(path.join(root, 'web'), 'main');
  mkdirSync(path.join(root, DIR), { recursive: true });
  writeFileSync(path.join(root, DIR, 'config.yaml'), `worktreeDir: ${path.join(base, 'worktrees')}\nrepos: [api, web]\n${settings}`);
  writeFileSync(path.join(root, DIR, 'contract.yaml'), contractYaml);
  const hash = approveContract(root);
  writeFileSync(path.join(root, DIR, 'plan.yaml'), `contract_hash: ${hash}\n${planTasksYaml}`);
  const cfg = loadConfig(root);
  const logs: string[] = [];
  return { root, cfg, logs, ctx: (engine) => makeCtx(root, cfg, engine, (m) => logs.push(m)) };
}

/**
 * Give each repository of a workspace fixture a remote, and put a stand-in for the GitHub CLI
 * on the PATH that records how it was called and answers like a repository that merges at once.
 */
export async function fakeGitHub(root: string): Promise<{ calls: () => string; remote: (repo: string) => string; restore: () => void }> {
  const base = path.dirname(root);
  for (const repo of ['api', 'web']) {
    await git(base, 'init', '-q', '--bare', `${repo}.git`);
    await git(path.join(root, repo), 'remote', 'add', 'origin', path.join(base, `${repo}.git`));
  }
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'gh-calls.txt');
  mkdirSync(bin);
  writeFileSync(log, '');
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
echo "$(basename "$PWD") $*" >> "${log}"
[ "$2" = create ] && echo "https://example.test/$(basename "$PWD")/pull/1"
[ "$2" = view ] && echo MERGED
exit 0
`,
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return { calls: () => readFileSync(log, 'utf8'), remote: (repo) => path.join(base, `${repo}.git`), restore: () => void (process.env.PATH = oldPath) };
}
