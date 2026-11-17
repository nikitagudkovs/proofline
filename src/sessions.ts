import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentRequest, AgentResult, Engine, Role } from './engine.js';
import { isAbort } from './util.js';

/** One agent run, from the brief it was given to the answer it returned. */
export interface SessionMeta {
  /** Label plus attempt, e.g. "T2-1" or "C4-2". */
  id: string;
  role: Role;
  label: string;
  attempt: number;
  status: 'running' | 'done' | 'failed' | 'stopped';
  /** The model that served the session; before it starts, the one that was asked for. */
  model: string;
  startedAt: string;
  endedAt?: string;
  turns: number;
  costUsd: number;
  durationMs: number;
  /** Claude Code's own session id: `claude --resume <id>` opens the full transcript. */
  claudeSessionId?: string;
  /** How often each tool was used. */
  tools: Record<string, number>;
  lastActivity: string;
  prompt: string;
  /** The structured answer the agent returned. */
  output?: unknown;
  error?: string;
}

export interface SessionEvent extends AgentEvent {
  /** Milliseconds since the session started. */
  t: number;
}

export type SessionListener = (meta: SessionMeta, event?: SessionEvent) => void;

const metaFile = (dir: string, id: string) => path.join(dir, `${id}.json`);
const eventsFile = (dir: string, id: string) => path.join(dir, `${id}.jsonl`);

export function listSessions(dir: string): SessionMeta[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as SessionMeta)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function readSession(dir: string, id: string): { meta: SessionMeta; events: SessionEvent[] } {
  if (!/^[\w.-]+$/.test(id) || !existsSync(metaFile(dir, id))) throw new Error(`No session ${id}`);
  const meta = JSON.parse(readFileSync(metaFile(dir, id), 'utf8')) as SessionMeta;
  const events = existsSync(eventsFile(dir, id))
    ? readFileSync(eventsFile(dir, id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SessionEvent)
    : [];
  return { meta, events };
}

/**
 * Wraps an engine so every agent run leaves a record on disk: what it was asked,
 * what it did step by step, and what it answered. The UI reads these live.
 */
export function recordSessions(inner: Engine, dir: string, listener: SessionListener = () => {}): Engine {
  return {
    async run<T>(req: AgentRequest): Promise<AgentResult<T>> {
      mkdirSync(dir, { recursive: true });
      const attempt = readdirSync(dir).filter((f) => f.startsWith(`${req.label}-`) && f.endsWith('.json')).length + 1;
      const started = Date.now();
      const meta: SessionMeta = {
        id: `${req.label}-${attempt}`,
        role: req.role,
        label: req.label,
        attempt,
        status: 'running',
        model: req.model || 'default',
        startedAt: new Date(started).toISOString(),
        turns: 0,
        costUsd: 0,
        durationMs: 0,
        tools: {},
        lastActivity: 'starting',
        prompt: req.prompt,
      };
      const save = () => writeFileSync(metaFile(dir, meta.id), JSON.stringify(meta, null, 2));
      const record = (e: AgentEvent) => {
        const event: SessionEvent = { ...e, t: Date.now() - started };
        if (e.model) meta.model = e.model;
        if (e.kind === 'tool' && e.tool) {
          meta.tools[e.tool] = (meta.tools[e.tool] ?? 0) + 1;
          meta.lastActivity = `${e.tool}: ${e.text}`;
        } else if (e.kind === 'text') {
          meta.lastActivity = e.text.split('\n')[0];
        }
        appendFileSync(eventsFile(dir, meta.id), `${JSON.stringify(event)}\n`);
        save();
        listener(meta, event);
        req.onEvent?.(e);
      };
      const end = (status: SessionMeta['status']) => {
        meta.status = status;
        meta.endedAt = new Date().toISOString();
        meta.durationMs ||= Date.now() - started;
        save();
        listener(meta);
      };

      save();
      listener(meta);
      try {
        const res = await inner.run<T>({ ...req, onEvent: record });
        meta.turns = res.turns;
        meta.costUsd = res.costUsd;
        meta.durationMs = res.durationMs || Date.now() - started;
        meta.claudeSessionId = res.sessionId;
        meta.output = res.output;
        if (res.model) meta.model = res.model;
        meta.lastActivity = 'finished';
        end('done');
        return res;
      } catch (e) {
        meta.error = (e as Error).message;
        if (!isAbort(e)) record({ kind: 'error', text: meta.error });
        meta.lastActivity = isAbort(e) ? 'stopped' : 'failed';
        end(isAbort(e) ? 'stopped' : 'failed');
        throw e;
      }
    },
  };
}
