# Design notes

## The problem

An agent that builds and then reports on its own work is marking its own homework. Three things go wrong as the work gets bigger:

1. **"Done" is a claim, not a fact.** The summary reads the same whether the feature works or not.
2. **Scope drifts.** Nothing ties a piece of work to a reason it exists, so agents add things nobody asked for and skip things somebody did.
3. **Review cost moves to the human.** Ten parallel agents produce ten summaries to audit.

proofline's answer is one rule applied everywhere: **a requirement is met when its proof passes, and for no other reason.** Everything else in the design exists to make that rule cheap to follow and hard to get around.

## Pieces

```
src/
  contract.ts   the contract file: parse, validate, hash, approve, lint
  plan.ts       the plan file: parse, validate against the contract, order into waves
  authoring.ts  planner agent drafts a contract or a plan; validators accept or reject
  runner.ts     worktrees, parallel builds, merges, the fix loop, resume
  verify.ts     baseline and verification rounds: command proofs and review proofs
  report.ts     the traceability matrix as Markdown and HTML
  engine.ts     the agent runtime behind one method; Claude Code implementation
  sessions.ts   a record of every agent run: brief, steps, answer
  server.ts     the control room's local HTTP API and live event stream
  ship.ts       push and open pull requests
  finish.ts     merge, the team's own finishing actions, clean-up
  doctor.ts     which accounts a run will use
  cli.ts        commands
ui/             the control room itself (React), built into dist/ui
```

## Three roles, three levels of trust

| Role | Can write files | Sees | Its output is |
|---|---|---|---|
| Planner | no | the repository, the goal | a draft, checked by a validator and (for the contract) approved by a person |
| Builder | yes, in its own worktree | its brief, its criteria and proofs, notes from tasks it depends on, and in a workspace the other repositories as merged so far | never trusted as evidence |
| Verifier | no | one criterion, the code, the list of changed files | a verdict that must cite `file:line`; no answer counts as fail |

The harness itself, plain code with no model in it, is the fourth actor and the most trusted: it runs command proofs, merges branches, hashes the contract and writes the report.

## Life of a run

```
createRun      integration branch + worktree off the current commit
baseline       run every command proof on the base commit; record red or green
build          wave by wave: parallel builders → sequential merges
verify         round N: all criteria against the integration branch head
fix            failed criteria + evidence → one builder → merge → verify (all criteria again)
finish         proven | unproven; report written; exit code 0 | 2
```

### Baseline: a proof must be able to fail

Before any builder starts, each command proof is run on the untouched base commit. A proof that fails there and passes after the work has shown something. A proof that already passes shows nothing new; it is labelled a *guard* in the report (which is the right thing for "the existing tests still pass", and a warning sign for anything else).

### Build: isolation by worktree

Each task gets a fresh worktree and branch off the integration branch as it stands when the task's wave starts. Tasks in one wave run concurrently and merge in plan order with `--no-ff`, so the history shows one merge per task. Worktrees live outside the repository (`~/.proofline/worktrees/`), so the repository's own tooling never trips over them, and the user's checkout is not touched at any point.

**Conflicts.** The planner is told that parallel tasks must not share files, but plans are sometimes wrong. When a merge conflicts, it is rolled back and the task is rebuilt from scratch on top of the merged result, where the conflict no longer exists. Rebuilding costs one more agent run; asking an agent to resolve conflict markers costs the certainty that both sides' intent survived.

### Verify: what counts as evidence

- **Command proofs** are executed by the harness in the integration worktree: `sh -c`, own process group, timeout, exit code. Full output is kept in `evidence/round-N/<criterion>.log`.
- **Review proofs** go to an agent with `Read`, `Grep` and `Glob` only. Its prompt contains the criterion, the question and `git diff --stat` against the base. It does not contain the builder's summary, notes or transcript. It is told that missing or partial evidence means fail, and if it errors or times out the criterion is recorded as failed.

### Fix: all criteria are re-verified

A fixer receives only the failed criteria and the evidence against them. After it merges, the whole contract is verified again, not just the lines that failed, because the cheapest way to make one test pass is to break another.

A fixer that changes nothing, or reports that it is blocked, ends the loop early: verifying the same commit twice proves nothing.

### When the contract itself is wrong

Builders cannot edit the contract, and they are told not to bend the product around a proof that could never pass (a wrong path, a flag that does not exist). They can raise a *concern*, which is recorded and shown in the report. The person who owns the contract corrects it and approves it again, which starts a new run. That is deliberate: a contract that agents can renegotiate is not a contract.

## Workspaces: one delivery across several repositories

A feature that needs an endpoint and the screen that calls it is one piece of work, and the interesting failures sit on the seam between the two. So a workspace run keeps one contract, one plan and one verification, and gives each repository its own branches and merges:

```
<run>/integration/api      everything merged so far, per repository; proofs and reviewers run above them
<run>/integration/web
<run>/reference/api        the same commits, as a separate copy that builders of other repositories read
<run>/reference/web
<run>/T2/web               the task's own worktree, the only place it can change
<run>/T2/api  → reference  a link, so the task folder is laid out like the workspace
<run>/FIX1/api, FIX1/web   a fixer gets a writable worktree of every repository
```

