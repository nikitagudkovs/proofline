import { useEffect, useRef, useState } from 'react';
import { api, now } from './api';
import type { SessionView } from './types';
import { Pill, fmtCost, fmtDuration } from './ui';

const ROLE_NOTE = {
  planner: 'Read-only. Drafts a contract or a plan, which a validator then checks.',
  builder: 'Works in its own copy of the repository. Its own report never counts as proof.',
  verifier: 'Read-only and independent: it sees the requirement and the code, never the builder.',
};

/** One agent session: what it was asked, what it did step by step, and what it answered. */
export function SessionDrawer({ runId, sid, tick, onClose }: { runId: string; sid: string; tick: number; onClose: () => void }) {
  const [view, setView] = useState<SessionView>();
  const [error, setError] = useState('');
  const [showBrief, setShowBrief] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .session(runId, sid)
      .then((v) => !cancelled && (setView(v), setError('')))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [runId, sid, tick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const live = view?.meta.status === 'running';
  const count = view?.events.length ?? 0;
  useEffect(() => {
    if (live) bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [count, live]);

  const meta = view?.meta;
  const output = (meta?.output ?? undefined) as Record<string, unknown> | undefined;

  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label={`Session ${sid}`} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <p className="label">{meta?.role ?? 'session'}</p>
            <h2 className="mono">{sid}</h2>
          </div>
          <button className="btn btn-quiet" onClick={onClose}>
            Close
          </button>
        </header>

        {error && <div className="notice notice-fail">{error}</div>}
        {meta && view && (
          <div className="drawer-body">
            <p className="muted">{ROLE_NOTE[meta.role]}</p>
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>
                  <Pill status={meta.status} />
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd className="mono">{meta.model}</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd className="mono">{fmtDuration(meta.durationMs || now() - Date.parse(meta.startedAt))}</dd>
              </div>
              <div>
                <dt>Turns</dt>
                <dd className="mono">{meta.turns || '…'}</dd>
              </div>
              <div>
                <dt>List price</dt>
                <dd className="mono">{meta.costUsd ? fmtCost(meta.costUsd) : '…'}</dd>
              </div>
              <div>
                <dt>Tools used</dt>
                <dd className="mono">
                  {Object.entries(meta.tools)
                    .map(([tool, n]) => `${tool} ${n}`)
                    .join(' · ') || 'none'}
                </dd>
              </div>
            </dl>

            {meta.error && (
              <div className="notice notice-fail">
                <strong>This session failed</strong>
                <p>{meta.error}</p>
              </div>
            )}

            {output && (
              <section className="drawer-section">
                <h3>{meta.role === 'verifier' ? 'Verdict' : 'What it reported'}</h3>
                <Answer output={output} />
                {meta.role === 'builder' && <p className="muted">This is the builder's own account. The contract check decides what is proven.</p>}
              </section>
            )}

            {view.changes && (
              <section className="drawer-section">
                <h3>Changes it committed</h3>
                <pre className="code">{view.changes}</pre>
              </section>
            )}

            <section className="drawer-section">
              <h3>Step by step</h3>
              <ol className="timeline">
                {view.events.map((e, i) => (
                  <li key={i} className={`step step-${e.kind}${e.failed ? ' step-failed' : ''}`}>
                    <time className="mono muted">{fmtDuration(e.t)}</time>
                    {e.kind === 'tool' ? (
                      <span className="mono">
                        <strong>{e.tool}</strong> {e.text}
                      </span>
                    ) : (
                      <span className={e.kind === 'text' ? '' : 'mono'}>{e.text}</span>
                    )}
                  </li>
                ))}
                {live && (
                  <li className="step step-live">
                    <time className="mono muted">now</time>
                    <span className="muted">working…</span>
                  </li>
                )}
              </ol>
              <div ref={bottom} />
            </section>

            <section className="drawer-section">
              <h3>The brief it was given</h3>
              <button className="link" onClick={() => setShowBrief(!showBrief)}>
                {showBrief ? 'Hide the brief' : 'Show the full brief'}
              </button>
              {showBrief && <pre className="code">{meta.prompt}</pre>}
            </section>

            {meta.claudeSessionId && (
              <section className="drawer-section">
                <h3>Full transcript</h3>
                <p className="muted">Open the whole conversation in Claude Code:</p>
                <pre className="code">claude --resume {meta.claudeSessionId}</pre>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

const ORDER = ['verdict', 'status', 'evidence', 'summary', 'notes', 'concerns', 'goal'];

/** The structured answer, field by field, in an order a person would read it. */
function Answer({ output }: { output: Record<string, unknown> }) {
  const keys = Object.keys(output).sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  return (
    <dl className="answer">
      {keys.map((key) => {
        const value = output[key];
        if (value === '' || value === undefined || (Array.isArray(value) && value.length === 0)) return null;
        return (
          <div key={key}>
            <dt>{key.replace(/_/g, ' ')}</dt>
            <dd>
              {key === 'verdict' || key === 'status' ? (
                <Pill status={String(value)} />
              ) : Array.isArray(value) && value.every((v) => typeof v === 'string') ? (
                <ul>
                  {value.map((v, i) => (
                    <li key={i}>{v as string}</li>
                  ))}
                </ul>
              ) : typeof value === 'string' ? (
                value
              ) : (
                <pre className="code">{JSON.stringify(value, null, 2)}</pre>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
