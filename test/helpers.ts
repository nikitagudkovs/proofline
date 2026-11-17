import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, type Config } from '../src/config.js';
import { DIR, approveContract } from '../src/contract.js';
import type { AgentRequest, AgentResult, Engine } from '../src/engine.js';
import { makeCtx, type Ctx } from '../src/runner.js';
import { git } from '../src/util.js';

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
      await new Promise((r) => setTimeout(r, 30));
      const output = (await handler(req, attempt)) as T;
      return { output, turns: 1, costUsd: 0.01, durationMs: 30, sessionId: `s-${req.label}-${attempt}` };
    } finally {
      this.active -= 1;
    }
  }
}

export const done = (summary = 'built', notes = '') => ({ status: 'done', summary, notes });

/** A builder that writes files into its worktree. */
export const writes =
  (files: Record<string, string>, notes = ''): Handler =>
  (req) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(req.cwd, name)), { recursive: true });
      writeFileSync(path.join(req.cwd, name), content);
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

  const cfg: Config = { ...DEFAULTS, worktreeDir: path.join(base, 'worktrees') };
  const logs: string[] = [];
  return { root, cfg, logs, ctx: (engine) => makeCtx(root, cfg, engine, (m) => logs.push(m)) };
}
