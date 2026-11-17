import { useState } from 'react';
import { now } from '../api';
import type { Shell } from '../App';
import { AUTHORING, type SessionMeta } from '../types';
import { Empty, Pill, Section, fmtClock, fmtCost, fmtDuration } from '../ui';

const ROLES = ['all', 'planner', 'builder', 'verifier'] as const;

export function SessionsView({ shell, runId }: { shell: Shell; runId?: string }) {
  const [role, setRole] = useState<(typeof ROLES)[number]>('all');
  const planning = shell.ov.authoring.sessions.map((s) => ({ runId: AUTHORING, s }));
  const running = (shell.run?.sessions ?? []).map((s) => ({ runId: runId ?? '', s }));
  const rows = [...planning, ...running].filter((r) => role === 'all' || r.s.role === role).reverse();
  const live = rows.filter((r) => r.s.status === 'running').length;

  return (
    <Section
      title="Sessions"
      aside={
        <>
          <span className="muted">{live ? `${live} working now` : 'Every agent run, newest first. Select one for its report.'}</span>
          <div className="segmented" role="group" aria-label="Filter by role">
            {ROLES.map((r) => (
              <button key={r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>
                {r}
              </button>
            ))}
          </div>
        </>
      }
    >
      {rows.length === 0 ? (
        <Empty title="No sessions yet">Each planner, builder and verifier run shows up here while it works and stays as a record.</Empty>
      ) : (
        <div className="scroll">
          <table className="table table-rows">
            <thead>
              <tr>
                <th>Session</th>
                <th>Role</th>
                <th>Status</th>
                <th>Model</th>
                <th>Started</th>
                <th>Time</th>
                <th>Turns</th>
                <th>List price</th>
                <th>Now / last step</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ runId: rid, s }) => (
                <Row key={`${rid}-${s.id}`} s={s} onOpen={() => shell.openSession(rid, s.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Row({ s, onOpen }: { s: SessionMeta; onOpen: () => void }) {
  return (
    <tr tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <td className="mono strong">{s.id}</td>
      <td>{s.role}</td>
      <td>
        <Pill status={s.status} />
      </td>
      <td className="mono">{s.model}</td>
      <td className="mono">{fmtClock(s.startedAt)}</td>
      <td className="num">{fmtDuration(s.durationMs || now() - Date.parse(s.startedAt))}</td>
      <td className="num">{s.turns || ''}</td>
      <td className="num">{s.costUsd ? fmtCost(s.costUsd) : ''}</td>
      <td className="mono clip last-step">{s.error ?? s.lastActivity}</td>
    </tr>
  );
}
