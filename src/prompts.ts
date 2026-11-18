import type { Gate } from './config.js';
import type { Contract, Criterion, Finding, GateResult, ProofResult, Task } from './types.js';

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

/** In a workspace every task names the repository it changes. */
export function planSchema(repos: string[] = []): object {
  if (repos.length === 0) return PLAN_SCHEMA;
  const item = PLAN_SCHEMA.properties.tasks.items;
  return {
    ...PLAN_SCHEMA,
    properties: {
      tasks: {
        type: 'array',
        items: {
          ...item,
          properties: { ...item.properties, repo: { type: 'string', enum: repos } },
          required: [...item.required, 'repo'],
        },
      },
    },
  };
}

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

export const CHANGE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    summary: str,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { severity: { type: 'string', enum: ['blocker', 'should', 'note'] }, where: str, what: str, why: str },
        required: ['severity', 'where', 'what', 'why'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
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

const folders = (repos: string[]) => repos.map((r) => `\`${r}/\``).join(', ');

export function contractPrompt(goal: string, repos: string[] = []): string {
  const workspace = repos.length
    ? `
This directory is a workspace of ${repos.length} separate git repositories that are delivered together: ${folders(repos)}. The goal may need changes in one of them or in several.
- Every command proof runs from this workspace directory, with the repositories as folders below it. Start each command by entering the repository it tests: \`cd ${repos[0]} && ...\`.
- When the goal changes more than one repository, add at least one "review" criterion about the seam between them: for example, that the request the frontend sends and the answer it reads match what the backend accepts and returns, field by field. It is checked after every side is delivered, with all repositories in view.
`
    : '';
  return `You are drafting a delivery contract for a change to the software in this directory. Other agents will build it, and an independent verifier will check the result line by line, so every line must be checkable.

The requester's goal:
"""
${goal}
"""
${workspace}
First inspect the ${repos.length ? 'repositories' : 'repository'} (read-only) so the contract fits the real stack: the language, the test runner, the commands that already exist.

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

export function planPrompt(contract: Contract, problems: string[] = [], repos: string[] = []): string {
  const workspace = repos.length
    ? `
- This directory is a workspace of separate git repositories: ${folders(repos)}. "repo": the one repository the task changes. A task never changes two; work that spans them is one task per repository.
- When one side depends on the other (a screen that calls a new endpoint), the dependent task "needs" the other. It can then read the merged result of that task, and its brief should say what to look for and where.
- Tasks in different repositories with no dependency between them run at the same time.`
    : '';
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
- "brief": what to build and where, plus anything the builder must know. The builder sees only its brief, the criteria it covers, and notes from the tasks it needs.${workspace}${retry}`;
}

/** Where a builder can read the other repositories of the workspace, as merged so far. */
export interface Neighbour {
  name: string;
  dir: string;
}

/** What a builder is told about the gates: they exist, and they are run for it. */
function gatesNote(gates: Gate[]): string {
  if (gates.length === 0) return '';
  return `\nAfter every task is merged, these commands are also run on the whole result, and code that fails one is sent back:\n${gates.map((g) => `- ${g.name}: \`${g.run}\``).join('\n')}\n`;
}

export function buildPrompt(contract: Contract, task: Task, notes: string[], neighbours: Neighbour[] = [], gates: Gate[] = []): string {
  const mine = contract.criteria.filter((c) => task.covers.includes(c.id));
  const others = contract.criteria.filter((c) => !task.covers.includes(c.id));
  const workspace = task.repo
    ? `
