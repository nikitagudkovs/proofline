import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DIR } from './contract.js';
import type { Contract, Plan, Task } from './types.js';
import { ValidationError } from './util.js';

export const planPath = (root: string) => path.join(root, DIR, 'plan.yaml');

export function parsePlan(text: string): Plan {
  const raw = YAML.parse(text) ?? {};
  const list: unknown[] = Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks: Task[] = list.map((item) => {
    const t = (item ?? {}) as Record<string, any>;
    return {
      id: String(t.id ?? '').trim(),
      title: String(t.title ?? '').trim(),
      brief: String(t.brief ?? '').trim(),
      covers: Array.isArray(t.covers) ? t.covers.map(String) : [],
      needs: Array.isArray(t.needs) ? t.needs.map(String) : [],
      ...(typeof t.model === 'string' && t.model.trim() ? { model: t.model.trim() } : {}),
    };
  });
  return { contractHash: String(raw.contract_hash ?? ''), tasks };
}

export function serializePlan(p: Plan): string {
  return YAML.stringify({
    contract_hash: p.contractHash,
    tasks: p.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      covers: t.covers,
      needs: t.needs,
      ...(t.model ? { model: t.model } : {}),
      brief: t.brief,
    })),
  });
}

/**
 * The plan must match the contract in both directions:
 * every criterion has a task responsible for it, and every task exists because of a criterion.
 */
export function planProblems(plan: Plan, contract: Contract, contractHash: string): string[] {
  const problems: string[] = [];
  if (plan.tasks.length === 0) return ['the plan has no tasks'];
  if (plan.contractHash !== contractHash) {
    problems.push('the plan was made for a different version of the contract; run: proofline plan');
  }

  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (!/^T\d+$/.test(t.id)) problems.push(`${t.id || '(task without id)'}: id must look like T1, T2, ...`);
    if (ids.has(t.id)) problems.push(`${t.id}: duplicate id`);
    ids.add(t.id);
    if (!t.title) problems.push(`${t.id}: title is missing`);
    if (!t.brief) problems.push(`${t.id}: brief is missing`);
  }

  const criteria = new Set(contract.criteria.map((c) => c.id));
  const covered = new Set<string>();
  const needed = new Set<string>();
  for (const t of plan.tasks) {
    for (const c of t.covers) {
      if (criteria.has(c)) covered.add(c);
      else problems.push(`${t.id}: covers ${c}, which is not in the contract`);
    }
    for (const n of t.needs) {
      if (n === t.id) problems.push(`${t.id}: needs itself`);
      else if (!ids.has(n)) problems.push(`${t.id}: needs ${n}, which is not a task`);
      else needed.add(n);
    }
  }
  for (const c of contract.criteria) {
    if (!covered.has(c.id)) problems.push(`${c.id} is not covered by any task`);
  }
  for (const t of plan.tasks) {
    if (t.covers.length === 0 && !needed.has(t.id)) {
      problems.push(`${t.id}: covers no criterion and nothing needs it, so it is outside the contract`);
    }
  }

  if (problems.length === 0 && !topoWaves(plan.tasks)) problems.push('the task dependencies form a cycle');
  return problems;
}

export function validatePlan(plan: Plan, contract: Contract, contractHash: string): void {
  const problems = planProblems(plan, contract, contractHash);
  if (problems.length) throw new ValidationError('plan', problems);
}

/** Group tasks into waves: everything in a wave can be built at the same time. Null on a cycle. */
function topoWaves(tasks: Task[]): Task[][] | null {
  const done = new Set<string>();
  let left = [...tasks];
  const result: Task[][] = [];
  while (left.length) {
    const wave = left.filter((t) => t.needs.every((n) => done.has(n)));
    if (wave.length === 0) return null;
    result.push(wave);
    for (const t of wave) done.add(t.id);
    left = left.filter((t) => !done.has(t.id));
  }
  return result;
}

export function waves(plan: Plan): Task[][] {
  const w = topoWaves(plan.tasks);
  if (!w) throw new ValidationError('plan', ['the task dependencies form a cycle']);
  return w;
}

export function loadPlan(root: string): Plan {
  const file = planPath(root);
  if (!existsSync(file)) throw new Error(`No plan at ${path.relative(root, file)}. Create one with: proofline plan`);
  return parsePlan(readFileSync(file, 'utf8'));
}

export function savePlan(root: string, p: Plan): void {
  mkdirSync(path.join(root, DIR), { recursive: true });
  writeFileSync(planPath(root), serializePlan(p));
}

export function renderPlan(plan: Plan): string {
  const lines: string[] = [];
  waves(plan).forEach((wave, i) => {
    lines.push(`Wave ${i + 1}${wave.length > 1 ? ` (${wave.length} in parallel)` : ''}`);
    for (const t of wave) {
      const needs = t.needs.length ? `  after ${t.needs.join(', ')}` : '';
      lines.push(`  ${t.id}  ${t.title}  → ${t.covers.join(', ') || 'enabling'}${needs}`);
    }
  });
  return lines.join('\n');
}
