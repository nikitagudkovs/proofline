import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DIR, loadApprovedContract, parseContract, saveContract, serializeContract } from './contract.js';
import { planProblems, savePlan } from './plan.js';
import { CONTRACT_SCHEMA, contractPrompt, planPrompt, planSchema } from './prompts.js';
import { repoNames, type Ctx } from './runner.js';
import type { AgentResult } from './engine.js';
import type { Contract, Plan, Task, Usage } from './types.js';
import { ValidationError } from './util.js';

/** Planner runs happen before a run exists, so their usage is parked here and picked up when one starts. */
export const plannerUsagePath = (root: string) => path.join(root, DIR, 'runs', 'planner-usage.json');

export function readPlannerUsage(root: string): Usage {
  try {
    return JSON.parse(readFileSync(plannerUsagePath(root), 'utf8'));
  } catch {
    return { calls: 0, turns: 0, costUsd: 0, durationMs: 0 };
  }
}

function addPlannerUsage(root: string, res: AgentResult<unknown>, reset = false): void {
  const u = reset ? { calls: 0, turns: 0, costUsd: 0, durationMs: 0 } : readPlannerUsage(root);
  u.calls += 1;
  u.turns += res.turns;
  u.costUsd += res.costUsd;
  u.durationMs += res.durationMs;
  mkdirSync(path.dirname(plannerUsagePath(root)), { recursive: true });
  writeFileSync(plannerUsagePath(root), JSON.stringify(u));
}

interface DraftContract {
  goal: string;
  out_of_scope?: string[];
  criteria: { id: string; text: string; proof_type: 'command' | 'review'; proof: string }[];
}

/** Turn a goal in plain words into a draft contract. A person approves it before anything is built. */
export async function draftContract(ctx: Ctx, goal: string): Promise<Contract> {
  const res = await ctx.engine.run<DraftContract>({
    role: 'planner',
    label: 'contract',
    cwd: ctx.root,
    prompt: contractPrompt(goal, repoNames(ctx)),
    schema: CONTRACT_SCHEMA,
    write: false,
    signal: ctx.signal,
  });
  addPlannerUsage(ctx.root, res, true);
  const draft: Contract = {
    goal: res.output.goal,
    outOfScope: res.output.out_of_scope ?? [],
    // Ids are assigned here, in order, whatever the planner called them.
    criteria: res.output.criteria.map((c, i) => ({
      id: `C${i + 1}`,
      text: c.text,
      proof: c.proof_type === 'command' ? { type: 'command', run: c.proof } : { type: 'review', check: c.proof },
    })),
  };
  // Round-trip through the file format so a draft is held to the same rules as a hand-written contract.
  const contract = parseContract(serializeContract(draft));
  saveContract(ctx.root, contract);
  return contract;
}

/** Break the approved contract into tasks. The validator, not the planner, decides whether the plan is acceptable. */
export async function draftPlan(ctx: Ctx): Promise<Plan> {
  const { contract, hash } = loadApprovedContract(ctx.root);
  const repos = repoNames(ctx);
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ctx.engine.run<{ tasks: Task[] }>({
      role: 'planner',
      label: 'plan',
      cwd: ctx.root,
      prompt: planPrompt(contract, problems, repos),
      schema: planSchema(repos),
      write: false,
      signal: ctx.signal,
    });
    addPlannerUsage(ctx.root, res);
    const plan: Plan = {
      contractHash: hash,
      // Models are a person's choice, made in the plan afterwards; the planner does not pick them.
      tasks: res.output.tasks.map((t) => ({
        id: String(t.id).trim(),
        title: String(t.title).trim(),
        brief: String(t.brief).trim(),
        covers: t.covers ?? [],
        needs: t.needs ?? [],
        ...(repos.length && t.repo ? { repo: String(t.repo).trim() } : {}),
      })),
    };
    problems = planProblems(plan, contract, hash, repos);
    if (problems.length === 0) {
      savePlan(ctx.root, plan);
      return plan;
    }
    ctx.log(`the planner's plan does not match the contract (${problems.length} problems): asking again`);
  }
  throw new ValidationError('plan', problems);
}
