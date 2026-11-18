import { useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { ProjectSummary, RunSummary } from '../types';
import { Empty, Pill, Section, fmtRunId } from '../ui';

/** Where a project stands, in one word, from its newest run back to an empty page. */
function stage(p: ProjectSummary): { status: string; label: string } {
  const last = p.runs[0];
  if (last?.merged) return { status: 'merged', label: 'merged' };
  if (last?.prUrls?.length) return { status: last.status === 'proven' ? 'proven' : last.status, label: last.status === 'proven' ? 'pull request open' : 'draft pull request' };
  if (last) return { status: last.status, label: last.status === 'unproven' ? 'not proven' : last.status };
  if (p.approved) return { status: 'approved', label: p.tasks ? 'planned' : 'approved' };
  if (p.contract) return { status: 'draft', label: 'contract drafted' };
  return { status: 'pending', label: 'empty' };
}

export function ProjectsView({ shell }: { shell: Shell }) {
  const { ov, act, readOnly } = shell;
  const projects = ov.projects ?? [];
  const unfiled = ov.unfiledRuns ?? [];
  const locked = readOnly || shell.busy;

  return (
    <div className="stack">
      <Section
        title="Projects"
        aside={
          <>
            <span className="muted">Every goal worked on here, with its contract, plan and runs. Nothing is overwritten by the next one.</span>
            {!readOnly && (
              <button
                className="btn btn-primary"
                disabled={locked}
                title={shell.busy ? 'A job is running on the open project' : undefined}
                onClick={async () => {
                  if (await act(() => api.newProject())) shell.go('contract');
                }}
              >
                New project
              </button>
            )}
          </>
        }
      >
        {projects.length === 0 ? (
          <Empty title="No projects yet">Describe a goal on the Contract screen and it becomes the first one.</Empty>
        ) : (
          <ol className="projects">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} shell={shell} locked={locked} />
            ))}
          </ol>
        )}
      </Section>

      {unfiled.length > 0 && (
        <Section title="Earlier runs" aside={<span className="muted">Made before projects were kept, for contracts that have since been replaced. Their reports are still here.</span>}>
          <ul className="project-runs">
            {unfiled.map((r) => (
              <RunLine key={r.id} run={r} shell={shell} viewable />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ProjectCard({ project: p, shell, locked }: { project: ProjectSummary; shell: Shell; locked: boolean }) {
  const { act, readOnly } = shell;
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(p.title);
  const st = stage(p);
  const goal = p.goal || p.contract?.goal || '';

  const rename = async () => {
    setRenaming(false);
    if (title.trim() && title.trim() !== p.title) await act(() => api.renameProject(p.id, title.trim()));
    else setTitle(p.title);
  };

  return (
    <li className={`project${p.open ? ' project-open' : ''}`}>
      <div className="project-head">
        <div className="project-title">
          {renaming ? (
            <input
              className="input"
              autoFocus
              aria-label="Project name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename();
                if (e.key === 'Escape') {
                  setTitle(p.title);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <strong>{p.title}</strong>
          )}
          <span className="project-meta muted">
            <Pill status={st.status}>{st.label}</Pill>
            {p.open && <Pill status="built">open</Pill>}
            <span>started {new Date(p.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            <span>
              {p.runs.length} {p.runs.length === 1 ? 'run' : 'runs'}
            </span>
            {p.contract && (
              <span>
                {p.contract.criteria.length} {p.contract.criteria.length === 1 ? 'requirement' : 'requirements'}
              </span>
            )}
          </span>
        </div>
        {!readOnly && (
          <div className="row project-actions">
            {p.open ? (
              <button className="btn" onClick={() => shell.go(p.runs.length ? 'run' : 'contract')}>
                {p.runs.length ? 'Go to its run' : 'Go to its contract'}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={locked}
                title={shell.busy ? 'A job is running on the open project' : 'Its contract, plan and runs become the ones on the other tabs'}
                onClick={async () => {
                  if (await act(() => api.openProject(p.id))) shell.go(p.runs.length ? 'run' : 'contract');
                }}
              >
                Open
              </button>
            )}
            {goal && (
              <button
                className="btn"
                disabled={locked}
                title="A new project that starts from this goal's text; this one is kept"
                onClick={async () => {
                  if (await act(() => api.newProject(goal))) shell.go('contract');
                }}
              >
                Start again from this goal
              </button>
            )}
            <button className="btn btn-quiet" onClick={() => setRenaming(true)}>
              Rename
            </button>
          </div>
        )}
      </div>

      <details className="project-more">
        <summary>Goal, contract and runs</summary>
        {goal ? (
          <>
            <p className="label">{p.goal ? 'Goal, as it was typed' : 'Goal'}</p>
            <p className="project-goal">{goal}</p>
          </>
        ) : (
          <p className="muted">No goal has been written for this project yet.</p>
        )}
        {p.contract && (
          <>
            <p className="label">
              Contract {p.approved ? '(approved)' : '(not approved)'}
              {p.tasks ? ` · plan of ${p.tasks} ${p.tasks === 1 ? 'task' : 'tasks'}` : ''}
            </p>
            <ol className="project-contract">
              {p.contract.criteria.map((c) => (
                <li key={c.id}>
                  <span className="mono clause-id">{c.id}</span>
                  <span>
                    {c.text}
                    <span className="project-proof muted">
                      {c.proof.type === 'command' ? <code>{c.proof.run}</code> : <>review: {c.proof.check}</>}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
        <p className="label">Runs</p>
        {p.runs.length === 0 ? (
          <p className="muted">Nothing has been built for this project yet.</p>
        ) : (
          <ul className="project-runs">
            {p.runs.map((r) => (
              <RunLine key={r.id} run={r} shell={shell} viewable={p.open} />
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

/** One run in a list: when, how it ended, its report and pull requests. `viewable` runs can be shown on the Run screen as they are. */
function RunLine({ run: r, shell, viewable }: { run: RunSummary; shell: Shell; viewable: boolean }) {
  return (
    <li className="project-run">
      <span className="mono">{fmtRunId(r.id)}</span>
      <Pill status={r.merged ? 'merged' : r.status} />
      {r.total > 0 && (
        <span className="muted">
          {r.proven} of {r.total} proven
        </span>
      )}
      <a className="link" href={api.reportUrl(r.id)} target="_blank" rel="noreferrer">
        Report
      </a>
      {(r.prUrls ?? []).map((pr) => (
        <a key={pr.url} className="link" href={pr.url} target="_blank" rel="noreferrer">
          Pull request{pr.repo ? ` (${pr.repo})` : ''}
        </a>
      ))}
      {viewable && (
        <button
          className="link"
          onClick={() => {
            shell.selectRun(r.id);
            shell.go('run');
          }}
        >
          Show on the Run screen
        </button>
      )}
    </li>
  );
}
