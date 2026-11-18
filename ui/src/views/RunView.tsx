import { api, now } from '../api';
import type { Shell } from '../App';
import type { Criterion, GateResult, ProofResult, RunView, SessionMeta, Task, TaskState } from '../types';
import { Empty, Pill, Section, Tag, fmtClock, fmtCost, fmtDuration, fmtRunId } from '../ui';
import { toWaves } from './PlanView';

const latest = (run: RunView, label: string): SessionMeta | undefined => run.sessions.filter((s) => s.label === label).pop();

export function RunScreen({ shell, runId }: { shell: Shell; runId?: string }) {
  const { ov, run, act, readOnly } = shell;
  const canStart = ov.contract.approved && ov.plan.exists && ov.plan.problems.length === 0 && !shell.busy;

  if (!run || !runId) {
    return (
      <Empty title="No runs yet">
        {canStart ? (
          <button className="btn btn-primary" onClick={() => act(() => api.startRun())}>
            Start the first run
          </button>
        ) : (
          <>
            A run needs an approved contract and a plan that matches it.{' '}
            <button className="link" onClick={() => shell.go(ov.contract.approved ? 'plan' : 'contract')}>
              {ov.contract.approved ? 'Open the plan' : 'Open the contract'}
            </button>
          </>
        )}
      </Empty>
    );
  }

  const { state } = run;
  const working = ov.job?.runId === state.id && (ov.job.kind === 'run' || ov.job.kind === 'verify');
  const contract = ov.contract.contract;
  // An older run is shown with the contract it was made for, from the copy it keeps.
  const criteria: Criterion[] = run.current && contract ? contract.criteria : (run.contract?.criteria ?? []);
  const last = state.rounds[state.rounds.length - 1];
  // The gates of the settings as they are now, or, for an older run, the ones that run met.
  const met = [...(last?.gates ?? []), ...(state.gateProgress ?? [])];
  const gates = [...new Map([...(run.current ? (ov.gates ?? []) : []).map((g) => [g.name, g.run] as const), ...met.map((g) => [g.gate, g.run] as const)])];
  // While a round is being verified, count the verdicts that are already in.
  const passed = (state.progress ?? last?.results ?? []).filter((r) => r.verdict === 'pass').length;
  const total = criteria.length || last?.results.length || 0;
  const end = state.finishedAt ? Date.parse(state.finishedAt) : shell.busy ? now() : Date.parse(run.log[run.log.length - 1]?.t ?? state.startedAt);
  const elapsed = Math.max(0, end - Date.parse(state.startedAt));

  // What is left to do with a finished run: merge it, run the team's own last steps, tidy up.
  const stage = run.stage ?? { proven: state.status === 'proven', shipped: !!state.prUrl, merged: false };
  const reachedStage = { proven: stage.proven, shipped: stage.shipped, merged: stage.merged };
  const bases = [...new Set((state.repos ?? [{ baseBranch: state.baseBranch }]).map((r) => r.baseBranch))].join(' and ');
  const actions = (ov.config.actions ?? []).filter((a) => reachedStage[a.needs]);
  const ranOk = (name: string) => [...(state.actions ?? [])].reverse().find((a) => a.name === name)?.ok;
  const idle = !shell.busy && !readOnly;

  // The review of the whole change: one more pair of eyes, asked for by a person.
  const review = state.review;
  const reviewing = ov.job?.runId === state.id && ov.job.kind === 'review';
  const reviewer = latest(run, 'REVIEW');
  const blockers = review?.findings.filter((f) => f.severity === 'blocker').length ?? 0;
  const fixable = review?.findings.filter((f) => f.severity !== 'note').length ?? 0;
  const lastHead = state.rounds[state.rounds.length - 1]?.head;
  const reviewStale = !!review && !review.sentBack && !!lastHead && lastHead !== review.head;
  const canReview = idle && run.current && !state.cleaned && state.rounds.length > 0;

  const planned = run.current ? (ov.plan.plan?.tasks ?? []) : [];
  const known = new Set(planned.map((t) => t.id));
  const waves: Task[][] = planned.length ? toWaves(planned.filter((t) => state.tasks[t.id])) : [];
  const fixes = Object.values(state.tasks).filter((t) => !known.has(t.id));

  return (
    <div className="stack">
      <div className="runbar">
        <div className="runbar-main">
          <select id="run-picker" className="select" aria-label="Run" value={state.id} onChange={(e) => shell.selectRun(e.target.value)}>
            {!ov.runs.some((r) => r.id === state.id) && <option value={state.id}>{fmtRunId(state.id)} · not in this project</option>}
            {ov.runs.map((r) => (
              <option key={r.id} value={r.id}>
                {fmtRunId(r.id)} · {r.status === 'unproven' ? 'not proven' : r.status}
                {r.total ? ` ${r.proven}/${r.total}` : ''}
              </option>
            ))}
          </select>
          <Pill status={state.status} />
          <span className="runbar-score">
            <strong>{passed}</strong> of {total} proven
          </span>
          <span className="muted mono">{fmtDuration(elapsed)}</span>
          <span className="muted mono clip" title={state.repos ? state.repos.map((r) => `${r.name}: off ${r.baseBranch}`).join(', ') : `off ${state.baseBranch}`}>
            {state.branch}
            {state.repos ? ` in ${state.repos.map((r) => r.name).join(' + ')}` : ''}
          </span>
        </div>
        {!readOnly && (
          <div className="row">
            {working && (
              <button className="btn" onClick={() => act(api.stopJob)}>
                Stop the run
              </button>
            )}
            {!shell.busy && run.current && !state.cleaned && (state.status === 'stopped' || state.status === 'unproven' || state.status === 'building') && (
              <button className="btn btn-primary" onClick={() => act(() => api.startRun(state.id))}>
                {state.status === 'unproven' ? 'Try again' : 'Resume'}
              </button>
            )}
            {!shell.busy && run.current && !state.cleaned && state.rounds.length > 0 && (
              <button className="btn" onClick={() => act(() => api.verify(state.id))}>
                Check the proofs again
              </button>
            )}
            {state.rounds.length > 0 && (
              <a className="btn" href={api.reportUrl(state.id)} target="_blank" rel="noreferrer">
                Open the report
              </a>
            )}
            {state.prUrl ? (
              (state.repos?.filter((r) => r.prUrl) ?? [{ name: '', prUrl: state.prUrl }]).map((r) => (
                <a key={r.name} className="btn" href={r.prUrl} target="_blank" rel="noreferrer">
                  Pull request{r.name ? ` · ${r.name}` : ''}
                </a>
              ))
            ) : (
              !shell.busy &&
              run.current &&
              !state.cleaned &&
              state.rounds.length > 0 && (
                <button className={`btn${state.status === 'proven' ? ' btn-primary' : ''}`} onClick={() => act(() => api.ship(state.id, state.status !== 'proven'))}>
                  {state.status === 'proven' ? `Open ${state.repos ? 'the pull requests' : 'a pull request'}` : `Open ${state.repos ? 'draft pull requests' : 'a draft pull request'}`}
                </button>
              )
            )}
            {canStart && !working && (
              <button className="btn" onClick={() => act(() => api.startRun())}>
                New run
              </button>
            )}
          </div>
        )}
      </div>

      {(stage.shipped || actions.length > 0 || (idle && state.rounds.length > 0)) && !readOnly && (
        <div className="finish">
          <span className="label">Finish</span>
          {canReview && (
            <button className={`btn${!review && stage.proven ? ' btn-primary' : ''}`} onClick={() => act(() => api.review(state.id))}>
              {review ? 'Review again' : 'Review the change'}
            </button>
          )}
          {stage.shipped && stage.proven && !stage.merged && (
            <button
              className={`btn${review && blockers === 0 ? ' btn-primary' : ''}`}
              disabled={!idle}
              onClick={() =>
                confirm(
                  `${blockers > 0 && !review?.sentBack ? `The review found ${blockers} blocker${blockers === 1 ? '' : 's'} that ${blockers === 1 ? 'was' : 'were'} not sent back. ` : ''}Merge ${state.repos ? 'the pull requests' : 'the pull request'} into ${bases}?`,
                ) && act(() => api.merge(state.id))
              }
            >
              Merge into {bases}
            </button>
          )}
          {stage.merged && <Pill status="merged">merged into {bases}</Pill>}
          {actions.map((a) => (
            <button key={a.name} className="btn" disabled={!idle} title={a.run} onClick={() => (!a.confirm || confirm(a.confirm)) && act(() => api.action(state.id, a.name))}>
              {ranOk(a.name) === true ? '✓ ' : ranOk(a.name) === false ? '✗ ' : ''}
              {a.name}
            </button>
          ))}
          {state.cleaned ? (
            <span className="muted">Cleaned up: the working copies and session records are gone, the report stays.</span>
          ) : (
            <button
              className="btn"
              disabled={!idle}
              onClick={() => confirm("Remove this run's working copies, session records and local branches? The report stays. Work that is not merged and not pushed is kept.") && act(() => api.cleanUp(state.id))}
            >
              Clean up
            </button>
          )}
        </div>
      )}

      {(review || reviewing) && (
        <Section
          title="Review of the whole change"
          aside={<span className="muted">One independent read for what no line of the contract asked about. It informs you; it is not a proof.</span>}
        >
          {reviewing && (
            <button className="review-live" onClick={() => reviewer && shell.openSession(state.id, reviewer.id)}>
              <Pill status="running">reading the change</Pill>
              <span className="mono clip muted">{reviewer?.lastActivity}</span>
            </button>
          )}
          {review && !reviewing && (
            <>
              <div className="review-head">
                <Pill status={review.verdict === 'approve' ? 'pass' : 'fail'}>{review.verdict === 'approve' ? 'no blockers' : `${blockers} blocker${blockers === 1 ? '' : 's'}`}</Pill>
                <span>{review.summary}</span>
              </div>
              {review.sentBack && (
                <div className="notice">
                  These findings went back to a builder ({review.sentBack}) and the contract was checked again. Review again to see what is left.
                </div>
              )}
              {reviewStale && <div className="notice notice-warn">The code changed after this review. Review again before relying on it.</div>}
              <ol className="findings">
                {review.findings.map((f, i) => (
                  <li key={i} className="finding">
                    <span className={`sev sev-${f.severity}`}>{f.severity === 'blocker' ? 'Blocker' : f.severity === 'should' ? 'Fix soon' : 'Note'}</span>
                    <span className="finding-body">
                      <span className="mono finding-where">{f.where}</span>
                      <span>{f.what}</span>
                      <span className="muted">{f.why}</span>
                    </span>
                  </li>
                ))}
              </ol>
              {review.findings.length === 0 && <p className="muted">Nothing a person needs to look at before merging.</p>}
              <div className="row">
                {fixable > 0 && !review.sentBack && !stage.merged && canReview && (
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      confirm(`Send ${fixable} finding${fixable === 1 ? '' : 's'} back to a builder? The contract is checked again afterwards${stage.shipped ? ' and the pull request is updated' : ''}.`) &&
                      act(() => api.fixReview(state.id, true))
                    }
                  >
                    Send {fixable === 1 ? 'the finding' : `the ${fixable} findings`} back to a builder
                  </button>
                )}
                {reviewer && (
                  <button className="btn" onClick={() => shell.openSession(state.id, reviewer.id)}>
                    Open the reviewer's session
                  </button>
                )}
              </div>
            </>
          )}
        </Section>
      )}

      {!run.current && <div className="notice notice-warn">The contract has changed since this run. It is shown as a record; start a new run for the new contract.</div>}

      <div className="split">
        <Section title="Building blocks" aside={<span className="muted">Each task is built by its own agent, in its own copy of {state.repos ? 'its repository' : 'the repository'}.</span>}>
          {waves.map((wave, i) => (
            <div key={i} className="wave wave-run">
              <div className="wave-head">
                <span className="label">Wave {i + 1}</span>
                <span className="muted">{wave.length > 1 ? `${wave.length} in parallel` : ''}</span>
              </div>
              {wave.map((t) => (
                <TaskCard key={t.id} task={state.tasks[t.id]} needs={t.needs} run={run} shell={shell} />
              ))}
            </div>
          ))}
          {waves.length === 0 &&
            Object.values(state.tasks)
              .filter((t) => known.has(t.id) || planned.length === 0)
              .map((t) => <TaskCard key={t.id} task={t} needs={[]} run={run} shell={shell} />)}
          {planned.length > 0 && fixes.length > 0 && (
            <div className="wave wave-run">
              <div className="wave-head">
                <span className="label">Sent back after verification</span>
              </div>
              {fixes.map((t) => (
                <TaskCard key={t.id} task={t} needs={[]} run={run} shell={shell} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Contract check"
          aside={<span className="muted">{state.repos ? 'Checked with every repository merged, side by side. A line counts only when its proof passes.' : 'A line counts only when its proof passes.'}</span>}
        >
          <ol className="checks">
            {criteria.map((c) => (
              <Check key={c.id} criterion={c} run={run} shell={shell} />
            ))}
            {criteria.length === 0 &&
              last?.results.map((r) => (
                <li key={r.criterion} className="check">
                  <Pill status={r.verdict} />
                  <span className="mono">{r.criterion}</span>
                </li>
              ))}
          </ol>
          {gates.length > 0 && (
            <>
              <p className="gates-head muted">
                <span className="label">Gates</span> Your own commands from the settings. Every delivery has to pass them, whatever its contract says.
              </p>
              <ol className="checks">
                {gates.map(([name, command]) => (
                  <GateRow key={name} name={name} command={command} run={run} />
                ))}
              </ol>
            </>
          )}
        </Section>
      </div>

      <div className="split">
        <Section title="Activity">
          <ol className="log mono">
            {run.log
              .slice(-80)
              .reverse()
              .map((l, i) => (
                <li key={`${l.t}-${i}`}>
                  <time className="muted">{fmtClock(l.t)}</time>
                  <span>{l.msg}</span>
                </li>
              ))}
            {run.log.length === 0 && <li className="muted">Nothing yet.</li>}
          </ol>
        </Section>

        <Section title="Agent usage" aside={<span className="muted">On a subscription the cost is a list-price equivalent, not a charge.</span>}>
          <div className="scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Runs</th>
                  <th>Turns</th>
                  <th>Agent time</th>
                  <th>List price</th>
                </tr>
              </thead>
              <tbody>
                {(['planner', 'builder', 'verifier'] as const).map((role) => (
                  <tr key={role}>
                    <td>{role}</td>
                    <td className="num">{state.usage[role].calls}</td>
                    <td className="num">{state.usage[role].turns}</td>
                    <td className="num">{fmtDuration(state.usage[role].durationMs)}</td>
                    <td className="num">{fmtCost(state.usage[role].costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.usage.planner.calls === 0 && <p className="muted">The planner did not run for this one: its contract and plan were written by hand.</p>}
        </Section>
      </div>
    </div>
  );
}

function TaskCard({ task, needs, run, shell }: { task: TaskState; needs: string[]; run: RunView; shell: Shell }) {
  const session = latest(run, task.id);
  const live = session?.status === 'running';
  return (
    <button className={`block block-run block-${task.status}`} disabled={!session} onClick={() => session && shell.openSession(run.state.id, session.id)}>
      <span className="block-head">
        <span className="mono block-id">{task.id}</span>
        <span className="block-name">{task.title}</span>
        <Pill status={task.status} />
      </span>
      <span className="block-meta">
        <span className="chips">
          {task.repo && <Tag>{task.repo}</Tag>}
          {task.covers.map((c) => (
            <Tag key={c} tone="accent">
              {c}
            </Tag>
          ))}
        </span>
        {needs.length > 0 && <span className="muted">after {needs.join(', ')}</span>}
        {task.attempts > 1 && <span className="muted">attempt {task.attempts}</span>}
        {session && (
          <span className="muted mono">
            {session.model} · {fmtDuration(session.durationMs || now() - Date.parse(session.startedAt))}
          </span>
        )}
      </span>
      {live && <span className="block-live mono clip">{session.lastActivity}</span>}
      {!live && task.error && <span className="block-error">{task.error}</span>}
      {!live && !task.error && task.summary && <span className="block-summary">{task.summary}</span>}
      {(task.concerns ?? []).map((c) => (
        <span key={c} className="block-concern">
          Raised about the contract: {c}
        </span>
      ))}
    </button>
  );
}

function GateRow({ name, command, run }: { name: string; command: string; run: RunView }) {
  const { state } = run;
  const history: (GateResult | undefined)[] = state.rounds.map((r) => r.gates?.find((x) => x.gate === name));
  const arriving = state.gateProgress?.find((x) => x.gate === name);
  const verifying = !!state.progress || !!state.gateProgress;
  const result = arriving ?? (verifying ? undefined : history[history.length - 1]);
  const earlier = verifying ? history : history.slice(0, -1);
  return (
    <li className="check">
      <div className="check-verdict">
        {result ? <Pill status={result.verdict === 'skipped' ? 'pending' : result.verdict}>{result.verdict === 'skipped' ? 'skipped' : undefined}</Pill> : <Pill status="pending">{verifying ? 'waiting' : 'not checked'}</Pill>}
        {history.length > 1 && (
          <span className="rounds" title="Verdict in each verification round">
            {history.map((h, i) => (
              <span key={i} className={`round round-${h?.verdict === 'pass' || h?.verdict === 'fail' ? h.verdict : 'none'}`}>
                {i + 1}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="check-body">
        <p className="check-text">{name}</p>
        <p className="check-proof">
          <span className="label">command</span> <code>{command}</code>
        </p>
        <p className="check-facts muted">
          {state.gateBaseline?.[name] === 'pass' && <span>Passed before the work, as it should.</span>}
          {state.gateBaseline?.[name] === 'fail' && <span className="warn">Already failed before the work, so it is skipped and does not count. Fix it on the base branch.</span>}
        </p>
        {result && result.verdict !== 'skipped' && (
          <details className="evidence" open={result.verdict === 'fail'}>
            <summary>Evidence</summary>
            <pre>{result.evidence}</pre>
          </details>
        )}
        {earlier.map(
          (h, i) =>
            h?.verdict === 'fail' && (
              <details key={i} className="evidence evidence-fail">
                <summary>Why it was sent back in round {i + 1}</summary>
                <pre>{h.evidence}</pre>
              </details>
            ),
        )}
      </div>
    </li>
  );
}

function Check({ criterion, run, shell }: { criterion: Criterion; run: RunView; shell: Shell }) {
  const { state } = run;
  const history: (ProofResult | undefined)[] = state.rounds.map((r) => r.results.find((x) => x.criterion === criterion.id));
  const arriving = state.progress?.find((x) => x.criterion === criterion.id);
  const result = arriving ?? (state.progress ? undefined : history[history.length - 1]);
  const earlier = state.progress ? history : history.slice(0, -1);
  const reviewer = criterion.proof.type === 'review' ? latest(run, criterion.id) : undefined;
  const checking = reviewer?.status === 'running';
  const before = criterion.proof.type === 'command' ? state.baseline?.[criterion.id] : undefined;
  return (
    <li className="check">
      <div className="check-verdict">
        {checking ? (
          <Pill status="verifying">checking</Pill>
        ) : result ? (
          <Pill status={result.verdict} />
        ) : (
          <Pill status="pending">{state.progress ? 'waiting' : 'not checked'}</Pill>
        )}
        {history.length > 1 && (
          <span className="rounds" title="Verdict in each verification round">
            {history.map((h, i) => (
              <span key={i} className={`round round-${h?.verdict ?? 'none'}`}>
                {i + 1}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="check-body">
        <p className="check-text">
          <span className="mono clause-id">{criterion.id}</span> {criterion.text}
        </p>
        <p className="check-proof">
          {criterion.proof.type === 'command' ? (
            <>
              <span className="label">command</span> <code>{criterion.proof.run}</code>
            </>
          ) : (
            <>
              <span className="label">review</span> {criterion.proof.check}
            </>
          )}
        </p>
        <p className="check-facts muted">
          {before === 'fail' && <span>Failed before the work, as it should.</span>}
          {before === 'pass' && <span className="warn">Already passed before the work: a guard, not new evidence.</span>}
          {reviewer && (
            <button className="link" onClick={() => shell.openSession(state.id, reviewer.id)}>
              Reviewer session
            </button>
          )}
        </p>
        {result && (
          <details className="evidence" open={result.verdict === 'fail'}>
            <summary>Evidence</summary>
            <pre>{result.evidence}</pre>
          </details>
        )}
        {earlier.map(
          (h, i) =>
            h?.verdict === 'fail' && (
              <details key={i} className="evidence evidence-fail">
                <summary>Why it was sent back in round {i + 1}</summary>
                <pre>{h.evidence}</pre>
              </details>
            ),
        )}
      </div>
    </li>
  );
}
