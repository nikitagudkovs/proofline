import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { DIR } from './contract.js';

/**
 * A gate: your own command that every delivery must pass, whatever its contract says (a typecheck,
 * a linter). It is run on the merged result in every verification round, next to the contract's proofs.
 */
export interface GateConfig {
  name: string;
  /** Shell command. Exit code 0 passes. */
  run: string;
  /** Empty means the commands' timeout from the settings. */
  timeoutSec?: number;
}

/** A gate as a run sees it. In a workspace, one that belongs to a repository is named after it and runs inside it. */
export interface Gate extends GateConfig {
  repo?: string;
}

/** One repository of a workspace: a folder next to the others, with its own git history. */
export interface RepoConfig {
  path: string;
  /** Run in every copy of this repository before agents or proofs use it. */
  setup: string;
  /** Start every run from this branch as it is on the remote, whatever the checkout is on. */
  base?: string;
  /** Gates that run inside this repository. */
  gates?: GateConfig[];
}

/** A repository as a run sees it. A single-repository run has one, with an empty name. */
export interface Repo {
  name: string;
  /** The checkout the person works in. A run never changes it. */
  root: string;
  setup: string;
  /** Set when runs start from `origin/<base>`, fetched first, and not from the checkout's own branch. */
  base?: string;
}

/** A step in a run's life that a finishing action can wait for or follow. */
export type Stage = 'proven' | 'shipped' | 'merged';

/**
 * A finishing action: your own command, offered as a button once a run is far enough along.
 * This is where a team's own last mile goes (deploy, update a tracker, post to chat), so
 * proofline itself never needs to know about it.
 */
export interface ActionConfig {
  name: string;
  /** Shell command, run from the folder proofline was started in. See README for the PROOFLINE_* variables it gets. */
  run: string;
  /** The button is offered once the run has reached this stage. Default: proven. */
  needs: Stage;
  /** Also run it without being asked, right after this stage. */
  auto?: Stage;
  /** A question the control room asks before running it. */
  confirm?: string;
}

export interface Config {
  /** How many builders (and review verifiers) run at once. */
  concurrency: number;
  /** How many times failed criteria are sent back to a builder before the run gives up. */
  maxFixRounds: number;
  /**
   * Shell command run in every copy of the repository (each task's and the one the proofs run in),
   * e.g. "npm ci". PROOFLINE_SOURCE holds the path of your own checkout, for files git does not track:
   * `ln -sfn "$PROOFLINE_SOURCE/node_modules" node_modules`.
   */
  setup: string;
  /**
   * Several repositories side by side under this folder, delivered as one piece of work.
   * Empty means this folder is itself the one repository.
   */
  repos: RepoConfig[];
  /** How "merge" merges a pull request. */
  mergeMethod: 'merge' | 'squash' | 'rebase';
  /** Finishing actions. Set in the file only: the control room can run them but never edit them. */
  actions: ActionConfig[];
  /**
   * Gates, run from the folder the proofs run in. In a workspace that is the folder holding the
   * repositories; a gate for one repository goes under that repository instead.
   */
  gates: GateConfig[];
  /** Where task worktrees live. Outside the repository, so your own tooling never scans them. */
  worktreeDir: string;
  /**
   * "subscription": agents run on your Claude Code login; API keys in the environment are
   * removed from the agent's environment so they can never be billed by accident.
   * "inherit": pass the environment through untouched.
   */
  auth: 'subscription' | 'inherit';
  /** Model alias or id per role. Empty means your Claude Code default; an empty reviewer means the verifier's. */
  models: { planner: string; builder: string; verifier: string; reviewer: string };
  /** Extra instructions for the reviewer of a whole change: a team's own checklist. */
  reviewInstructions: string;
  /** Start every run from this branch as it is on the remote (fetched first), not from the checkout. Empty = the checkout's branch. */
  base: string;
  builder: { permissionMode: string; allowedTools: string[] };
  /** Extra arguments for every `claude` process, e.g. ["--setting-sources", "project"]. */
  claudeArgs: string[];
  timeouts: { plannerMin: number; builderMin: number; verifierMin: number; reviewerMin: number; commandSec: number };
}

export const DEFAULTS: Config = {
  concurrency: 3,
  maxFixRounds: 2,
  setup: '',
  repos: [],
  mergeMethod: 'merge',
  actions: [],
  gates: [],
  worktreeDir: path.join(os.homedir(), '.proofline', 'worktrees'),
  auth: 'subscription',
  models: { planner: '', builder: '', verifier: '', reviewer: '' },
  reviewInstructions: '',
  base: '',
  builder: {
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep'],
  },
  claudeArgs: [],
  timeouts: { plannerMin: 15, builderMin: 45, verifierMin: 10, reviewerMin: 25, commandSec: 600 },
};

export const configPath = (root: string) => path.join(root, DIR, 'config.yaml');

function readRaw(root: string): Record<string, any> {
  const file = configPath(root);
  return existsSync(file) ? (YAML.parse(readFileSync(file, 'utf8')) ?? {}) : {};
}

function parseGates(raw: unknown): GateConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g) => ({
      name: String(g?.name ?? '').trim(),
      run: String(g?.run ?? '').trim(),
      ...(Number(g?.timeoutSec) > 0 ? { timeoutSec: Number(g.timeoutSec) } : {}),
    }))
    .filter((g, i, all) => g.name && g.run && all.findIndex((x) => x.name === g.name) === i);
}

