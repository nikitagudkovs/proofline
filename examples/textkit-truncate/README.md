# Example: a real run

The files here come from one real proofline run against a tiny JavaScript library (`capitalize()` plus one test), using Claude Code on a subscription.

- [`contract.yaml`](contract.yaml): written by hand. Two command proofs, two review proofs.
- [`plan.yaml`](plan.yaml): written by hand. Two tasks with no dependency, so they ran in parallel.
- [`report.md`](report.md) and [`report.html`](report.html): what the run produced.

## What happened

1. **Baseline.** Both command proofs failed on the untouched code, as they should.
2. **Build.** T1 wrote `truncate` and its tests. At the same time T2 wrote the README entry. Both reported "done".
3. **Verify, round 1.** C1 to C3 passed. C4 failed: the README said `truncate("Hello, world!", 8)` returns `"Hello..."`, and the verifier, reading the code, found it returns `"Hello, …"`.
4. **Fix.** A builder received C4 and the verifier's evidence, and corrected the README. It left the code alone.
5. **Verify, round 2.** All four criteria were checked again and passed.

The whole run took about a minute: 3 builder runs and 4 verifier runs.

## What it changed in proofline

T2 got the detail wrong because it was shown only its own criterion, not the one that settles what the ellipsis looks like. Builders are now shown the whole contract, with their own lines marked, so parallel tasks agree on such details up front. The check that caught it stays.
