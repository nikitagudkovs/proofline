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
}

export interface VerificationRound {
  n: number;
  /** Commit the proofs were run against. */
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

export type RunStatus = 'building' | 'verifying' | 'proven' | 'unproven';

export interface RunState {
  id: string;
  status: RunStatus;
  contractHash: string;
  baseBranch: string;
  baseSha: string;
  /** Integration branch that collects the merged tasks. */
  branch: string;
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
  usage: Record<'planner' | 'builder' | 'verifier', Usage>;
  prUrl?: string;
}