/** `repos` may be written as plain folder names or as { path, setup }. */
function parseRepos(raw: unknown): RepoConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) =>
      typeof r === 'string'
        ? { path: r, setup: '' }
        : {
            path: String(r?.path ?? ''),
            setup: String(r?.setup ?? ''),
            ...(r?.base ? { base: String(r.base).trim() } : {}),
            ...(parseGates(r?.gates).length ? { gates: parseGates(r.gates) } : {}),
          },
    )
    .map((r) => ({ ...r, path: r.path.trim().replace(/^\.\//, '').replace(/\/+$/, '') }))
    .filter((r) => r.path);
}

const STAGES: Stage[] = ['proven', 'shipped', 'merged'];
const stage = (v: unknown): Stage | undefined => STAGES.find((s) => s === v);

function parseActions(raw: unknown): ActionConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => ({
      name: String(a?.name ?? '').trim(),
      run: String(a?.run ?? '').trim(),
      needs: stage(a?.needs) ?? 'proven',
      ...(stage(a?.auto) ? { auto: stage(a.auto) } : {}),
      ...(a?.confirm ? { confirm: String(a.confirm) } : {}),
    }))
    .filter((a) => a.name && a.run);
}

export function loadConfig(root: string): Config {
  const raw = readRaw(root);
  return {
    ...DEFAULTS,
    ...raw,
    repos: parseRepos(raw.repos),
    actions: parseActions(raw.actions),
    gates: parseGates(raw.gates),
    mergeMethod: ['squash', 'rebase'].includes(raw.mergeMethod) ? raw.mergeMethod : 'merge',
    reviewInstructions: typeof raw.reviewInstructions === 'string' ? raw.reviewInstructions.trim() : '',
    base: typeof raw.base === 'string' ? raw.base.trim() : '',
    models: { ...DEFAULTS.models, ...raw.models },
    builder: { ...DEFAULTS.builder, ...raw.builder },
    timeouts: { ...DEFAULTS.timeouts, ...raw.timeouts },
  };
}

/** The repositories a run works on: the workspace's list, or this folder itself. */
export function repoList(root: string, cfg: Config): Repo[] {
  if (cfg.repos.length === 0) return [{ name: '', root, setup: cfg.setup, ...(cfg.base ? { base: cfg.base } : {}) }];
  return cfg.repos.map((r) => ({ name: r.path, root: path.join(root, r.path), setup: r.setup, ...(r.base ? { base: r.base } : {}) }));
}

/** Every gate of a run: each repository's own, under the repository's name, then the ones for the whole. */
export function gateList(cfg: Config): Gate[] {
  const own = cfg.repos.flatMap((r) => (r.gates ?? []).map((g) => ({ ...g, name: `${r.path}: ${g.name}`, repo: r.path })));
  return [...own, ...cfg.gates];
}

/** The nearest folder at or above `start` whose settings list several repositories. */
export function findWorkspace(start: string): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    try {
      if (parseRepos(readRaw(dir).repos).length) return dir;
    } catch {
      // an unreadable settings file further up is not ours to judge
    }
    if (dir === path.dirname(dir)) return undefined;
  }
}

export function workspaceTemplate(repos: string[]): string {
  const [head, tail] = CONFIG_TEMPLATE.split(SETUP_LINES);
  return `${head}${tail}
# The repositories delivered together: folders inside this workspace, each with its own git history.
# "setup" runs in every copy of that repository before agents and proofs use it.
# "base: develop" on a repository starts every run from origin/develop, whatever its checkout is on.
# PROOFLINE_SOURCE is your own checkout of it: ln -sfn "$PROOFLINE_SOURCE/node_modules" node_modules
# "gates" on a repository run inside it: gates: [{ name: typecheck, run: npx tsc --noEmit }]
repos:
${repos.map((r) => `  - path: ${r}\n    setup: ""`).join('\n')}
`;
}

const SETUP_LINES = `# Run in every copy of the repository before agents and proofs use it, e.g. "npm ci".
# PROOFLINE_SOURCE is the path of your own checkout: ln -sfn "$PROOFLINE_SOURCE/node_modules" node_modules
setup: ""

`;

export const CONFIG_TEMPLATE = `# proofline settings. Every line is optional; these are the defaults.

# Builders (and review verifiers) running at the same time.
concurrency: 3

# Failed criteria go back to a builder this many times before the run gives up.
maxFixRounds: 2

${SETUP_LINES}# subscription = agents use your Claude Code login and never an API key.
auth: subscription

# Model per role (alias or full id). Empty = your Claude Code default.
models:
  planner: ""
  builder: ""
  verifier: ""
  # Reads the whole change when you press Review. Empty = the verifier's model.
  reviewer: ""

# Your own checklist for that review, on top of the built-in one. For example:
# reviewInstructions: |
#   Every new endpoint checks that the record belongs to the signed-in account.
#   New text is added to every locale file.

# Gates: commands every delivery must pass, whatever its contract says. They run on the merged
# result in every verification round, and a failure goes back to a builder like a failed criterion.
# gates:
#   - name: typecheck
#     run: npx tsc --noEmit
`;
