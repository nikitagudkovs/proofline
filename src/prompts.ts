import type { Contract, Criterion, ProofResult, Task } from './types.js';

const str = { type: 'string' } as const;
const strList = { type: 'array', items: str } as const;

export const CONTRACT_SCHEMA = {
  type: 'object',
  properties: {
    goal: str,
    out_of_scope: strList,
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: str,
          text: str,
          proof_type: { type: 'string', enum: ['command', 'review'] },
          proof: str,
        },
        required: ['id', 'text', 'proof_type', 'proof'],
      },
    },
  },
  required: ['goal', 'criteria'],
};

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: str, title: str, brief: str, covers: strList, needs: strList },
        required: ['id', 'title', 'brief', 'covers', 'needs'],
      },
    },
  },
  required: ['tasks'],
};

export const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: str,
    notes: str,
    concerns: strList,
  },
  required: ['status', 'summary'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    evidence: str,
  },
  required: ['verdict', 'evidence'],
};

export interface BuildOutput {
  status: 'done' | 'blocked';
  summary: string;
  notes?: string;
  /** Problems with the contract itself, for the person who owns it. */
  concerns?: string[];
}

export interface ReviewOutput {
  verdict: 'pass' | 'fail';
  evidence: string;
}

function proofLine(c: Criterion): string {
  return c.proof.type === 'command' ? `proof (command): \`${c.proof.run}\`` : `proof (review): ${c.proof.check}`;
}

function criteriaBlock(criteria: Criterion[]): string {
  return criteria.map((c) => `- ${c.id}: ${c.text}\n  ${proofLine(c)}`).join('\n');
}

export function contractPrompt(goal: string): string {
  return `You are drafting a delivery contract for a change to the software in this directory. Other agents will build it, and an independent verifier will check the result line by line, so every line must be checkable.

The requester's goal:
"""
${goal}
"""

First inspect the repository (read-only) so the contract fits the real stack: the language, the test runner, the commands that already exist.

Then write the contract:
- 3 to 12 acceptance criteria with ids C1, C2, ... in order. Each one is a single observable outcome, not an implementation step.
- Each criterion has exactly one proof:
  - "command": a shell command run from the repository root that exits 0 only when the criterion holds (a named test, a script, a grep). Use this whenever a command can prove it. It must be non-interactive and finish within a few minutes.
  - "review": a precise yes/no question a reviewer answers by reading the code. Use it only when no command can prove the criterion.
- A command proof must test its own criterion. Running the whole test suite proves "the existing tests still pass" and nothing else; for new behaviour, name the specific test file that will exist.
- A command proof must be able to pass. Build it from invocations this repository already uses (its package scripts, Makefile, CI config), and pass explicit file paths rather than a bare directory or a name filter that could match nothing.
- A command proof must fail today, before the work, unless the criterion is about keeping something that already works.
- Avoid words no proof can check ("properly", "clean", "robust"). Say what is observable.
- List what is out of scope, so builders do not wander.
- Do not add criteria the goal did not ask for.

Restate the goal in one or two plain sentences in "goal".`;
}

export function planPrompt(contract: Contract, problems: string[] = []): string {
  const retry = problems.length
    ? `\n\nYour previous plan was rejected by the validator. Fix exactly these problems:\n${problems.map((p) => `- ${p}`).join('\n')}`
    : '';
  return `Break an approved delivery contract into build tasks. Each task is built by a separate coding agent in its own copy of the repository (a git worktree); the copies are merged afterwards.

Goal: ${contract.goal}

Acceptance criteria:
${criteriaBlock(contract.criteria)}
${contract.outOfScope.length ? `\nOut of scope:\n${contract.outOfScope.map((o) => `- ${o}`).join('\n')}\n` : ''}
Inspect the repository (read-only) before you plan.

Rules:
- Task ids are T1, T2, ... Each task fits one agent session and touches one coherent slice of files. A small contract may need a single task; do not split for the sake of it.
- "covers": the criteria the task is responsible for. Every criterion must be covered by at least one task. A task that covers nothing is allowed only when another task needs it.
- "needs": tasks that must be merged before this one starts. Tasks with no dependency between them run at the same time on separate copies, so they must not edit the same files. If two pieces of work touch the same file, make one need the other, or make them one task.
- The test that proves a criterion belongs to the task that covers that criterion.
- "brief": what to build and where, plus anything the builder must know. The builder sees only its brief, the criteria it covers, and notes from the tasks it needs.${retry}`;
}