This delivery spans several repositories. You are in \`${task.repo}\` and change only this one. The folder above yours is laid out like the workspace, so the contract's proof commands run from there exactly as they are written: \`cd .. && <command>\`.${
        neighbours.length
          ? `\nThe other repositories, with everything merged so far, are there to read:\n${neighbours.map((n) => `- ${n.name}: ${n.dir}`).join('\n')}\nRead them to match the real interfaces instead of guessing. Anything you change there is thrown away; if the other side has to change, say so in "notes".`
          : ''
      }
`
    : '';
  return `You are building one task of a larger delivery. You work alone in this git worktree; other tasks are being built elsewhere and will be merged with yours.
${workspace}
Goal of the whole delivery: ${contract.goal}
${contract.outOfScope.length ? `Out of scope for everyone: ${contract.outOfScope.join('; ')}\n` : ''}
Your task ${task.id}: ${task.title}
${task.brief}

${mine.length ? `Criteria you are responsible for. An independent verifier will check each one with the proof shown; your own report is not taken as proof:\n${criteriaBlock(mine)}` : 'This task prepares the ground for later tasks and has no criterion of its own.'}
${others.length ? `\nThe rest of the contract, which other tasks are building. Do not build these, but stay consistent with them:\n${others.map((c) => `- ${c.id}: ${c.text}`).join('\n')}\n` : ''}${gatesNote(gates)}${notes.length ? `\nNotes from tasks already merged:\n${notes.join('\n')}\n` : ''}
Rules:
- Stay inside the task. Leave unrelated files alone.
- Never weaken a proof to make it pass: do not edit a proof command's meaning, skip tests or stub out checks.
- Run the proof commands yourself before you finish, where you can.
- If a proof command could not pass for any correct implementation (a wrong path, a flag that does not exist), do not bend the product to fit it. Do the real work and report the problem in "concerns"; the person who owns the contract will correct it.
- Follow the conventions already in the repository.
- Commit your work with clear messages. Anything left uncommitted is committed for you.

Finish with: "status" ("done", or "blocked" if you could not complete the task), "summary" (two or three sentences on what you built), "notes" (what a later task must know: file paths, interfaces, commands) and "concerns" (problems with the contract itself, if any).`;
}

export function fixPrompt(contract: Contract, failures: ProofResult[], repos: string[] = [], gates: GateResult[] = []): string {
  const where = repos.length
    ? `in the repositories below this directory (${folders(repos)}, each a git worktree of its own)`
    : 'in this git worktree';
  const workspace = repos.length
    ? `\n- You may change any of the repositories. When two sides disagree, fix the side that is wrong; do not patch one to fit a mistake in the other.\n- Proof commands run from this directory. Commit inside each repository you change.`
    : '';
  const byId = new Map(contract.criteria.map((c) => [c.id, c]));
  const blocks = failures.map((f) => {
    const c = byId.get(f.criterion)!;
    return `- ${c.id}: ${c.text}\n  ${proofLine(c)}\n  Verifier's evidence:\n${f.evidence
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}`;
  });
  const gateBlocks = gates.map(
    (g) => `- ${g.gate}: \`${g.run}\`\n  Its output:\n${g.evidence
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}`,
  );
  const failed = [
    blocks.length ? `Failed criteria:\n${blocks.join('\n')}` : '',
    gateBlocks.length ? `Commands that every delivery here must pass. They fail on the merged result:\n${gateBlocks.join('\n')}\nFix what this delivery broke. Do not silence the command (no ignore comments, no loosened settings, no excluded files).` : '',
  ].filter(Boolean);
  return `A delivery was built and merged ${where}, but independent verification found ${blocks.length ? 'criteria that do not hold' : 'that it does not pass a required command'}. Make ${blocks.length ? 'them hold' : 'it pass'}.

Goal of the whole delivery: ${contract.goal}
${contract.outOfScope.length ? `Out of scope: ${contract.outOfScope.join('; ')}\n` : ''}
${failed.join('\n\n')}

Rules:
- Fix the product, not the proof: do not edit a proof command's meaning, skip tests or stub out checks.
- If a proof command could not pass for any correct implementation (a wrong path, a flag that does not exist), do not add files or shims whose only purpose is to satisfy it. Report the problem in "concerns" and set "status" to "blocked"; the person who owns the contract will correct it.
- Every criterion${gates.length ? ' and every required command' : ''} is verified again after your fix, so do not break the ones that pass.
- Run the proof commands yourself before you finish.
- Commit your work. Anything left uncommitted is committed for you.${workspace}

Finish with "status" ("done" or "blocked"), "summary", "notes" and "concerns" (problems with the contract itself, if any).`;
}

