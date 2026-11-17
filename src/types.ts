/** How one acceptance criterion gets proven. */
export type Proof =
  /** A shell command run by the harness itself. Exit code 0 is the proof. */
  | { type: 'command'; run: string; timeoutSec?: number }
  /** A yes/no question answered by an independent verifier agent, with file:line evidence. */
  | { type: 'review'; check: string };

export interface Criterion {
  id: string;
  text: string;
  proof: Proof;
}

export interface Contract {
  goal: string;
  outOfScope: string[];
  criteria: Criterion[];
}

export interface Task {
  id: string;
  title: string;
  brief: string;
  /** Criterion ids this task is responsible for. */
  covers: string[];
  /** Task ids that must be merged before this one starts. */
  needs: string[];
  /** Model for this task's builder. Empty means the builder model from the settings. */
  model?: string;
  /** In a workspace of several repositories: the one this task changes. */
  repo?: string;
}

export interface Plan {
  /** Hash of the contract this plan was made for. A changed contract invalidates the plan. */
  contractHash: string;
  tasks: Task[];
}

export type TaskStatus = 'pending' | 'building' | 'built' | 'merged' | 'failed' | 'blocked';

export interface TaskState {
  id: string;
  title: string;
  covers: string[];
  status: TaskStatus;
  attempts: number;
  commits: string[];
  /** In a workspace: the repository this task changes. A fix task has none, it may change any of them. */
  repo?: string;
  /** In a workspace: the same commits, by repository. */
  byRepo?: Record<string, string[]>;
  /** The builder's own summary. Informational only: it never counts as proof. */
  summary?: string;
  notes?: string;
  /** Problems with the contract itself that the builder raised. Builders cannot change the contract. */
  concerns?: string[];
  error?: string;
  sessionId?: string;
}

export type Verdict = 'pass' | 'fail';

export interface ProofResult {
  criterion: string;
  proofType: Proof['type'];
  verdict: Verdict;
  evidence: string;
  /** Full output of a command proof, relative to the run directory. */
  logFile?: string;
  durationMs: number;
  /** When this proof finished. */
  at?: string;
}

export interface VerificationRound {
  n: number;
  /** Commit the proofs were run against. In a workspace: one short commit per repository. */
  head: string;
  at: string;
  results: ProofResult[];
}

export interface Usage {
  calls: number;
  turns: number;
  /** As reported by the engine. On a subscription this is the list-price equivalent, not a bill. */
  costUsd: number;
  durationMs: number;
}

/** One repository of a workspace run: where its work started and where it went. */
export interface RepoRun {
  /** Folder of the repository inside the workspace. */
  name: string;
  baseBranch: string;
  baseSha: string;
  prUrl?: string;
}

export type RunStatus = 'building' | 'verifying' | 'proven' | 'unproven' | 'stopped';

export interface RunState {
  id: string;
  status: RunStatus;
  contractHash: string;
  baseBranch: string;
  baseSha: string;
  /** Integration branch that collects the merged tasks. In a workspace, every repository gets one by this name. */
  branch: string;
  /** Set when the run spans several repositories; baseBranch and baseSha above are then empty. */
  repos?: RepoRun[];
  worktreeRoot: string;
  startedAt: string;
  finishedAt?: string;
  tasks: Record<string, TaskState>;
  /**
   * Verdict of each command proof on the base commit, before any work.
   * A proof that already passes there is a regression guard: it shows nothing new was built.
   */
  baseline?: Record<string, Verdict>;
  rounds: VerificationRound[];
  /** Verdicts of the verification round in progress, so they can be shown as they arrive. */
  progress?: ProofResult[];
  usage: Record<'planner' | 'builder' | 'verifier', Usage>;
  prUrl?: string;
}