export function buildPrompt(contract: Contract, task: Task, notes: string[]): string {
  const mine = contract.criteria.filter((c) => task.covers.includes(c.id));
  const others = contract.criteria.filter((c) => !task.covers.includes(c.id));
  return `You are building one task of a larger delivery. You work alone in this git worktree; other tasks are being built elsewhere and will be merged with yours.

Goal of the whole delivery: ${contract.goal}
${contract.outOfScope.length ? `Out of scope for everyone: ${contract.outOfScope.join('; ')}\n` : ''}
Your task ${task.id}: ${task.title}
${task.brief}

${mine.length ? `Criteria you are responsible for. An independent verifier will check each one with the proof shown; your own report is not taken as proof:\n${criteriaBlock(mine)}` : 'This task prepares the ground for later tasks and has no criterion of its own.'}
${others.length ? `\nThe rest of the contract, which other tasks are building. Do not build these, but stay consistent with them:\n${others.map((c) => `- ${c.id}: ${c.text}`).join('\n')}\n` : ''}${notes.length ? `\nNotes from tasks already merged:\n${notes.join('\n')}\n` : ''}
Rules:
- Stay inside the task. Leave unrelated files alone.
- Never weaken a proof to make it pass: do not edit a proof command's meaning, skip tests or stub out checks.
- Run the proof commands yourself before you finish, where you can.
- If a proof command could not pass for any correct implementation (a wrong path, a flag that does not exist), do not bend the product to fit it. Do the real work and report the problem in "concerns"; the person who owns the contract will correct it.
- Follow the conventions already in the repository.
- Commit your work with clear messages. Anything left uncommitted is committed for you.

Finish with: "status" ("done", or "blocked" if you could not complete the task), "summary" (two or three sentences on what you built), "notes" (what a later task must know: file paths, interfaces, commands) and "concerns" (problems with the contract itself, if any).`;
}

export function fixPrompt(contract: Contract, failures: ProofResult[]): string {
  const byId = new Map(contract.criteria.map((c) => [c.id, c]));
  const blocks = failures.map((f) => {
    const c = byId.get(f.criterion)!;
    return `- ${c.id}: ${c.text}\n  ${proofLine(c)}\n  Verifier's evidence:\n${f.evidence
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}`;
  });
  return `A delivery was built and merged in this git worktree, but independent verification found criteria that do not hold. Make them hold.

Goal of the whole delivery: ${contract.goal}
${contract.outOfScope.length ? `Out of scope: ${contract.outOfScope.join('; ')}\n` : ''}
Failed criteria:
${blocks.join('\n')}

Rules:
- Fix the product, not the proof: do not edit a proof command's meaning, skip tests or stub out checks.
- If a proof command could not pass for any correct implementation (a wrong path, a flag that does not exist), do not add files or shims whose only purpose is to satisfy it. Report the problem in "concerns" and set "status" to "blocked"; the person who owns the contract will correct it.
- Every criterion is verified again after your fix, so do not break the ones that pass.
- Run the proof commands yourself before you finish.
- Commit your work. Anything left uncommitted is committed for you.

Finish with "status" ("done" or "blocked"), "summary", "notes" and "concerns" (problems with the contract itself, if any).`;
}

export function reviewPrompt(criterion: Criterion, check: string, diffStat: string): string {
  return `You are an independent verifier. You did not build this and you have not seen the builder's reasoning or report. Decide whether ONE acceptance criterion holds in the repository in the current directory.

Criterion ${criterion.id}: ${criterion.text}
Question to answer: ${check}

Files changed in this delivery:
${diffStat || '(no files changed)'}

Rules:
- Read the actual code. The list above is only a starting point.
- Verdict "pass" only if you can point to concrete evidence: file paths with line numbers.
- If the evidence is missing, ambiguous, or satisfies the criterion only in part, the verdict is "fail".
- Give no credit for intent, comments or TODOs.

"evidence": one to four sentences with file:line references that justify the verdict.`;
}
