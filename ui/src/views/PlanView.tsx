import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import { AUTHORING, type Task } from '../types';
import { Empty, ModelSelect, Pill, Problems, Section, Tag } from '../ui';

/** Tasks grouped into waves: everything in one wave can be built at the same time. */
export function toWaves(tasks: Task[]): Task[][] {
  const done = new Set<string>();
  let left = [...tasks];
  const out: Task[][] = [];
  while (left.length) {
    const wave = left.filter((t) => t.needs.every((n) => done.has(n) || !tasks.some((x) => x.id === n)));
    if (wave.length === 0) return [...out, left]; // a cycle: show the rest together; the validator names it
    out.push(wave);
    for (const t of wave) done.add(t.id);
    left = left.filter((t) => !done.has(t.id));
  }
  return out;
}

const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

export function PlanView({ shell }: { shell: Shell }) {
  const { ov, act, readOnly } = shell;
  const saved = ov.plan.plan?.tasks;
  const criteria = ov.contract.contract?.criteria ?? [];
  const [tasks, setTasks] = useState<Task[]>(saved ?? []);
  const [dirty, setDirty] = useState(false);
  const [openTask, setOpenTask] = useState<string>();

  useEffect(() => {
    if (!dirty) setTasks(saved ?? []);
  }, [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (id: string, patch: Partial<Task>) => {
    setTasks(tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setDirty(true);
  };
  const addTask = () => {
    const n = Math.max(0, ...tasks.map((t) => Number(t.id.slice(1)) || 0)) + 1;
    setTasks([...tasks, { id: `T${n}`, title: '', brief: '', covers: [], needs: [] }]);
    setOpenTask(`T${n}`);
    setDirty(true);
  };
  const remove = (id: string) => {
    setTasks(tasks.filter((t) => t.id !== id).map((t) => ({ ...t, needs: t.needs.filter((n) => n !== id) })));
    setDirty(true);
  };

  const planning = ov.job?.kind === 'plan';
  const planner = ov.authoring.sessions.filter((s) => s.label === 'plan').pop();
  const ready = ov.contract.approved && ov.plan.exists && ov.plan.problems.length === 0 && !dirty;
  const builderDefault = ov.config.models.builder || 'Claude Code default';

  if (!ov.contract.approved) {
    return (
      <Empty title="Approve the contract first">
        A plan is made for one exact version of the contract.{' '}
        <button className="link" onClick={() => shell.go('contract')}>
          Open the contract
        </button>
      </Empty>
    );
  }

  return (
    <div className="stack">
      <Section title="Coverage" aside={<span className="muted">Every requirement needs a task that is responsible for it.</span>}>
        <div className="coverage">
          {criteria.map((c) => {
            const by = tasks.filter((t) => t.covers.includes(c.id));
            return (
              <div key={c.id} className={`cover${by.length ? '' : ' cover-missing'}`} title={c.text}>
                <span className="mono cover-id">{c.id}</span>
                <span className="cover-text clip">{c.text}</span>
                <span className="cover-by">{by.length ? by.map((t) => <Tag key={t.id}>{t.id}</Tag>) : <Tag tone="fail">nobody</Tag>}</span>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title="Building blocks"
        aside={
          !readOnly && (
            <>
              {dirty && <Pill status="draft">Unsaved changes</Pill>}
              <button className="btn" disabled={shell.busy} onClick={() => act(api.draftPlan)}>
                {tasks.length ? 'Plan again' : 'Plan with the planner'}
              </button>
              <button className="btn" onClick={addTask}>
                Add a task
              </button>
              <button
                className="btn"
                disabled={!dirty}
                onClick={async () => {
                  if (await act(() => api.savePlan(tasks))) setDirty(false);
                }}
              >
                Save plan
              </button>
              <button
                className="btn btn-primary"
                disabled={!ready || shell.busy}
                onClick={async () => {
                  if (await act(() => api.startRun())) shell.go('run');
                }}
              >
                Start the run
              </button>
            </>
          )
        }
      >
        {planning && planner && (
          <button className="live-line" onClick={() => shell.openSession(AUTHORING, planner.id)}>
            <Pill status="running">planner</Pill>
            <span className="mono clip">{planner.lastActivity}</span>
            <span className="link">Watch</span>
          </button>
        )}
        {!dirty && <Problems title="This plan does not match the contract yet:" items={ov.plan.problems} />}

        {tasks.length === 0 ? (
          <Empty title="No tasks yet">Let the planner break the contract into tasks, or add them by hand.</Empty>
        ) : (
          <div className="waves">
            {toWaves(tasks).map((wave, i) => (
              <div key={i} className="wave">
                <div className="wave-head">
                  <span className="label">Wave {i + 1}</span>
                  <span className="muted">{wave.length > 1 ? `${wave.length} in parallel` : 'one task'}</span>
                </div>
                {wave.map((t) => (
                  <article key={t.id} className={`block${openTask === t.id ? ' block-open' : ''}`}>
                    <header className="block-head">
                      <span className="mono block-id">{t.id}</span>
                      <input
                        id={`title-${t.id}`}
                        className="input block-title"
                        aria-label={`Title of ${t.id}`}
                        placeholder="What this task builds"
                        value={t.title}
                        readOnly={readOnly}
                        onChange={(e) => edit(t.id, { title: e.target.value })}
                      />
                    </header>
                    <div className="block-meta">
                      <span className="chips">
                        {t.covers.length ? t.covers.map((c) => <Tag key={c} tone="accent">{c}</Tag>) : <span className="muted">prepares for others</span>}
                      </span>
                      {t.needs.length > 0 && <span className="muted">after {t.needs.join(', ')}</span>}
                    </div>
                    <div className="block-model">
                      <label className="label" htmlFor={`model-${t.id}`}>
                        Model
                      </label>
                      <ModelSelect id={`model-${t.id}`} value={t.model ?? ''} inherit={`Builder default (${builderDefault})`} disabled={readOnly} onChange={(v) => edit(t.id, { model: v || undefined })} />
                    </div>
                    <button className="link" onClick={() => setOpenTask(openTask === t.id ? undefined : t.id)}>
                      {openTask === t.id ? 'Close' : 'Brief, requirements and order'}
                    </button>
                    {openTask === t.id && (
                      <div className="block-edit">
                        <label className="field">
                          <span className="label">Brief for the builder</span>
                          <textarea id={`brief-${t.id}`} className="input" rows={5} value={t.brief} readOnly={readOnly} onChange={(e) => edit(t.id, { brief: e.target.value })} />
                        </label>
                        <div className="field">
                          <span className="label">Responsible for</span>
                          <div className="chips">
                            {criteria.map((c) => (
                              <button key={c.id} className={`chip${t.covers.includes(c.id) ? ' chip-on' : ''}`} disabled={readOnly} title={c.text} onClick={() => edit(t.id, { covers: toggle(t.covers, c.id) })}>
                                {c.id}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="field">
                          <span className="label">Starts after</span>
                          <div className="chips">
                            {tasks
                              .filter((x) => x.id !== t.id)
                              .map((x) => (
                                <button key={x.id} className={`chip${t.needs.includes(x.id) ? ' chip-on' : ''}`} disabled={readOnly} title={x.title} onClick={() => edit(t.id, { needs: toggle(t.needs, x.id) })}>
                                  {x.id}
                                </button>
                              ))}
                            {tasks.length === 1 && <span className="muted">no other tasks</span>}
                          </div>
                        </div>
                        {!readOnly && (
                          <button className="btn btn-quiet" onClick={() => remove(t.id)}>
                            Remove this task
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
