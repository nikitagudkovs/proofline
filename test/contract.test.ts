import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DIR,
  approveContract,
  contractPath,
  hashContract,
  lintContract,
  loadApprovedContract,
  parseContract,
  serializeContract,
} from '../src/contract.js';
import { ValidationError } from '../src/util.js';

const GOOD = `
goal: Add a --json flag
out_of_scope: [changing the CSV output]
criteria:
  - id: C1
    text: export --json prints valid JSON
    proof: { command: "npm test -- export-json" }
  - id: C2
    text: The README shows the flag
    proof: { review: "Does README.md show --json with an example?" }
`;

test('a contract parses into criteria with one proof each', () => {
  const c = parseContract(GOOD);
  assert.equal(c.criteria.length, 2);
  assert.deepEqual(c.criteria[0].proof, { type: 'command', run: 'npm test -- export-json' });
  assert.deepEqual(c.criteria[1].proof, { type: 'review', check: 'Does README.md show --json with an example?' });
  assert.deepEqual(c.outOfScope, ['changing the CSV output']);
});

test('every problem in a bad contract is reported at once', () => {
  const bad = `
criteria:
  - id: one
    text: ""
    proof: { command: "true", review: "also this" }
  - id: C2
    text: no proof at all
`;
  assert.throws(
    () => parseContract(bad),
    (e: unknown) => {
      assert.ok(e instanceof ValidationError);
      const all = e.problems.join('\n');
      assert.match(all, /goal is missing/);
      assert.match(all, /id must look like C1/);
      assert.match(all, /text is missing/);
      assert.match(all, /one: proof needs exactly one/);
      assert.match(all, /C2: proof needs exactly one/);
      return true;
    },
  );
});

test('the hash follows the meaning, not the formatting', () => {
  const a = parseContract(GOOD);
  const reformatted = parseContract(serializeContract(a));
  assert.equal(hashContract(a), hashContract(reformatted));

  const changed = parseContract(GOOD.replace('prints valid JSON', 'prints valid YAML'));
  assert.notEqual(hashContract(a), hashContract(changed));
});

test('editing a contract after approval voids the approval', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'proofline-contract-'));
  mkdirSync(path.join(root, DIR));
  writeFileSync(contractPath(root), GOOD);

  assert.throws(() => loadApprovedContract(root), /not approved yet/);
  approveContract(root);
  assert.equal(loadApprovedContract(root).contract.criteria.length, 2);

  writeFileSync(contractPath(root), readFileSync(contractPath(root), 'utf8').replace('npm test -- export-json', 'true'));
  assert.throws(() => loadApprovedContract(root), /changed after it was approved/);
});

test('lint points at proofs a person should question', () => {
  const c = parseContract(`
goal: g
criteria:
  - { id: C1, text: It works properly, proof: { command: "npm test" } }
  - { id: C2, text: Errors are shown, proof: { command: "npm test" } }
  - { id: C3, text: Docs exist, proof: { review: "Are there docs?" } }
`);
  const warnings = lintContract(c).join('\n');
  assert.match(warnings, /C1, C2 share the proof/);
  assert.match(warnings, /C1 uses a word no proof can check/);
});
