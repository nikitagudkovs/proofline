# Example: one delivery across two repositories

The files here come from one real proofline run in a workspace of two small repositories, `api` and `web`, using Claude Code on a subscription. The goal was one sentence: a greeting route in the API and the client helpers that call it, both with tests.

- [`contract.yaml`](contract.yaml): drafted by the planner. Seven command proofs, each starting with `cd api` or `cd web`, and one review proof about the seam between the two (C8).
- [`plan.yaml`](plan.yaml): drafted by the planner. One task per repository; the web task needs the API task.
- [`report.md`](report.md) and [`report.html`](report.html): what the run produced.

## What happened

1. **Baseline.** Six command proofs failed on the untouched code, as they should. C7 ("the existing tests still pass") already passed and is reported as a guard.
2. **Build, wave 1.** T1 added the route and its tests in `api`, and was merged there.
3. **Build, wave 2.** T2 started in `web` only after that merge. Before writing the client it read the merged `api/src/routes.js`, so it built against the route that exists.
4. **Verify.** All eight criteria were checked in a copy with both repositories merged, side by side. For C8 an independent reviewer read both sides and cited the lines where the method, path, query parameter and answer field match.

The run took 39 seconds: two builder runs and one reviewer run. Each repository ended with its half on a branch of the same name, ready for one pull request each.
