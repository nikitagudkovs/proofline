import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, clock, isDemo, subscribe } from './api';
import { SessionDrawer } from './SessionDrawer';
import type { Overview, RunView } from './types';
import { Pill, fmtDuration } from './ui';
import { ContractView } from './views/ContractView';
import { ModelsView } from './views/ModelsView';
import { PlanView } from './views/PlanView';
import { RunScreen } from './views/RunView';
import { SessionsView } from './views/SessionsView';

const VIEWS = [
  { id: 'contract', label: 'Contract', hint: 'what must be true' },
  { id: 'plan', label: 'Plan', hint: 'the building blocks' },
  { id: 'run', label: 'Run', hint: 'build and verify' },
  { id: 'sessions', label: 'Sessions', hint: 'every agent run' },
  { id: 'models', label: 'Models', hint: 'who does the work' },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

const readHash = (): ViewId => {
  const id = location.hash.replace('#', '');
  return (VIEWS.find((v) => v.id === id)?.id ?? (isDemo ? 'run' : 'contract')) as ViewId;
};

/** Everything a view needs from the shell. */
export interface Shell {
  ov: Overview;
  run?: RunView;
  /** Changes on every refresh, so open panels know to reload. */
  tick: number;
  busy: boolean;
  readOnly: boolean;
  go: (view: ViewId) => void;
  selectRun: (id: string) => void;
  openSession: (runId: string, sid: string) => void;
  /** Run an action, then refresh; failures are shown, never swallowed. */
  act: (fn: () => Promise<unknown>) => Promise<boolean>;
}

const JOB_LABEL = { contract: 'Drafting the contract', plan: 'Planning tasks', run: 'Run in progress', verify: 'Verifying', ship: 'Opening the pull request', merge: 'Merging', action: 'Running an action', clean: 'Cleaning up' };

export function App() {
  const [view, setView] = useState<ViewId>(readHash);
  const [ov, setOv] = useState<Overview>();
  const [run, setRun] = useState<RunView>();
  const [runId, setRunId] = useState<string>();
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<{ runId: string; sid: string }>();
  const [error, setError] = useState<{ message: string; problems: string[] }>();
  const [offline, setOffline] = useState(false);
  const picked = useRef<string>();

  const refresh = useCallback(async () => {
    try {
      const next = await api.overview();
      setOv(next);
      setOffline(false);
      // Follow the run that is working; otherwise stay on the one picked, or the latest.
      const id = (next.job?.kind === 'run' ? next.job.runId : undefined) ?? picked.current ?? next.runs[0]?.id;
      setRunId(id);
      setRun(id ? await api.run(id) : undefined);
      setTick((t) => t + 1);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(refresh, isDemo ? 0 : 120);
    });
    const poll = setInterval(refresh, 15_000);
    const onHash = () => setView(readHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      unsubscribe();
      clearInterval(poll);
      window.removeEventListener('hashchange', onHash);
    };
  }, [refresh]);

  const go = useCallback((id: ViewId) => {
    location.hash = id;
    setView(id);
  }, []);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        setError(undefined);
        await fn();
        await refresh();
        return true;
      } catch (e) {
        setError({ message: (e as Error).message, problems: e instanceof ApiError ? e.problems : [] });
        return false;
      }
    },
    [refresh],
  );

  if (!ov) {
    return <div className="boot">{offline ? 'The proofline server is not answering. Start it again with “proofline ui”.' : 'Loading…'}</div>;
  }

  const shell: Shell = {
    ov,
    run,
    tick,
    busy: !!ov.job,
    readOnly: isDemo,
    go,
    selectRun: (id) => {
      picked.current = id;
      void refresh();
    },
    openSession: (rid, sid) => setOpen({ runId: rid, sid }),
    act,
  };

  const done = {
    contract: ov.contract.approved,
    plan: ov.plan.exists && ov.plan.problems.length === 0,
    run: run?.state.status === 'proven',
    sessions: false,
    models: false,
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          <span className="brand-name">proofline</span>
          <span className="brand-repo mono" title={ov.repo.repos?.length ? `A workspace of ${ov.repo.repos.join(' and ')}` : undefined}>
            {ov.repo.name}
            {ov.repo.repos?.length ? ` · ${ov.repo.repos.join(' + ')}` : ''}
          </span>
        </div>
        <nav className="tabs" aria-label="Stages">
          {VIEWS.map((v, i) => (
            <button key={v.id} className={`tab${view === v.id ? ' tab-on' : ''}`} onClick={() => go(v.id)} aria-current={view === v.id}>
              <span className="tab-n mono">{done[v.id] ? '✓' : i + 1}</span>
              <span className="tab-text">
                <span className="tab-label">{v.label}</span>
                <span className="tab-hint">{v.hint}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="status">
          {ov.job ? (
            <>
              <Pill status="running">{JOB_LABEL[ov.job.kind]}</Pill>
              {!isDemo && (
                <button className="btn btn-quiet" onClick={() => act(api.stopJob)}>
                  Stop
                </button>
              )}
            </>
          ) : (
            <span className="muted">Idle</span>
          )}
        </div>
      </header>

      {isDemo && <Replay />}
      {offline && <div className="banner banner-fail">Lost contact with the proofline server. Retrying…</div>}
      {ov.lastError && !ov.job && <div className="banner banner-fail">The last job failed: {ov.lastError}</div>}
      {error && (
        <div className="banner banner-fail" role="alert">
          <div>
            {error.message}
            {error.problems.length > 0 && (
              <ul>
                {error.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
          <button className="btn btn-quiet" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="main">
        {view === 'contract' && <ContractView shell={shell} />}
        {view === 'plan' && <PlanView shell={shell} />}
        {view === 'run' && <RunScreen shell={shell} runId={runId} />}
        {view === 'sessions' && <SessionsView shell={shell} runId={runId} />}
        {view === 'models' && <ModelsView shell={shell} />}
      </main>

      {open && <SessionDrawer runId={open.runId} sid={open.sid} tick={tick} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

/** Transport for the recorded run in the static demo. */
function Replay() {
  const [, force] = useState(0);
  useEffect(() => {
    const off = clock.subscribe(() => force((n) => n + 1));
    return () => {
      off();
    };
  }, []);
  return (
    <div className="replay">
      <span className="replay-note">
        <strong>Recorded run.</strong> A real proofline run on a small library, replayed as it happened.
      </span>
      <div className="replay-controls">
        <button className="btn btn-primary" onClick={() => (clock.playing ? clock.pause() : clock.play())}>
          {clock.playing ? 'Pause' : clock.t >= clock.duration ? 'Replay the run' : 'Play'}
        </button>
        <input
          id="replay-position"
          className="replay-range"
          type="range"
          aria-label="Position in the run"
          min={0}
          max={clock.duration}
          step={250}
          value={clock.t}
          onChange={(e) => clock.seek(Number(e.target.value))}
        />
        <span className="mono replay-time">
          {fmtDuration(clock.t)} / {fmtDuration(clock.duration)}
        </span>
        <select id="replay-speed" className="select" aria-label="Replay speed" value={clock.speed} onChange={(e) => clock.setSpeed(Number(e.target.value))}>
          {[1, 2, 4, 8].map((s) => (
            <option key={s} value={s}>
              {s}× speed
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
