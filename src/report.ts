import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repoRuns, runDir } from './state.js';
import type { Contract, Criterion, Plan, ProofResult, RunState, TaskState } from './types.js';
import { fmtDuration } from './util.js';
import { shortHead } from './verify.js';

interface Row {
  criterion: Criterion;
  result?: ProofResult;
  tasks: TaskState[];
  commits: string[];
}

/** The traceability matrix: requirement → who built it → which commits → what proves it. */
function rows(state: RunState, contract: Contract): Row[] {
  const last = state.rounds[state.rounds.length - 1];
  return contract.criteria.map((criterion) => {
    const tasks = Object.values(state.tasks).filter((t) => t.covers.includes(criterion.id));
    return {
      criterion,
      result: last?.results.find((r) => r.criterion === criterion.id),
      tasks,
      commits: tasks.filter((t) => t.status === 'merged').flatMap((t) => t.commits.map((c) => c.slice(0, 7))),
    };
  });
}

/** Failures from earlier rounds: what verification caught before the run ended. */
function caught(state: RunState): { round: number; result: ProofResult }[] {
  return state.rounds
    .slice(0, -1)
    .flatMap((round) => round.results.filter((r) => r.verdict === 'fail').map((result) => ({ round: round.n, result })));
}

function headline(state: RunState, contract: Contract): string {
  const last = state.rounds[state.rounds.length - 1];
  const passed = last ? last.results.filter((r) => r.verdict === 'pass').length : 0;
  const total = contract.criteria.length;
  if (!last) return `Not verified yet: 0 of ${total} criteria proven`;
  return passed === total ? `Proven: ${passed} of ${total} criteria` : `Not proven: ${passed} of ${total} criteria`;
}

function elapsed(state: RunState): string {
  const end = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();
  return fmtDuration(end - Date.parse(state.startedAt));
}

/** What the proof said on the base commit. "failed" is the good answer: the proof can tell done from not done. */
function before(state: RunState, c: Criterion): string {
  if (c.proof.type !== 'command') return 'n/a';
  const v = state.baseline?.[c.id];
  return v === 'fail' ? 'failed, as expected' : v === 'pass' ? 'already passed (guard)' : 'not run';
}

/** Where the work sits: the branch, and what it was started from, per repository. */
function origin(state: RunState, code: (s: string) => string): string {
  const from = repoRuns(state).map((r) => `${r.name ? `${r.name} ` : ''}off ${code(`${r.baseBranch}@${r.baseSha.slice(0, 7)}`)}`);
  return `branch ${code(state.branch)} ${state.repos ? `in ${from.join(', ')}` : from[0]}`;
}

const pullRequests = (state: RunState) => repoRuns(state).filter((r) => r.prUrl) as { name: string; prUrl: string }[];
const inRepo = (t: TaskState) => (t.repo ? ` [${t.repo}]` : '');

const SEVERITY = { blocker: 'Blocker', should: 'Fix soon', note: 'Note' };

/** What happened to a review after it was written, if anything. */
function reviewNote(state: RunState): string {
  const r = state.review;
  if (!r) return '';
  const last = state.rounds[state.rounds.length - 1];
  if (r.sentBack) return `These findings went back to a builder (${r.sentBack}) and the contract was proven again afterwards. The list shows what was found, not what is left.`;
  if (last && last.head !== r.head) return 'The code changed after this review.';
  return '';
}

