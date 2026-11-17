import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DIR } from './contract.js';
import type { RunState } from './types.js';

export const runsDir = (root: string) => path.join(root, DIR, 'runs');
export const runDir = (root: string, id: string) => path.join(runsDir(root), id);
export const sessionsDir = (root: string, id: string) => path.join(runDir(root, id), 'sessions');
/** Planner sessions happen before a run exists; they are kept here. */
export const AUTHORING = '_authoring';

/** Called after every saved change; the UI server uses it to push updates to the browser. */
export const stateListeners = new Set<(root: string, state: RunState) => void>();

/** Written after every state change, so a killed run can be resumed where it stopped. */
export function saveState(root: string, state: RunState): void {
  const dir = runDir(root, state.id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
  for (const listener of stateListeners) listener(root, state);
}

export function loadState(root: string, id: string): RunState {
  const file = path.join(runDir(root, id), 'state.json');
  if (!existsSync(file)) throw new Error(`No run ${id} in this repository`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listRuns(root: string): string[] {
  if (!existsSync(runsDir(root))) return [];
  return readdirSync(runsDir(root))
    .filter((id) => existsSync(path.join(runDir(root, id), 'state.json')))
    .sort();
}

export function latestRun(root: string): RunState {
  const ids = listRuns(root);
  if (ids.length === 0) throw new Error('No runs yet. Start one with: proofline run');
  return loadState(root, ids[ids.length - 1]);
}

export function newRunId(now = new Date()): string {
  const s = now.toISOString().replace(/[-:]/g, '');
  return `${s.slice(0, 8)}-${s.slice(9, 15)}`;
}
