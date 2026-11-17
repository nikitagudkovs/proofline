import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashContract, parseContract } from '../src/contract.js';
import { parsePlan, planProblems, waves } from '../src/plan.js';

const contract = parseContract(`
goal: g
criteria:
  - { id: C1, text: one, proof: { command: "true" } }
  - { id: C2, text: two, proof: { command: "true" } }
  - { id: C3, text: three, proof: { review: "is it?" } }
`);
const hash = hashContract(contract);

const plan = (tasks: string) => parsePlan(`contract_hash: ${hash}\ntasks:\n${tasks}`);

test('a plan that matches the contract has no problems and orders into waves', () => {
  const p = plan(`
  - { id: T1, title: a, brief: do a, covers: [C1], needs: [] }
  - { id: T2, title: b, brief: do b, covers: [C2], needs: [] }
  - { id: T3, title: c, brief: do c, covers: [C3], needs: [T1, T2] }
`);
  assert.deepEqual(planProblems(p, contract, hash), []);
  assert.deepEqual(
    waves(p).map((w) => w.map((t) => t.id)),
    [['T1', 'T2'], ['T3']],
  );
});

test('a criterion nobody is responsible for is a plan error', () => {
  const p = plan(`
  - { id: T1, title: a, brief: do a, covers: [C1, C2], needs: [] }
`);
  assert.deepEqual(planProblems(p, contract, hash), ['C3 is not covered by any task']);
});

test('work outside the contract is a plan error', () => {
  const p = plan(`
  - { id: T1, title: a, brief: do a, covers: [C1, C2, C3], needs: [] }
  - { id: T2, title: extra, brief: nice to have, covers: [], needs: [] }
  - { id: T3, title: invented, brief: x, covers: [C9], needs: [] }
`);
  const problems = planProblems(p, contract, hash).join('\n');
  assert.match(problems, /T2: covers no criterion and nothing needs it/);
  assert.match(problems, /T3: covers C9, which is not in the contract/);
});

test('an enabling task is fine when another task needs it', () => {
  const p = plan(`
  - { id: T1, title: scaffold, brief: set up, covers: [], needs: [] }
  - { id: T2, title: all, brief: build, covers: [C1, C2, C3], needs: [T1] }
`);
  assert.deepEqual(planProblems(p, contract, hash), []);
});

test('cycles and unknown dependencies are caught', () => {
  const cycle = plan(`
  - { id: T1, title: a, brief: a, covers: [C1, C2], needs: [T2] }
  - { id: T2, title: b, brief: b, covers: [C3], needs: [T1] }
`);
  assert.deepEqual(planProblems(cycle, contract, hash), ['the task dependencies form a cycle']);

  const unknown = plan(`
  - { id: T1, title: a, brief: a, covers: [C1, C2, C3], needs: [T7] }
`);
  assert.match(planProblems(unknown, contract, hash).join('\n'), /T1: needs T7, which is not a task/);
});

test('a plan made for another version of the contract is rejected', () => {
  const p = plan(`
  - { id: T1, title: a, brief: a, covers: [C1, C2, C3], needs: [] }
`);
  assert.match(planProblems(p, contract, 'different').join('\n'), /different version of the contract/);
});