const proofLabel = (c: Criterion) => (c.proof.type === 'command' ? `command \`${c.proof.run}\`` : 'independent review');
const mark = (r?: ProofResult) => (!r ? '➖' : r.verdict === 'pass' ? '✅' : '❌');
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(state: RunState, contract: Contract, plan: Plan): string {
  const out: string[] = [];
  out.push(`# Proofline report: run ${state.id}`, '');
  out.push(`**${headline(state, contract)}** · ${origin(state, (c) => `\`${c}\``)} · ${elapsed(state)}`, '');
  out.push(`> ${contract.goal}`, '');
  if (state.repos) {
    out.push(`This delivery spans ${state.repos.length} repositories (${state.repos.map((r) => r.name).join(', ')}). They were verified together, each with all of its work merged.`, '');
  }
  for (const pr of pullRequests(state)) out.push(`- Pull request${pr.name ? ` for ${pr.name}` : ''}: ${pr.prUrl}`);
  if (pullRequests(state).length) out.push('');

  out.push('## Contract → result', '');
  out.push('| | Criterion | Proof | Before the work | Built by | Commits |', '|---|---|---|---|---|---|');
  for (const r of rows(state, contract)) {
    out.push(
      `| ${mark(r.result)} | **${r.criterion.id}** ${cell(r.criterion.text)} | ${cell(proofLabel(r.criterion))} | ${before(state, r.criterion)} | ${r.tasks.map((t) => t.id).join(', ') || 'nobody'} | ${r.commits.map((c) => `\`${c}\``).join(' ') || 'none'} |`,
    );
  }

  out.push('', '## Evidence', '');
  for (const r of rows(state, contract)) {
    out.push(`**${r.criterion.id}** ${mark(r.result)} ${r.criterion.text}`, '');
    out.push('```', r.result?.evidence ?? 'not verified', '```', '');
  }

  const sentBack = caught(state);
  if (sentBack.length) {
    out.push('## Caught by verification and sent back', '');
    for (const c of sentBack) out.push(`**${c.result.criterion}**, round ${c.round}:`, '', '```', c.result.evidence, '```', '');
  }

  out.push('## Tasks', '');
  out.push('| Task | Status | Attempts | Commits | Builder\'s summary (not proof) |', '|---|---|---|---|---|');
  const planned = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const t of Object.values(state.tasks)) {
    const needs = planned.get(t.id)?.needs ?? [];
    out.push(
      `| **${t.id}**${inRepo(t)} ${cell(t.title)}${needs.length ? ` (after ${needs.join(', ')})` : ''} | ${t.status} | ${t.attempts} | ${t.commits.length} | ${cell(t.error ?? t.summary ?? '')} |`,
    );
  }

  if (state.review) {
    const r = state.review;
    out.push('', '## Review of the whole change', '');
    out.push(`**${r.verdict === 'approve' ? 'No blockers' : 'Changes needed'}** at \`${shortHead(r.head)}\`. ${r.summary}`, '');
    if (reviewNote(state)) out.push(`_${reviewNote(state)}_`, '');
    for (const f of r.findings) out.push(`- **${SEVERITY[f.severity]}** \`${f.where}\`: ${f.what} ${f.why}`);
    if (r.findings.length === 0) out.push('_The reviewer found nothing a person needs to look at before merging._');
    out.push('', '_One independent read beyond the contract. It informs the person who merges; it is not a proof._');
  }

  const concerns = Object.values(state.tasks).flatMap((t) => (t.concerns ?? []).map((c) => `- **${t.id}**: ${c}`));
  if (concerns.length) {
    out.push('', '## Concerns about the contract, raised by builders', '', ...concerns);
  }

  if (state.rounds.length > 1) {
    out.push('', '## Verification rounds', '');
    for (const round of state.rounds) {
      const failed = round.results.filter((r) => r.verdict === 'fail').map((r) => r.criterion);
      out.push(
        `- Round ${round.n} at \`${shortHead(round.head)}\`: ${round.results.length - failed.length} of ${round.results.length} proven${failed.length ? `, sent back: ${failed.join(', ')}` : ''}`,
      );
    }
  }

  out.push('', '## Agent usage', '');
  out.push('| Role | Runs | Turns | Agent time | List-price equivalent |', '|---|---|---|---|---|');
  for (const role of ['planner', 'builder', 'verifier'] as const) {
    const u = state.usage[role];
    out.push(`| ${role} | ${u.calls} | ${u.turns} | ${fmtDuration(u.durationMs)} | $${u.costUsd.toFixed(2)} |`);
  }
  out.push('', '_Command proofs were run by the harness. Review proofs came from a read-only agent that never saw the builders\' output._', '');
  return out.join('\n');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderHtml(state: RunState, contract: Contract, plan: Plan): string {
  const all = rows(state, contract);
  const proven = state.status === 'proven';
  const body = all
    .map((r) => {
      const v = r.result?.verdict ?? 'none';
      const proof =
        r.criterion.proof.type === 'command'
          ? `<code>${esc(r.criterion.proof.run)}</code>`
          : `<span class="muted">review:</span> ${esc(r.criterion.proof.check)}`;
      return `<tr class="${v}">
  <td class="verdict"><span class="pill ${v}">${v === 'none' ? 'unverified' : v}</span></td>
  <td><div class="cid">${r.criterion.id}</div>${esc(r.criterion.text)}<div class="proof">${proof}</div></td>
  <td class="muted">${before(state, r.criterion)}</td>
  <td>${r.tasks.map((t) => `<span class="tag">${t.id}</span>`).join(' ') || '<span class="muted">nobody</span>'}</td>
  <td>${r.commits.map((c) => `<code>${c}</code>`).join(' ') || '<span class="muted">none</span>'}</td>
  <td><pre>${esc(r.result?.evidence ?? 'not verified')}</pre></td>
</tr>`;
    })
    .join('\n');

  const planned = new Map(plan.tasks.map((t) => [t.id, t]));
  const tasks = Object.values(state.tasks)
    .map((t) => {
      const needs = planned.get(t.id)?.needs ?? [];
      return `<tr><td><span class="tag">${t.id}</span>${t.repo ? ` <span class="muted">${esc(t.repo)}</span>` : ''} ${esc(t.title)}${needs.length ? ` <span class="muted">after ${needs.join(', ')}</span>` : ''}</td><td>${t.status}</td><td>${t.attempts}</td><td>${t.commits.length}</td><td>${esc(t.error ?? t.summary ?? '')}</td></tr>`;
    })
    .join('\n');

  const concernItems = Object.values(state.tasks).flatMap((t) =>
    (t.concerns ?? []).map((c) => `<li><span class="tag">${t.id}</span> ${esc(c)}</li>`),
  );
  const concerns = concernItems.length
    ? `\n  <h2>Concerns about the contract, raised by builders</h2>\n  <ul>${concernItems.join('')}</ul>\n`
    : '';

  const review = state.review
    ? `\n  <h2>Review of the whole change</h2>\n  <p class="goal"><span class="pill ${state.review.verdict === 'approve' ? 'pass' : 'fail'}">${state.review.verdict === 'approve' ? 'no blockers' : 'changes needed'}</span> ${esc(state.review.summary)}</p>${reviewNote(state) ? `\n  <p class="muted">${esc(reviewNote(state))}</p>` : ''}\n  <ul class="caught">${state.review.findings
        .map((f) => `<li><span class="pill ${f.severity === 'blocker' ? 'fail' : 'none'}">${SEVERITY[f.severity]}</span> <code>${esc(f.where)}</code><pre>${esc(`${f.what} ${f.why}`)}</pre></li>`)
        .join('')}</ul>\n  <p class="muted">One independent read beyond the contract. It informs the person who merges; it is not a proof.</p>\n`
    : '';

  const caughtItems = caught(state).map(
    (c) => `<li><span class="pill fail">${c.result.criterion} · round ${c.round}</span><pre>${esc(c.result.evidence)}</pre></li>`,
  );
  const sentBack = caughtItems.length
    ? `\n  <h2>Caught by verification and sent back</h2>\n  <ul class="caught">${caughtItems.join('')}</ul>\n`
    : '';

  const rounds = state.rounds
    .map((round) => {
      const ok = round.results.filter((r) => r.verdict === 'pass').length;
      return `<span class="round">round ${round.n}: ${ok}/${round.results.length}</span>`;
    })
    .join(' → ');

  const usage = (['planner', 'builder', 'verifier'] as const)
    .map((role) => {
      const u = state.usage[role];
      return `<tr><td>${role}</td><td>${u.calls}</td><td>${u.turns}</td><td>${fmtDuration(u.durationMs)}</td><td>$${u.costUsd.toFixed(2)}</td></tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proofline report ${esc(state.id)}</title>
<style>
  :root { --bg:#fbfaf7; --fg:#1c1b19; --muted:#6f6b63; --line:#e4e0d6; --card:#fff; --pass:#17694a; --pass-bg:#e3f3ea; --fail:#a3271f; --fail-bg:#fbe6e3; --none:#6f6b63; --none-bg:#eeebe3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151412; --fg:#ece9e1; --muted:#9a958a; --line:#2e2c27; --card:#1d1c19; --pass:#6fd3a5; --pass-bg:#16332a; --fail:#f09088; --fail-bg:#3b1b18; --none:#9a958a; --none-bg:#2a2823; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 16px 64px; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1100px; margin:0 auto; }
  h1 { font-size:14px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:0 0 8px; }
  .headline { font-size:34px; font-weight:700; letter-spacing:-.02em; margin:0 0 6px; color:var(${proven ? '--pass' : '--fail'}); }
  .goal { font-size:18px; margin:0 0 14px; max-width:70ch; }
  .meta { color:var(--muted); font-size:13px; margin:0 0 28px; }
  h2 { font-size:13px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:36px 0 10px; }
  .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--card); }
  table { border-collapse:collapse; width:100%; min-width:720px; }
  th, td { text-align:left; vertical-align:top; padding:12px 14px; border-bottom:1px solid var(--line); }
  th { font-size:12px; font-weight:600; color:var(--muted); }
  tr:last-child td { border-bottom:0; }
  code, pre { font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; color:var(--muted); }
  table.matrix { table-layout:fixed; min-width:900px; }
  table.matrix th:nth-child(1) { width:84px; } table.matrix th:nth-child(3) { width:120px; }
  table.matrix th:nth-child(4) { width:84px; } table.matrix th:nth-child(5) { width:96px; }
  table.matrix th:nth-child(6) { width:30%; }
  .proof code { word-break:break-word; }
  .cid { font-weight:700; font-size:12px; color:var(--muted); }
  .proof { margin-top:6px; font-size:13px; color:var(--muted); }
  .muted { color:var(--muted); }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
  .pill.pass { color:var(--pass); background:var(--pass-bg); }
  .pill.fail { color:var(--fail); background:var(--fail-bg); }
  .pill.none { color:var(--none); background:var(--none-bg); }
  a { color:inherit; }
  .tag { display:inline-block; padding:1px 7px; border:1px solid var(--line); border-radius:6px; font-size:12px; font-weight:600; }
  ul { margin:0; padding:0 0 0 2px; list-style:none; } li { margin:6px 0; }
  .caught li { border:1px solid var(--line); border-radius:10px; background:var(--card); padding:12px 14px; }
  .caught pre { margin-top:8px; }
  footer { margin-top:28px; color:var(--muted); font-size:13px; max-width:80ch; }
</style>
</head>
<body>
<main>
  <h1>Proofline report</h1>
  <p class="headline">${esc(headline(state, contract))}</p>
  <p class="goal">${esc(contract.goal)}</p>
  <p class="meta">run ${esc(state.id)} · ${origin(state, (c) => `<code>${esc(c)}</code>`)} · ${elapsed(state)}${rounds ? ` · ${rounds}` : ''}</p>${
    pullRequests(state).length
      ? `\n  <p class="meta">${pullRequests(state)
          .map((pr) => `<a href="${esc(pr.prUrl)}">Pull request${pr.name ? ` for ${esc(pr.name)}` : ''}</a>`)
          .join(' · ')}</p>`
      : ''
  }

  <h2>Contract → result</h2>
  <div class="scroll"><table class="matrix">
    <thead><tr><th></th><th>Criterion and its proof</th><th>Before the work</th><th>Built by</th><th>Commits</th><th>Evidence</th></tr></thead>
    <tbody>
${body}
    </tbody>
  </table></div>
${sentBack}
  <h2>Tasks</h2>
  <div class="scroll"><table>
    <thead><tr><th>Task</th><th>Status</th><th>Attempts</th><th>Commits</th><th>Builder's summary (not proof)</th></tr></thead>
    <tbody>
${tasks}
    </tbody>
  </table></div>
${concerns}${review}
  <h2>Agent usage</h2>
  <div class="scroll"><table>
    <thead><tr><th>Role</th><th>Runs</th><th>Turns</th><th>Agent time</th><th>List-price equivalent</th></tr></thead>
    <tbody>
${usage}
    </tbody>
  </table></div>

  <footer>Command proofs were run by the harness itself. Review proofs came from a read-only agent that saw the criterion and the code, never the builders' output.</footer>
</main>
</body>
</html>
`;
}

export function writeReport(root: string, state: RunState, contract: Contract, plan: Plan): { md: string; html: string } {
  const dir = runDir(root, state.id);
  mkdirSync(dir, { recursive: true });
  const md = path.join(dir, 'report.md');
  const html = path.join(dir, 'report.html');
  writeFileSync(md, renderMarkdown(state, contract, plan));
  writeFileSync(html, renderHtml(state, contract, plan));
  return { md, html };
}