- **A task changes one repository.** The plan validator insists on it. That keeps a task's merge a single-repository event, which is what lets parallel tasks, conflicts and rebuilds work as they do for one repository.
- **Order across the seam is a dependency like any other.** The frontend task `needs` the backend task, so it starts after that merge and reads the real endpoint in `reference/`.
- **Builders never see the integration worktrees.** They can write files, and a stray edit there would change what the proofs see without ever being committed. The reference copies are reset to the integration heads before every wave, so a stray edit dies there.
- **Verification is the only place both sides meet.** Commands run from `integration/`, reviewers read from it, and a contract drafted for a workspace is asked for at least one review of the seam itself.
- **A fix is the one task that may cross.** A failed line does not say which side is wrong, so the fixer gets all of them writable and its commits are merged per repository.
- **Shipping is per repository.** One pull request each, into the branch that repository was on at the start, with a comment naming the others.

A single repository is the same code with one unnamed repository and no reference copies.

## Setup commands and what they leave behind

Agents and proofs work in fresh worktrees, which have no dependencies and no untracked key files. The `setup` command runs in every such copy with `PROOFLINE_SOURCE` pointing at the person's own checkout, so it can link or copy them. Whatever it leaves untracked is recorded and kept out of the task's commit: a linked `node_modules` slips past a `node_modules/` ignore rule, and it must not end up in a pull request.

## Finishing: where proofline stops and the team's own process starts

Opening and merging pull requests is the same everywhere, so those are built in, with one rule: only a proven run merges. Everything after that (deploying, updating a tracker) differs per team and often touches production. proofline does not model it. It runs a named command from the settings file, with the run's facts in the environment, and records the exit code and the last lines of output with the run.

Two limits are deliberate. Actions can be pressed from the control room but are defined only in the file, so a request from a browser can never carry a command. And nothing with consequences outside the repository happens by default: an action runs by itself only where the settings say `auto`.

Cleaning up removes what can be rebuilt (working copies, session records, evidence logs) and what is safely elsewhere (branches that are merged or pushed). A branch that exists nowhere else is kept.

## State and resume

`.proofline/runs/<id>/state.json` is rewritten (write to temp file, rename) after every transition: a task starting, finishing, merging, a verification round completing. `proofline run --resume` reloads it, recreates the integration worktree if it is gone, skips merged tasks and continues. A task that was mid-build is rebuilt from the integration branch; nothing half-finished is reused.

A run is bound to the contract hash it started with. If the contract changed, resume refuses.

## Sessions: every agent run is a record

The engine is wrapped by a recorder. For each agent run it writes two files under the run: a summary (role, model actually used, status, turns, time, cost, tools used, the brief, the structured answer) and an append-only list of steps, taken from Claude Code's event stream as it arrives. The command line and the control room share these files, so a run started in a terminal can be watched in the browser.

Steps are reduced to what a person wants to follow: what the agent said, each tool call in one line, and tool results only when they failed.

## The control room

`proofline ui` starts a small HTTP server on `127.0.0.1` over the same functions the commands call. It holds no state of its own beyond the job in progress: the contract, plan, run state, sessions and log are the files on disk, and the browser is told to re-read them through a server-sent event stream whenever one changes.

- **One job at a time.** Drafting, planning, running, verifying and shipping all work on the same repository, so a second job is refused while one is active.
- **Stop is a first-class state.** Stopping aborts the agents (each runs in its own process group, so the commands it started die with it), puts unfinished tasks back to pending and leaves the run resumable.
- **It answers only to its own page.** The server can start agents that run shell commands, so two checks guard every request: a random token embedded in the served page (another site cannot read it, so it cannot forge requests) and a `Host` allow-list (a hostile page cannot reach it by pointing its own domain at 127.0.0.1).
- **Models are a person's choice.** Per role in the settings, per task in the plan. The planner never picks them.

The same interface doubles as a recording player: a build flag swaps the server for one exported run and a clock, which is how the public demo replays a real run with nothing behind it.

## The engine interface

```ts
interface Engine {
  run<T>(req: {
    role: 'planner' | 'builder' | 'verifier';
    label: string;
    prompt: string;
    cwd: string;
    schema: object;   // JSON Schema for the final answer
    write: boolean;
    model?: string;                      // per-task override
    onEvent?: (e: AgentEvent) => void;   // live steps
    signal?: AbortSignal;                // stop
  }): Promise<{ output: T; turns: number; costUsd: number; durationMs: number; sessionId?: string; model?: string }>;
}
```

`ClaudeCodeEngine` spawns `claude -p --output-format stream-json --json-schema …` per request, with read-only tools for planners and verifiers. Because it drives the installed CLI rather than an API client, a run uses the user's existing Claude Code login, and with `auth: subscription` the API-key variables are stripped from the child's environment.

The test suite implements the same interface with scripted agents that write real files into real worktrees, which lets it exercise merges, conflicts, fix rounds and resume end to end without a model.

## Deliberately left out

- **Agents talking to each other.** Tasks communicate through the merged code and a short notes field. Chat between agents is hard to audit and easy to derail.
- **A hosted service or a database.** The control room is a local process over plain files. State is JSON, the report is a static HTML page, and both can be read without proofline running.
- **Automatic conflict resolution, automatic contract edits, automatic merging.** Each of these would let an agent change what "done" means. Merging is a button a person presses, and only for a proven run.

## Where it could go

- Mid-run contract amendments that re-verify instead of rebuilding.
- A ready-queue scheduler (start a task the moment its dependencies merge) instead of waves.
- Mutation-style checks on proofs: break the implementation on purpose and confirm the proof notices.
- More engines behind the same interface.
