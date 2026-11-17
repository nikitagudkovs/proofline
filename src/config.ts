import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { DIR } from './contract.js';

/** One repository of a workspace: a folder next to the others, with its own git history. */
export interface RepoConfig {
  path: string;
  /** Run in every copy of this repository before agents or proofs use it. */
  setup: string;
}

/** A repository as a run sees it. A single-repository run has one, with an empty name. */
export interface Repo {
  name: string;
  /** The checkout the person works in. A run never changes it. */
  root: string;
  setup: string;
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
  /** Where task worktrees live. Outside the repository, so your own tooling never scans them. */
  worktreeDir: string;
  /**
   * "subscription": agents run on your Claude Code login; API keys in the environment are
   * removed from the agent's environment so they can never be billed by accident.
   * "inherit": pass the environment through untouched.
   */
  auth: 'subscription' | 'inherit';
  /** Model alias or id per role. Empty means your Claude Code default. */
  models: { planner: string; builder: string; verifier: string };
  builder: { permissionMode: string; allowedTools: string[] };
  /** Extra arguments for every `claude` process, e.g. ["--setting-sources", "project"]. */
  claudeArgs: string[];
  timeouts: { plannerMin: number; builderMin: number; verifierMin: number; commandSec: number };
}

export const DEFAULTS: Config = {
  concurrency: 3,
  maxFixRounds: 2,
  setup: '',
  repos: [],
  worktreeDir: path.join(os.homedir(), '.proofline', 'worktrees'),
  auth: 'subscription',
  models: { planner: '', builder: '', verifier: '' },
  builder: {
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep'],
  },
  claudeArgs: [],
  timeouts: { plannerMin: 15, builderMin: 45, verifierMin: 10, commandSec: 600 },
};

export const configPath = (root: string) => path.join(root, DIR, 'config.yaml');

function readRaw(root: string): Record<string, any> {
  const file = configPath(root);
  return existsSync(file) ? (YAML.parse(readFileSync(file, 'utf8')) ?? {}) : {};
}

/** `repos` may be written as plain folder names or as { path, setup }. */
function parseRepos(raw: unknown): RepoConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (typeof r === 'string' ? { path: r, setup: '' } : { path: String(r?.path ?? ''), setup: String(r?.setup ?? '') }))
    .map((r) => ({ ...r, path: r.path.trim().replace(/^\.\//, '').replace(/\/+$/, '') }))
    .filter((r) => r.path);
}

export function loadConfig(root: string): Config {
  const raw = readRaw(root);
  return {
    ...DEFAULTS,
    ...raw,
    repos: parseRepos(raw.repos),
    models: { ...DEFAULTS.models, ...raw.models },
    builder: { ...DEFAULTS.builder, ...raw.builder },
    timeouts: { ...DEFAULTS.timeouts, ...raw.timeouts },
  };
}

/** The repositories a run works on: the workspace's list, or this folder itself. */
export function repoList(root: string, cfg: Config): Repo[] {
  if (cfg.repos.length === 0) return [{ name: '', root, setup: cfg.setup }];
  return cfg.repos.map((r) => ({ name: r.path, root: path.join(root, r.path), setup: r.setup }));
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
# PROOFLINE_SOURCE is your own checkout of it: ln -sfn "$PROOFLINE_SOURCE/node_modules" node_modules
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
`;
