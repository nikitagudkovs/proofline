import { useState, type ReactNode } from 'react';

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtCost = (usd: number) => `$${usd.toFixed(2)}`;

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** A run id is a timestamp; show it as one. */
export function fmtRunId(id: string): string {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return id;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

type Tone = 'pass' | 'fail' | 'warn' | 'live' | 'idle' | 'accent';

const TONES: Record<string, Tone> = {
  pass: 'pass',
  proven: 'pass',
  merged: 'pass',
  done: 'pass',
  approved: 'pass',
  fail: 'fail',
  failed: 'fail',
  unproven: 'fail',
  blocked: 'warn',
  stopped: 'warn',
  draft: 'warn',
  building: 'live',
  verifying: 'live',
  running: 'live',
  built: 'accent',
  pending: 'idle',
};

const LABELS: Record<string, string> = { unproven: 'not proven', fail: 'failed', pass: 'passed' };

export function Pill({ status, children }: { status: string; children?: ReactNode }) {
  const tone = TONES[status] ?? 'idle';
  return (
    <span className={`pill pill-${tone}`}>
      {tone === 'live' && <span className="pulse" aria-hidden="true" />}
      {children ?? LABELS[status] ?? status}
    </span>
  );
}

export function Tag({ children, tone }: { children: ReactNode; tone?: 'fail' | 'accent' }) {
  return <span className={`tag${tone ? ` tag-${tone}` : ''}`}>{children}</span>;
}

/** Model aliases Claude Code understands. An empty value means "whatever Claude Code defaults to". */
export const MODEL_CHOICES = ['fable', 'opus', 'sonnet', 'haiku'];

export function ModelSelect(props: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** What an empty value falls back to, shown in the first option. */
  inherit: string;
  disabled?: boolean;
}) {
  const known = !props.value || MODEL_CHOICES.includes(props.value);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState(props.value);
  if (typing) {
    const commit = () => {
      setTyping(false);
      if (typed.trim() !== props.value) props.onChange(typed.trim());
    };
    return (
      <input
        id={props.id}
        className="input mono"
        autoFocus
        value={typed}
        placeholder="model id or alias"
        onChange={(e) => setTyped(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    );
  }
  return (
    <select
      id={props.id}
      className="select"
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => {
        if (e.target.value === '__other') {
          setTyped(props.value);
          setTyping(true);
        } else {
          props.onChange(e.target.value);
        }
      }}
    >
      <option value="">{props.inherit}</option>
      {MODEL_CHOICES.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      {!known && <option value={props.value}>{props.value}</option>}
      <option value="__other">Other model…</option>
    </select>
  );
}

export function Problems({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="notice notice-fail" role="alert">
      <strong>{title}</strong>
      <ul>
        {items.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        {aside && <div className="section-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}
