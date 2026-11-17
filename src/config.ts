import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { DIR } from './contract.js';

export interface Config {
  /** How many builders (and review verifiers) run at once. */
  concurrency: number;
  /** How many times failed criteria are sent back to a builder before the run gives up. */
  maxFixRounds: number;
  /** Shell command run in the integration worktree before command proofs, e.g. "npm ci". */
  setup: string;
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
  timeouts: { plannerMin: number; builderMin: number; verifierMin: number; commandSec: number };
}

export const DEFAULTS: Config = {
  concurrency: 3,
  maxFixRounds: 2,
  setup: '',
  worktreeDir: path.join(os.homedir(), '.proofline', 'worktrees'),
  auth: 'subscription',
  models: { planner: '', builder: '', verifier: '' },
  builder: {
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep'],
  },
  timeouts: { plannerMin: 15, builderMin: 45, verifierMin: 10, commandSec: 600 },
};

export const configPath = (root: string) => path.join(root, DIR, 'config.yaml');

export function loadConfig(root: string): Config {
  const file = configPath(root);
  const raw = existsSync(file) ? (YAML.parse(readFileSync(file, 'utf8')) ?? {}) : {};
  return {
    ...DEFAULTS,
    ...raw,
    models: { ...DEFAULTS.models, ...raw.models },
    builder: { ...DEFAULTS.builder, ...raw.builder },
    timeouts: { ...DEFAULTS.timeouts, ...raw.timeouts },
  };
}

export const CONFIG_TEMPLATE = `# proofline settings. Every line is optional; these are the defaults.

# Builders (and review verifiers) running at the same time.
concurrency: 3

# Failed criteria go back to a builder this many times before the run gives up.
maxFixRounds: 2

# Run in the integration worktree before command proofs, e.g. "npm ci".
setup: ""

# subscription = agents use your Claude Code login and never an API key.
auth: subscription

# Model per role (alias or full id). Empty = your Claude Code default.
models:
  planner: ""
  builder: ""
  verifier: ""
`;