export function reviewPrompt(criterion: Criterion, check: string, diffStat: string, repos: string[] = []): string {
  const where = repos.length
    ? `the delivery in the current directory. It spans ${repos.length} repositories, the folders ${folders(repos)}, each with all of its work merged; when the criterion is about how they fit together, read both sides`
    : 'the repository in the current directory';
  return `You are an independent verifier. You did not build this and you have not seen the builder's reasoning or report. Decide whether ONE acceptance criterion holds in ${where}.

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

/**
 * A read of the change as a whole. The contract's lines have their own proofs;
 * this looks for what no line asked about.
 */
export function changeReviewPrompt(contract: Contract, diff: string, repos: string[] = [], instructions = ''): string {
  const where = repos.length
    ? `The change spans ${repos.length} repositories, the folders ${folders(repos)} below the current directory, each with all of its work merged.`
    : 'The change is merged in the repository in the current directory.';
  return `You are reviewing a finished change before a person merges it. You did not build it and you have not seen the builders' reasoning. ${where}

What it was meant to do: ${contract.goal}
${contract.outOfScope.length ? `Deliberately out of scope: ${contract.outOfScope.join('; ')}\n` : ''}
Its acceptance criteria each have their own proof and are checked separately. Do not repeat that work. Your job is what those lines could not see:
${contract.criteria.map((c) => `- ${c.id}: ${c.text}`).join('\n')}

The change:
\`\`\`diff
${diff || '(nothing changed)'}
\`\`\`

Read the changed files in full, and the code around them that they call or that calls them. Read the repository's own written rules first (CLAUDE.md, CONTRIBUTING, AGENTS.md or similar, where they exist) and hold the change to them.

Look for:
- Behaviour that is wrong: a case the code mishandles, an error that is swallowed, a state that goes stale.
- Data reaching someone who should not see it: another account, tenant or role.
- Cost at real size: a query per row, an unbounded list, work repeated on every render or request.
- Existing behaviour that this change breaks or silently alters.
- Tests that would still pass if the feature were broken.
- Leftovers: debug output, dead code, a file that does not belong.${repos.length ? '\n- The seam: one side sending or expecting something the other does not.' : ''}
${instructions ? `\nThis team's own checklist, which carries the same weight:\n${instructions}\n` : ''}
Rules:
- Report only what you can point to: every finding names a file and line${repos.length ? ', starting with the repository folder' : ''}.
- No style preferences and no praise. If it is not worth a person's attention before merging, leave it out.
- "blocker": merging this as it is would cause harm or wrong results. "should": a real defect or risk that can follow in a later change. "note": worth knowing, no action needed.
- Verdict "changes" if there is at least one blocker, otherwise "approve".

"summary": two or three plain sentences on the state of the change.`;
}

/** For the builder who is handed a reviewer's findings. */
export function findingsFixPrompt(contract: Contract, findings: Finding[], repos: string[] = []): string {
  const where = repos.length
    ? `in the repositories below this directory (${folders(repos)}, each a git worktree of its own)`
    : 'in this git worktree';
  const workspace = repos.length ? '\n- You may change any of the repositories. Commit inside each repository you change.' : '';
  return `A delivery was built and merged ${where}, and every line of its contract is proven. An independent reviewer then read the whole change and found the problems below. Fix them.

Goal of the whole delivery: ${contract.goal}
${contract.outOfScope.length ? `Out of scope: ${contract.outOfScope.join('; ')}\n` : ''}
Findings:
${findings.map((f, i) => `${i + 1}. ${f.where}\n   ${f.what}\n   Why it matters: ${f.why}`).join('\n')}

Rules:
- Check each finding against the code first. A reviewer can be wrong: if one does not hold, leave the code alone and say why in "notes".
- Fix what is found and nothing else. No refactoring on the way.
- Where a fix changes behaviour, add or adjust a test for it.
- Every line of the contract is verified again after your fix, so do not break one:
${contract.criteria.map((c) => `  - ${c.id}: ${c.text}`).join('\n')}
- Commit your work. Anything left uncommitted is committed for you.${workspace}

Finish with "status" ("done" or "blocked"), "summary", "notes" (one line per finding: fixed, or why not) and "concerns".`;
}
