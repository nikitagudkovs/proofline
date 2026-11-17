import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { Config } from '../types';
import { ModelSelect, Section } from '../ui';

const ROLES = [
  { id: 'planner', title: 'Planner', does: 'Reads the repository, drafts the contract and the plan. Read-only.' },
  { id: 'builder', title: 'Builders', does: 'Write the code, one per task. A task can override this in the plan.' },
  { id: 'verifier', title: 'Verifiers', does: 'Answer review proofs with file-and-line evidence. Read-only, independent.' },
] as const;

export function ModelsView({ shell }: { shell: Shell }) {
  const { ov, act, readOnly } = shell;
  const [setup, setSetup] = useState(ov.config.setup);
  useEffect(() => setSetup(ov.config.setup), [ov.config.setup]);
  const save = (patch: Partial<Config>) => act(() => api.saveConfig(patch));
  const overrides = (ov.plan.plan?.tasks ?? []).filter((t) => t.model);

  return (
    <div className="stack">
      <Section title="Who does the work" aside={<span className="muted">Changes apply to the next agent that starts.</span>}>
        <div className="roles">
          {ROLES.map((r) => (
            <div key={r.id} className="role">
              <label className="role-title" htmlFor={`role-${r.id}`}>
                {r.title}
              </label>
              <p className="muted">{r.does}</p>
              <ModelSelect
                id={`role-${r.id}`}
                value={ov.config.models[r.id]}
                inherit="Claude Code default"
                disabled={readOnly}
                onChange={(v) => save({ models: { ...ov.config.models, [r.id]: v } })}
              />
            </div>
          ))}
        </div>
        {overrides.length > 0 && (
          <p className="muted">
            Set per task in the plan: {overrides.map((t) => `${t.id} on ${t.model}`).join(', ')}.{' '}
            <button className="link" onClick={() => shell.go('plan')}>
              Open the plan
            </button>
          </p>
        )}
      </Section>

      <Section title="How a run behaves">
        <div className="settings">
          <label className="field" htmlFor="concurrency">
            <span className="label">Agents at the same time</span>
            <input
              id="concurrency"
              className="input narrow"
              type="number"
              min={1}
              max={12}
              value={ov.config.concurrency}
              disabled={readOnly}
              onChange={(e) => save({ concurrency: Math.max(1, Number(e.target.value) || 1) })}
            />
          </label>
          <label className="field" htmlFor="fix-rounds">
            <span className="label">Times a failed line is sent back</span>
            <input
              id="fix-rounds"
              className="input narrow"
              type="number"
              min={0}
              max={6}
              value={ov.config.maxFixRounds}
              disabled={readOnly}
              onChange={(e) => save({ maxFixRounds: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
          <label className="field field-wide" htmlFor="setup">
            <span className="label">Command to run before the proofs (for example: npm ci)</span>
            <input
              id="setup"
              className="input mono"
              value={setup}
              disabled={readOnly}
              onChange={(e) => setSetup(e.target.value)}
              onBlur={() => setup !== ov.config.setup && save({ setup })}
            />
          </label>
        </div>
      </Section>

      <Section
        title="Accounts this runs on"
        aside={
          !readOnly && (
            <button className="btn" onClick={() => act(api.refreshAccounts)}>
              Check again
            </button>
          )
        }
      >
        <ul className="accounts">
          {ov.accounts.map((c) => (
            <li key={c.label}>
              <span className={`dot dot-${c.ok ? 'pass' : c.shipOnly ? 'warn' : 'fail'}`} aria-hidden="true" />
              <span className="strong">{c.label}</span>
              <span>{c.detail}</span>
            </li>
          ))}
        </ul>
        <div className="row">
          <div className="segmented" role="group" aria-label="How agents sign in">
            <button className={ov.config.auth === 'subscription' ? 'on' : ''} disabled={readOnly} onClick={() => save({ auth: 'subscription' })}>
              Claude subscription
            </button>
            <button className={ov.config.auth === 'inherit' ? 'on' : ''} disabled={readOnly} onClick={() => save({ auth: 'inherit' })}>
              Whatever the shell has
            </button>
          </div>
          <span className="muted">
            {ov.config.auth === 'subscription'
              ? 'API keys are removed from every agent, so a run can only use your Claude Code login.'
              : 'Agents see your shell as it is, including any API key in it.'}
          </span>
        </div>
      </Section>
    </div>
  );
}
