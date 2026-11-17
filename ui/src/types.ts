import type { Config } from '../../src/config';
import type { Check } from '../../src/doctor';
import type { SessionEvent, SessionMeta } from '../../src/sessions';
import type { Contract, Criterion, Plan, ProofResult, RunState, Task, TaskState } from '../../src/types';

export type { Check, Config, Contract, Criterion, Plan, ProofResult, RunState, SessionEvent, SessionMeta, Task, TaskState };

export interface LogLine {
  t: string;
  msg: string;
}

export interface RunSummary {
  id: string;
  status: RunState['status'];
  branch: string;
  startedAt: string;
  finishedAt?: string;
  proven: number;
  total: number;
  prUrl?: string;
  prUrls?: { repo: string; url: string }[];
}

export interface Overview {
  /** `repos` lists the repositories of a workspace; it is empty when this folder is the one repository. */
  repo: { name: string; root: string; repos?: string[] };
  job: { kind: 'contract' | 'plan' | 'run' | 'verify' | 'ship' | 'review' | 'merge' | 'action' | 'clean'; runId: string; startedAt: string } | null;
  lastError: string;
  config: Config;
  accounts: Check[];
  contract: { exists: boolean; contract?: Contract; hash?: string; approved: boolean; warnings: string[]; problems?: string[] };
  plan: { exists: boolean; plan?: Plan; problems: string[]; waves: string[][] };
  runs: RunSummary[];
  authoring: { sessions: SessionMeta[]; log: LogLine[] };
}

export interface RunView {
  state: RunState;
  sessions: SessionMeta[];
  log: LogLine[];
  current: boolean;
  /** How far the run has come: which finishing steps are on offer. Absent in recordings made before these existed. */
  stage?: { proven: boolean; shipped: boolean; merged: boolean };
}

export interface SessionView {
  meta: SessionMeta;
  events: SessionEvent[];
  changes: string;
}

/** A recorded run, bundled into the static demo build. */
export interface DemoData {
  overview: Overview;
  run: RunView;
  sessions: Record<string, SessionView>;
}

export const AUTHORING = '_authoring';
