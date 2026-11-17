import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Contract, Criterion, Proof } from './types.js';
import { ValidationError } from './util.js';

export const DIR = '.proofline';
export const contractPath = (root: string) => path.join(root, DIR, 'contract.yaml');
export const approvalPath = (root: string) => path.join(root, DIR, 'approval.json');

/**
 * Contract file shape (YAML):
 *
 *   goal: Add a --json flag to the export command
 *   out_of_scope: [changing the CSV format]
 *   criteria:
 *     - id: C1
 *       text: `export --json` prints valid JSON
 *       proof: { command: "npm test -- export-json" }
 *     - id: C2
 *       text: The README documents the flag
 *       proof: { review: "Does README.md show --json with an example?" }
 */
export function parseContract(text: string): Contract {
  const raw = YAML.parse(text) ?? {};
  const problems: string[] = [];
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
  if (!goal) problems.push('goal is missing');

  const outOfScope = Array.isArray(raw.out_of_scope) ? raw.out_of_scope.map(String) : [];
  const list: unknown[] = Array.isArray(raw.criteria) ? raw.criteria : [];
  if (list.length === 0) problems.push('criteria is empty: a contract needs at least one checkable line');

  const seen = new Set<string>();
  const criteria: Criterion[] = [];
  list.forEach((item, i) => {
    const c = (item ?? {}) as Record<string, any>;
    const id = String(c.id ?? '').trim();
    const where = id || `criteria[${i}]`;
    if (!/^C\d+$/.test(id)) problems.push(`${where}: id must look like C1, C2, ...`);
    if (seen.has(id)) problems.push(`${where}: duplicate id`);
    seen.add(id);
    const text = String(c.text ?? '').trim();
    if (!text) problems.push(`${where}: text is missing`);
    const proof = parseProof(c.proof, where, problems);
    if (proof) criteria.push({ id, text, proof });
  });

  if (problems.length) throw new ValidationError('contract', problems);
  return { goal, outOfScope, criteria };
}

function parseProof(raw: any, where: string, problems: string[]): Proof | undefined {
  const command = typeof raw?.command === 'string' ? raw.command.trim() : '';
  const review = typeof raw?.review === 'string' ? raw.review.trim() : '';
  if (!!command === !!review) {
    problems.push(`${where}: proof needs exactly one of "command" or "review"`);
    return undefined;
  }
  if (command) {
    const timeoutSec = Number.isFinite(raw.timeout_sec) ? Number(raw.timeout_sec) : undefined;
    return { type: 'command', run: command, ...(timeoutSec ? { timeoutSec } : {}) };
  }
  return { type: 'review', check: review };
}

export function serializeContract(c: Contract): string {
  return YAML.stringify({
    goal: c.goal,
    out_of_scope: c.outOfScope,
    criteria: c.criteria.map((k) => ({
      id: k.id,
      text: k.text,
      proof:
        k.proof.type === 'command'
          ? { command: k.proof.run, ...(k.proof.timeoutSec ? { timeout_sec: k.proof.timeoutSec } : {}) }
          : { review: k.proof.check },
    })),
  });
}

/** Hash of the meaning of the contract, so reformatting the YAML does not void an approval. */
export function hashContract(c: Contract): string {
  const canonical = JSON.stringify({
    goal: c.goal,
    outOfScope: c.outOfScope,
    criteria: c.criteria.map((k) => [k.id, k.text, k.proof]),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Things a human should look at before approving. They do not block. */
export function lintContract(c: Contract): string[] {
  const warnings: string[] = [];
  const reviews = c.criteria.filter((k) => k.proof.type === 'review').length;
  if (reviews > c.criteria.length / 2) {
    warnings.push(
      `${reviews} of ${c.criteria.length} criteria are proven by review only. A command proof is stronger: it cannot be talked into passing.`,
    );
  }
  const byCommand = new Map<string, string[]>();
  for (const k of c.criteria) {
    if (k.proof.type !== 'command') continue;
    byCommand.set(k.proof.run, [...(byCommand.get(k.proof.run) ?? []), k.id]);
  }
  for (const [run, ids] of byCommand) {
    if (ids.length > 1) {
      warnings.push(`${ids.join(', ')} share the proof \`${run}\`: one command can hardly prove ${ids.length} different things.`);
    }
  }
  for (const k of c.criteria) {
    if (/\b(properly|correctly|as expected|works well|user[- ]friendly|robust|clean)\b/i.test(k.text)) {
      warnings.push(`${k.id} uses a word no proof can check ("${k.text}"). Say what is observable.`);
    }
  }
  return warnings;
}

export function loadContract(root: string): Contract {
  const file = contractPath(root);
  if (!existsSync(file)) {
    throw new Error(`No contract at ${path.relative(root, file)}. Draft one with: proofline contract "<goal>"`);
  }
  return parseContract(readFileSync(file, 'utf8'));
}

export function saveContract(root: string, c: Contract): void {
  mkdirSync(path.join(root, DIR), { recursive: true });
  writeFileSync(contractPath(root), serializeContract(c));
  // A rewritten contract is a new contract: any earlier approval no longer applies.
  rmSync(approvalPath(root), { force: true });
}

export function approveContract(root: string): string {
  const hash = hashContract(loadContract(root));
  writeFileSync(approvalPath(root), JSON.stringify({ hash, approvedAt: new Date().toISOString() }, null, 2) + '\n');
  return hash;
}

/** Returns the contract only if the approval on disk matches it exactly as it now stands. */
export function loadApprovedContract(root: string): { contract: Contract; hash: string } {
  const contract = loadContract(root);
  const hash = hashContract(contract);
  let approved = '';
  try {
    approved = JSON.parse(readFileSync(approvalPath(root), 'utf8')).hash;
  } catch {
    // no approval file
  }
  if (!approved) throw new Error('The contract is not approved yet. Read it, then run: proofline approve');
  if (approved !== hash) {
    throw new Error('The contract changed after it was approved. Review the change, then run: proofline approve');
  }
  return { contract, hash };
}

export function renderContract(c: Contract): string {
  const lines = [`Goal: ${c.goal}`, ''];
  for (const k of c.criteria) {
    lines.push(`  ${k.id}  ${k.text}`);
    lines.push(
      k.proof.type === 'command' ? `      proof (command): ${k.proof.run}` : `      proof (review):  ${k.proof.check}`,
    );
  }
  if (c.outOfScope.length) {
    lines.push('', 'Out of scope:');
    for (const o of c.outOfScope) lines.push(`  - ${o}`);
  }
  return lines.join('\n');
}
