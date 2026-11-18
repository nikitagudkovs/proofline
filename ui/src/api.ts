import type { Config, Contract, DemoData, Overview, RunView, SessionMeta, SessionView, Task } from './types';

interface Boot {
  token?: string;
  demo?: DemoData;
}

const boot: Boot = (window as unknown as { __PROOFLINE__?: Boot }).__PROOFLINE__ ?? {};

/** True in the static build that replays a recorded run instead of talking to a server. */
export const isDemo = !!boot.demo;

export class ApiError extends Error {
  constructor(
    message: string,
    public problems: string[] = [],
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (boot.demo) return demoCall<T>(method, path);
  const res = await fetch(path, {
    method,
    headers: { 'x-proofline-token': boot.token ?? '', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `The server answered ${res.status}` }));
  if (!res.ok) throw new ApiError(json.error ?? 'Request failed', json.problems);
  return json as T;
}

export const api = {
  overview: () => call<Overview>('GET', '/api/overview'),
  run: (id: string) => call<RunView>('GET', `/api/runs/${id}`),
  session: (runId: string, sid: string) => call<SessionView>('GET', `/api/runs/${runId}/sessions/${sid}`),
  saveContract: (c: Contract) => call<Overview>('PUT', '/api/contract', c),
  draftContract: (goal: string) => call<Overview>('POST', '/api/contract/draft', { goal }),
  approveContract: () => call<Overview>('POST', '/api/contract/approve', {}),
  savePlan: (tasks: Task[]) => call<Overview>('PUT', '/api/plan', { tasks }),
  draftPlan: () => call<Overview>('POST', '/api/plan/draft', {}),
  saveConfig: (patch: Partial<Config> & { repoSetup?: Record<string, string> }) => call<Overview>('PUT', '/api/config', patch),
  startRun: (resume?: string) => call<{ id: string }>('POST', '/api/runs', resume ? { resume } : {}),
  stopJob: () => call('POST', '/api/job/stop', {}),
  verify: (id: string) => call('POST', `/api/runs/${id}/verify`, {}),
  ship: (id: string, draft: boolean) => call('POST', `/api/runs/${id}/ship`, { draft }),
  review: (id: string) => call('POST', `/api/runs/${id}/review`, {}),
  fixReview: (id: string, all: boolean) => call('POST', `/api/runs/${id}/review/fix`, { all }),
  merge: (id: string) => call('POST', `/api/runs/${id}/merge`, {}),
  action: (id: string, name: string) => call('POST', `/api/runs/${id}/actions`, { name }),
  cleanUp: (id: string) => call<{ kept: string[] }>('POST', `/api/runs/${id}/clean`, { all: true }),
  refreshAccounts: () => call('POST', '/api/accounts/refresh', {}),
  newProject: (goal = '') => call<Overview>('POST', '/api/projects', { goal }),
  openProject: (id: string) => call<Overview>('POST', `/api/projects/${id}/open`, {}),
  renameProject: (id: string, title: string) => call<Overview>('PUT', `/api/projects/${id}`, { title }),
  reportUrl: (id: string) => `/api/runs/${id}/report.html?token=${boot.token ?? ''}`,
};

/** The present moment: the wall clock, or in the demo the point the replay has reached. */
export const now = (): number => (boot.demo ? demoStart + clock.t : Date.now());

/** Calls back whenever something changed on the server (or the replay clock moved). */
export function subscribe(onChange: () => void): () => void {
  if (boot.demo) return clock.subscribe(onChange);
  const source = new EventSource(`/api/events?token=${boot.token ?? ''}`);
  for (const type of ['state', 'session', 'log']) source.addEventListener(type, onChange);
  return () => source.close();
}

// ---------------------------------------------------------------------------------------------
// Demo replay: the recorded run is cut off at the replay clock, so the UI shows it as it happened.

const demoStart = boot.demo ? Date.parse(boot.demo.run.state.startedAt) : 0;
const demoEnd = boot.demo ? Date.parse(boot.demo.run.state.finishedAt ?? boot.demo.run.state.startedAt) : 0;

export const clock = (() => {
  const duration = Math.max(1000, demoEnd - demoStart + 1500);
  let t = duration;
  let playing = false;
  let speed = 4;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const stop = () => {
    playing = false;
    clearInterval(timer);
  };
  return {
    duration,
    get t() {
      return t;
    },
    get playing() {
      return playing;
    },
    get speed() {
      return speed;
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    play() {
      if (t >= duration) t = 0;
      playing = true;
      clearInterval(timer);
      timer = setInterval(() => {
        t = Math.min(duration, t + 100 * speed);
        if (t >= duration) stop();
        emit();
      }, 100);
      emit();
    },
    pause() {
      stop();
      emit();
    },
    seek(to: number) {
      t = Math.max(0, Math.min(duration, to));
      emit();
    },
    setSpeed(s: number) {
      speed = s;
      emit();
    },
  };
})();

function freezeSession(view: SessionView, now: number): SessionView | undefined {
  const start = Date.parse(view.meta.startedAt);
  if (start > now) return undefined;
  const ended = view.meta.endedAt ? Date.parse(view.meta.endedAt) : Infinity;
  if (ended <= now) return view;
  const events = view.events.filter((e) => start + e.t <= now);
  const tools: Record<string, number> = {};
  let lastActivity = 'starting';
  for (const e of events) {
    if (e.kind === 'tool' && e.tool) {
      tools[e.tool] = (tools[e.tool] ?? 0) + 1;
      lastActivity = `${e.tool}: ${e.text}`;
    } else if (e.kind === 'text') {
      lastActivity = e.text.split('\n')[0];
    }
  }
  const meta: SessionMeta = {
    ...view.meta,
    status: 'running',
    endedAt: undefined,
    turns: 0,
    costUsd: 0,
    durationMs: now - start,
    output: undefined,
    error: undefined,
    tools,
    lastActivity,
  };
  return { meta, events, changes: '' };
}

function freezeRun(data: DemoData, now: number): RunView {
  const { state } = data.run;
  const done = now >= demoEnd;
  const frozen = data.run.sessions
    .map((s) => freezeSession(data.sessions[s.id], now))
    .filter((s): s is SessionView => !!s)
    .map((s) => s.meta);

  const tasks: RunView['state']['tasks'] = {};
  for (const task of Object.values(state.tasks)) {
    const mine = frozen.filter((s) => s.role === 'builder' && s.label === task.id);
    if (mine.length === 0) {
      // A fix task does not exist until verification has asked for it.
      if (!task.id.startsWith('FIX')) tasks[task.id] = { ...task, status: 'pending', attempts: 0, commits: [], summary: undefined, concerns: undefined, error: undefined };
    } else if (mine[mine.length - 1].status === 'running' || mine.length < task.attempts) {
      tasks[task.id] = { ...task, status: 'building', attempts: mine.length, commits: [], summary: undefined, concerns: undefined, error: undefined };
    } else {
      tasks[task.id] = task;
    }
  }

  const usage = { planner: state.usage.planner, builder: zero(), verifier: zero() };
  for (const s of frozen) {
    if (s.status === 'running' || s.role === 'planner') continue;
    const u = usage[s.role];
    u.calls += 1;
    u.turns += s.turns;
    u.costUsd += s.costUsd;
    u.durationMs += s.durationMs;
  }

  // The round being verified at this moment: show the verdicts that had arrived by now.
  const next = state.rounds.find((r) => Date.parse(r.at) > now);
  const arrived = next?.results.filter((r) => r.at && Date.parse(r.at) <= now) ?? [];
  const progress = !done && arrived.length > 0 ? arrived : undefined;
  const verifying = !!progress || frozen.some((s) => s.role === 'verifier' && s.status === 'running');
  return {
    ...data.run,
    state: {
      ...state,
      status: done ? state.status : verifying ? 'verifying' : 'building',
      finishedAt: done ? state.finishedAt : undefined,
      tasks,
      rounds: state.rounds.filter((r) => Date.parse(r.at) <= now),
      progress,
      usage,
    },
    sessions: frozen,
    log: data.run.log.filter((l) => Date.parse(l.t) <= now),
  };
}

const zero = () => ({ calls: 0, turns: 0, costUsd: 0, durationMs: 0 });

async function demoCall<T>(method: string, path: string): Promise<T> {
  const data = boot.demo!;
  const now = demoStart + clock.t;
  if (method !== 'GET') {
    throw new ApiError('This is a recorded run, so nothing can be changed here. Install proofline to drive your own.');
  }
  if (path === '/api/overview') {
    const running = clock.t < clock.duration - 1500;
    const run = freezeRun(data, now);
    const summary = data.overview.runs[0];
    const last = run.state.rounds[run.state.rounds.length - 1];
    return {
      ...data.overview,
      job: running ? { kind: 'run', runId: data.run.state.id, startedAt: data.run.state.startedAt } : null,
      runs: [
        {
          ...summary,
          status: run.state.status,
          finishedAt: run.state.finishedAt,
          proven: last?.results.filter((r) => r.verdict === 'pass').length ?? 0,
          total: last?.results.length ?? 0,
        },
      ],
    } as T;
  }
  const session = path.match(/^\/api\/runs\/([\w-]+)\/sessions\/([\w.-]+)$/);
  if (session) {
    const view = data.sessions[session[2]];
    const frozen = view && (session[1] === data.run.state.id ? freezeSession(view, now) : view);
    if (!frozen) throw new ApiError('That session has not started yet at this point of the replay.');
    return frozen as T;
  }
  if (/^\/api\/runs\/[\w-]+$/.test(path)) return freezeRun(data, now) as T;
  throw new ApiError('Not available in the recorded demo.');
}
