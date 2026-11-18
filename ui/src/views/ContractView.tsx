import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import { AUTHORING, type Contract, type Criterion } from '../types';
import { Empty, Pill, Problems, Section } from '../ui';

const blank = (): Contract => ({ goal: '', outOfScope: [], criteria: [] });
/** What gets saved: ids in order, no blank scope lines. */
const renumber = (c: Contract): Contract => ({
  ...c,
  outOfScope: c.outOfScope.map((l) => l.trim()).filter(Boolean),
  criteria: c.criteria.map((k, i) => ({ ...k, id: `C${i + 1}` })),
});

function recall(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function ContractView({ shell }: { shell: Shell }) {
  const { ov, act, readOnly } = shell;
  const saved = ov.contract.contract;
  const [draft, setDraft] = useState<Contract>(saved ?? blank());
  const [dirty, setDirty] = useState(false);
  // The goal is the one thing here a person types at length, so it also survives a reload or a dropped connection.
  // What is being typed wins over what the project last had drafted from.
  const goalKey = `proofline.goal:${ov.repo.root}:${ov.project?.id ?? ''}`;
  const [goal, setGoalText] = useState(() => recall(goalKey) || ov.project?.goal || '');
  const setGoal = (text: string) => {
    setGoalText(text);
    try {
      if (text) localStorage.setItem(goalKey, text);
      else localStorage.removeItem(goalKey);
    } catch {
      // storage is off or full: the goal still lives as long as the page does
    }
  };

  const [shelved, setShelved] = useState<string[]>([]);

  // Follow the file on disk (a fresh draft from the planner, an edit in an editor) unless there are unsaved edits here.
  useEffect(() => {
    if (dirty) return;
    setDraft(saved ?? blank());
    setShelved([]);
  }, [ov.contract.hash, saved === undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per requirement, what was written for the kind of proof that is not showing: switching
  // between Command and Review puts one text aside and brings the other back, never empties it.
  const switchProof = (i: number, to: Criterion['proof']['type']) => {
    const proof = draft.criteria[i].proof;
    if (proof.type === to) return;
    const back = shelved[i] ?? '';
    setShelved(Object.assign([...shelved], { [i]: proof.type === 'command' ? proof.run : proof.check }));
    editCriterion(i, { proof: to === 'command' ? { type: 'command', run: back } : { type: 'review', check: back } });
  };
  const removeCriterion = (i: number) => {
    setShelved(Array.from({ length: draft.criteria.length }, (_, j) => shelved[j] ?? '').filter((_, j) => j !== i));
    edit({ ...draft, criteria: draft.criteria.filter((_, j) => j !== i) });
  };

  const edit = (next: Contract) => {
    setDraft(next);
    setDirty(true);
  };
  const editCriterion = (i: number, patch: Partial<Criterion>) =>
    edit({ ...draft, criteria: draft.criteria.map((k, j) => (j === i ? { ...k, ...patch } : k)) });

  const draftGoal = async () => {
    if (!(await act(() => api.draftContract(goal)))) return;
    // The project has the goal now. Dropping the browser's copy keeps it from showing up on this
    // project again if the draft went to a new one.
    try {
      localStorage.removeItem(goalKey);
    } catch {
      // nothing was stored
    }
  };

  const drafting = ov.job?.kind === 'contract';
  const planner = ov.authoring.sessions.filter((s) => s.label === 'contract').pop();
  const status = !ov.contract.exists ? 'none' : dirty ? 'draft' : ov.contract.approved ? 'approved' : 'draft';

  return (
    <div className="stack">
      <Section title="What do you want built?">
        <div className="composer">
          <textarea
            id="goal"
            className="input"
            rows={3}
            placeholder="Describe the change in plain words. The planner reads this repository and turns it into numbered requirements, each with a proof."
            value={goal}
            disabled={readOnly || shell.busy}
            onChange={(e) => setGoal(e.target.value)}
          />
          <div className="row">
            <button className="btn btn-primary" disabled={readOnly || shell.busy || !goal.trim()} onClick={draftGoal}>
              Draft a contract
            </button>
            <span className="muted">
              Uses the planner model ({ov.config.models.planner || 'Claude Code default'}).{' '}
              {ov.contract.exists && (ov.runs.length > 0 && ov.projects ? 'This project already has a run, so a new draft starts a new project; this one is kept.' : 'A new draft replaces the contract below.')}
            </span>
          </div>
          {drafting && planner && (
            <button className="live-line" onClick={() => shell.openSession(AUTHORING, planner.id)}>
              <Pill status="running">planner</Pill>
              <span className="mono clip">{planner.lastActivity}</span>
              <span className="link">Watch</span>
            </button>
          )}
        </div>
      </Section>

      <Section
        title="Contract"
        aside={
          <>
            {status === 'approved' && <Pill status="approved">Approved · {ov.contract.hash}</Pill>}
            {status === 'draft' && <Pill status="draft">{dirty ? 'Unsaved changes' : 'Not approved'}</Pill>}
            {!readOnly && (
              <>
                <button
                  className="btn"
                  disabled={!dirty}
                  onClick={async () => {
                    if (await act(() => api.saveContract(renumber(draft)))) setDirty(false);
                  }}
                >
                  Save changes
                </button>
                <button className="btn btn-primary" disabled={dirty || !ov.contract.exists || ov.contract.approved || shell.busy} onClick={() => act(api.approveContract)}>
                  Approve contract
                </button>
              </>
            )}
          </>
        }
      >
        <Problems title="The contract file on disk does not parse:" items={ov.contract.problems ?? []} />

        {draft.criteria.length === 0 && !draft.goal ? (
          <Empty title="No contract yet">
            Describe a goal above, or add the first requirement by hand. Nothing is built until you approve the contract.
          </Empty>
        ) : (
          <div className="contract">
            <label className="field">
              <span className="label">Goal</span>
              <textarea id="contract-goal" className="input" rows={2} value={draft.goal} readOnly={readOnly} onChange={(e) => edit({ ...draft, goal: e.target.value })} />
            </label>

            <ol className="clauses">
              {draft.criteria.map((k, i) => (
                <li key={i} className="clause">
                  <span className="clause-id mono">C{i + 1}</span>
                  <div className="clause-body">
                    <textarea
                      id={`criterion-${i}`}
                      className="input clause-text"
                      rows={1}
                      aria-label={`Requirement C${i + 1}`}
                      placeholder="One observable outcome"
                      value={k.text}
                      readOnly={readOnly}
                      onChange={(e) => editCriterion(i, { text: e.target.value })}
                    />
                    <div className="proof-row">
                      <div className="segmented" role="group" aria-label={`How C${i + 1} is proven`}>
                        <button
                          className={k.proof.type === 'command' ? 'on' : ''}
                          disabled={readOnly}
                          onClick={() => switchProof(i, 'command')}
                        >
                          Command
                        </button>
                        <button
                          className={k.proof.type === 'review' ? 'on' : ''}
                          disabled={readOnly}
                          onClick={() => switchProof(i, 'review')}
                        >
                          Review
                        </button>
                      </div>
                      <textarea
                        id={`proof-${i}`}
                        rows={1}
                        className={`input${k.proof.type === 'command' ? ' mono' : ''}`}
                        aria-label={`Proof for C${i + 1}`}
                        placeholder={k.proof.type === 'command' ? 'A command that exits 0 only when this holds' : 'A yes/no question for an independent reviewer'}
                        value={k.proof.type === 'command' ? k.proof.run : k.proof.check}
                        readOnly={readOnly}
                        onChange={(e) =>
                          editCriterion(i, { proof: k.proof.type === 'command' ? { type: 'command', run: e.target.value } : { type: 'review', check: e.target.value } })
                        }
                      />
                      {!readOnly && (
                        <button className="btn btn-quiet" aria-label={`Remove C${i + 1}`} onClick={() => removeCriterion(i)}>
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {!readOnly && (
              <button
                className="btn"
                onClick={() => edit({ ...draft, criteria: [...draft.criteria, { id: `C${draft.criteria.length + 1}`, text: '', proof: { type: 'command', run: '' } }] })}
              >
                Add a requirement
              </button>
            )}

            <label className="field">
              <span className="label">Out of scope, one per line</span>
              <textarea
                id="out-of-scope"
                className="input"
                rows={Math.max(2, draft.outOfScope.length)}
                value={draft.outOfScope.join('\n')}
                readOnly={readOnly}
                onChange={(e) => edit({ ...draft, outOfScope: e.target.value.split('\n') })}
              />
            </label>

            {!dirty && ov.contract.warnings.length > 0 && (
              <div className="notice notice-warn">
                <strong>Worth a second look before you approve</strong>
                <ul>
                  {ov.contract.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {ov.contract.approved && !dirty && (
          <p className="next">
            The contract is locked. Any edit voids the approval.{' '}
            <button className="link" onClick={() => shell.go('plan')}>
              Go to the plan
            </button>
          </p>
        )}
      </Section>
    </div>
  );
}
