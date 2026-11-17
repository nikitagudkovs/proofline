import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { draftContract, draftPlan } from './authoring.js';
import { configPath, loadConfig, repoList, type Config } from './config.js';
import {
  DIR,
  approvalPath,
  approveContract,
  contractPath,
  hashContract,
  lintContract,
  loadContract,
  parseContract,
  saveContract,
  serializeContract,
} from './contract.js';
import { doctor, type Check } from './doctor.js';
import { ClaudeCodeEngine, type Engine } from './engine.js';
import { loadPlan, planPath, planProblems, savePlan, waves } from './plan.js';
import { writeReport } from './report.js';
import { cleanRun, createRun, excludeRunsDir, executeRun, makeCtx, withSessions, type Ctx } from './runner.js';
import { listSessions, readSession, type SessionListener } from './sessions.js';
import { shipRun } from './ship.js';
import { AUTHORING, listRuns, loadState, repoRuns, runDir, saveState, sessionsDir, stateListeners } from './state.js';
import type { Contract, Plan, RunState, Task } from './types.js';
import { ValidationError, gitTry, isAbort } from './util.js';
import { verifyRun } from './verify.js';

export interface ServerOptions {
  port: number;
  host: string;
  /** Lets tests drive the whole server with scripted agents. */
  engine?: (cfg: Config) => Engine;
  /** Extra Host header values to accept, e.g. when the UI is reached through a tunnel. "*" accepts any. */
  allowedHosts?: string[];
}

interface Job {
  kind: 'contract' | 'plan' | 'run' | 'verify' | 'ship';
  runId: string;
  startedAt: string;
  abort: AbortController;
}

export interface LogLine {
  t: string;
  msg: string;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public problems?: string[],
  ) {
    super(message);
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const logFile = (root: string, runId: string) => path.join(runDir(root, runId), 'log.jsonl');

export function readLog(root: string, runId: string): LogLine[] {
  const file = logFile(root, runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
}

/** Add a line to a run's activity log, which the control room shows. */
export function appendLog(root: string, runId: string, msg: string): LogLine {
  const line: LogLine = { t: new Date().toISOString(), msg };
  mkdirSync(runDir(root, runId), { recursive: true });
  appendFileSync(logFile(root, runId), `${JSON.stringify(line)}\n`);
  return line;
}

/** What the UI shows for the contract: the parsed file, or why it does not parse. */
/** Folder names of the workspace's repositories; empty when this folder is the one repository. */
const repoNamesOf = (root: string) =>
  repoList(root, loadConfig(root))
    .map((r) => r.name)
    .filter(Boolean);

function contractView(root: string) {
  if (!existsSync(contractPath(root))) return { exists: false, approved: false, warnings: [] as string[] };
  try {
    const contract = loadContract(root);
    const hash = hashContract(contract);
    let approvedHash = '';
    try {
      approvedHash = JSON.parse(readFileSync(approvalPath(root), 'utf8')).hash;
    } catch {
      // not approved
    }
    return { exists: true, contract, hash, approved: approvedHash === hash, warnings: lintContract(contract, repoNamesOf(root)) };
  } catch (e) {
    const problems = e instanceof ValidationError ? e.problems : [(e as Error).message];
    return { exists: true, approved: false, warnings: [] as string[], problems };
  }
}

function planView(root: string, contract?: Contract, hash?: string) {
  if (!existsSync(planPath(root))) return { exists: false, problems: [] as string[], waves: [] as string[][] };
  const plan = loadPlan(root);
  const problems = contract && hash ? planProblems(plan, contract, hash, repoNamesOf(root)) : ['there is no valid contract to check the plan against'];
  let order: string[][] = [];
  try {
    order = waves(plan).map((w) => w.map((t) => t.id));
  } catch {
    // a cycle; already listed in problems
  }
  return { exists: true, plan, problems, waves: order };
}

function runSummary(root: string, id: string) {
  const s = loadState(root, id);
  const last = s.rounds[s.rounds.length - 1];
  return {
    id,
    status: s.status,
    branch: s.branch,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    proven: last?.results.filter((r) => r.verdict === 'pass').length ?? 0,
    total: last?.results.length ?? 0,
    prUrl: s.prUrl,
    prUrls: repoRuns(s).flatMap((r) => (r.prUrl ? [{ repo: r.name, url: r.prUrl }] : [])),
  };
}

/**
 * The local control room: a small HTTP API over the same functions the CLI calls,
 * plus a server-sent event stream so the browser sees agents work as they work.
 */
export async function startServer(root: string, opts: ServerOptions) {
  const token = randomBytes(24).toString('hex');
  const uiDir = fileURLToPath(new URL('../ui', import.meta.url));
  const clients = new Set<ServerResponse>();
  let job: Job | undefined;
  let lastError = '';
  let accounts: Check[] = [];
  const refreshAccounts = async () => (accounts = await doctor(root, loadConfig(root)));
  const engineFor = (cfg: Config) => (opts.engine ? opts.engine(cfg) : new ClaudeCodeEngine(cfg));
  void refreshAccounts();
  await excludeRunsDir(root, repoNamesOf(root).length > 0);

  const broadcast = (type: string, data: unknown) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  const onState = (r: string, state: RunState) => {
    if (r === root) broadcast('state', { runId: state.id });
  };
  stateListeners.add(onState);

  const logger = (runId: string) => (msg: string) => broadcast('log', { runId, line: appendLog(root, runId, msg) });
  const sessionListener =
    (runId: string): SessionListener =>
    (meta, event) =>
      broadcast('session', { runId, meta: { ...meta, prompt: undefined }, event });

  /** Run one long job in the background. Only one at a time: they share the repository. */
  const start = (kind: Job['kind'], runId: string, work: (ctx: Ctx) => Promise<unknown>) => {
    if (job) throw new HttpError(409, `A ${job.kind} job is already running. Stop it or wait for it to finish.`);
    const cfg = loadConfig(root);
    const abort = new AbortController();
    const base: Ctx = { ...makeCtx(root, cfg, engineFor(cfg), logger(runId)), signal: abort.signal };
    const ctx = withSessions(base, runId, sessionListener(runId));
    job = { kind, runId, startedAt: new Date().toISOString(), abort };
    lastError = '';
    broadcast('state', { runId });
    work(ctx)
      .catch((e) => {
        if (isAbort(e)) return;
        lastError = (e as Error).message;
        ctx.log(`error: ${lastError}`);
      })
      .finally(() => {
        job = undefined;
        broadcast('state', { runId });
      });
  };

  const overview = () => {
    const c = contractView(root);
    return {
      repo: { name: path.basename(root), root, repos: repoNamesOf(root) },
      job: job ? { kind: job.kind, runId: job.runId, startedAt: job.startedAt } : null,
      lastError,
      config: loadConfig(root),
      accounts,
      contract: c,
      plan: planView(root, c.contract, c.hash),
      runs: listRuns(root).map((id) => runSummary(root, id)).reverse(),
      authoring: {
        sessions: listSessions(sessionsDir(root, AUTHORING)).map((m) => ({ ...m, prompt: undefined })),
        log: readLog(root, AUTHORING),
      },
    };
  };

  const runView = (id: string) => {
    const state = loadState(root, id);
    const c = contractView(root);
    return {
      state,
      sessions: listSessions(sessionsDir(root, id)).map((m) => ({ ...m, prompt: undefined })),
      log: readLog(root, id),
      /** False when the contract on disk is no longer the one this run was made for. */
      current: c.hash === state.contractHash,
    };
  };

  const sessionView = async (runId: string, sid: string) => {
    const session = readSession(sessionsDir(root, runId), sid);
    let changes = '';
    if (runId !== AUTHORING && session.meta.role === 'builder') {
      const task = loadState(root, runId).tasks[session.meta.label];
      // Only the session that produced the task's commits has changes to show.
      if (task?.commits.length && task.attempts === session.meta.attempt) {
        const parts: string[] = [];
        for (const repo of repoList(root, loadConfig(root))) {
          const commits = repo.name ? (task.byRepo?.[repo.name] ?? []) : task.commits;
          if (commits.length === 0) continue;
          const r = await gitTry(repo.root, 'show', '--stat', '--format=%h %s', ...commits);
          if (r.code === 0) parts.push(`${repo.name ? `${repo.name}/\n` : ''}${r.stdout.trim()}`);
        }
        changes = parts.join('\n\n');
      }
    }
    return { ...session, changes };
  };

  const routes: [string, RegExp, (m: RegExpMatchArray, body: any) => unknown | Promise<unknown>][] = [
    ['GET', /^\/api\/overview$/, () => overview()],
    ['POST', /^\/api\/accounts\/refresh$/, async () => refreshAccounts()],

    [
      'PUT',
      /^\/api\/contract$/,
      (_m, body) => {
        try {
          const draft: Contract = { goal: body.goal ?? '', outOfScope: body.outOfScope ?? [], criteria: body.criteria ?? [] };
          saveContract(root, parseContract(serializeContract(draft)));
        } catch (e) {
          if (e instanceof ValidationError) throw new HttpError(400, 'The contract is not valid yet.', e.problems);
          throw e;
        }
        return overview();
      },
    ],
    [
      'POST',
      /^\/api\/contract\/draft$/,
      (_m, body) => {
        const goal = String(body.goal ?? '').trim();
        if (!goal) throw new HttpError(400, 'Describe what you want built first.');
        start('contract', AUTHORING, async (ctx) => {
          ctx.log('drafting the contract (the planner reads the repository first)');
          const contract = await draftContract(ctx, goal);
          ctx.log(`contract drafted: ${contract.criteria.length} criteria`);
        });
        return overview();
      },
    ],
    [
      'POST',
      /^\/api\/contract\/approve$/,
      () => {
        approveContract(root);
        return overview();
      },
    ],

    [
      'PUT',
      /^\/api\/plan$/,
      (_m, body) => {
        const contract = loadContract(root);
        const tasks: Task[] = (body.tasks ?? []).map((t: any) => ({
          id: String(t.id ?? '').trim(),
          title: String(t.title ?? '').trim(),
          brief: String(t.brief ?? '').trim(),
          covers: (t.covers ?? []).map(String),
          needs: (t.needs ?? []).map(String),
          ...(t.model ? { model: String(t.model) } : {}),
          ...(t.repo ? { repo: String(t.repo) } : {}),
        }));
        // An unfinished plan may be saved; the run itself refuses a plan with problems.
        savePlan(root, { contractHash: hashContract(contract), tasks } satisfies Plan);
        return overview();
      },
    ],
    [
      'POST',
      /^\/api\/plan\/draft$/,
      () => {
        start('plan', AUTHORING, async (ctx) => {
          ctx.log('planning tasks for the approved contract');
          const plan = await draftPlan(ctx);
          ctx.log(`plan drafted: ${plan.tasks.length} tasks`);
        });
        return overview();
      },
    ],

    [
      'PUT',
      /^\/api\/config$/,
      (_m, body) => {
        const file = configPath(root);
        const raw = existsSync(file) ? (YAML.parse(readFileSync(file, 'utf8')) ?? {}) : {};
        for (const key of ['concurrency', 'maxFixRounds', 'setup', 'auth'] as const) {
          if (body[key] !== undefined) raw[key] = body[key];
        }
        if (body.models) raw.models = { ...raw.models, ...body.models };
        // The list of repositories is edited in the file; only each one's setup command is set from here.
        if (body.repoSetup && Array.isArray(raw.repos)) {
          raw.repos = raw.repos.map((r: any) => {
            const repo = typeof r === 'string' ? { path: r } : r;
            const name = String(repo.path ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
            return name in body.repoSetup ? { ...repo, setup: String(body.repoSetup[name]) } : r;
          });
        }
        mkdirSync(path.join(root, DIR), { recursive: true });
        writeFileSync(file, YAML.stringify(raw));
        void refreshAccounts();
        return overview();
      },
    ],

    [
      'POST',
      /^\/api\/runs$/,
      async (_m, body) => {
        if (job) throw new HttpError(409, `A ${job.kind} job is already running.`);
        const cfg = loadConfig(root);
        const state: RunState = body.resume
          ? loadState(root, String(body.resume))
          : await createRun(makeCtx(root, cfg, engineFor(cfg)));
        start('run', state.id, async (ctx) => {
          ctx.log(body.resume ? `resuming run ${state.id}` : `run ${state.id} started on branch ${state.branch}`);
          await executeRun(ctx, state);
        });
        return { id: state.id };
      },
    ],
    ['GET', /^\/api\/runs\/([\w-]+)$/, (m) => runView(m[1])],
    ['GET', /^\/api\/runs\/([\w-]+)\/sessions\/([\w.-]+)$/, (m) => sessionView(m[1], m[2])],
    [
      'POST',
      /^\/api\/runs\/([\w-]+)\/verify$/,
      (m) => {
        const state = loadState(root, m[1]);
        start('verify', state.id, async (ctx) => {
          const contract = loadContract(root);
          if (hashContract(contract) !== state.contractHash) throw new Error('The contract changed since this run. Start a new run.');
          const round = await verifyRun(ctx, state, contract);
          state.status = round.results.every((r) => r.verdict === 'pass') ? 'proven' : 'unproven';
          saveState(root, state);
          writeReport(root, state, contract, loadPlan(root));
        });
        return { id: state.id };
      },
    ],
    [
      'POST',
      /^\/api\/runs\/([\w-]+)\/ship$/,
      (m, body) => {
        const state = loadState(root, m[1]);
        start('ship', state.id, async (ctx) => {
          const urls = await shipRun(ctx, state, !!body.draft);
          for (const url of urls.split('\n')) ctx.log(`pull request opened: ${url}`);
        });
        return { id: state.id };
      },
    ],
    [
      'POST',
      /^\/api\/runs\/([\w-]+)\/clean$/,
      async (m) => {
        if (job?.runId === m[1]) throw new HttpError(409, 'This run is still working. Stop it first.');
        const cfg = loadConfig(root);
        await cleanRun(makeCtx(root, cfg, engineFor(cfg)), loadState(root, m[1]));
        return { ok: true };
      },
    ],
    [
      'POST',
      /^\/api\/job\/stop$/,
      () => {
        job?.abort.abort();
        return { ok: true };
      },
    ],
  ];

  const allowed = new Set(['localhost', '127.0.0.1', '[::1]', opts.host, ...(opts.allowedHosts ?? [])]);
  const hostOk = (req: IncomingMessage) => {
    if (allowed.has('*')) return true;
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    return allowed.has(host);
  };

  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : (body as string | Buffer));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<any>((resolve, reject) => {
      let raw = '';
      req.on('data', (d) => {
        raw += d;
        if (raw.length > 1_000_000) reject(new HttpError(413, 'Request too large'));
      });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(new HttpError(400, 'Request body is not JSON'));
        }
      });
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      // This server can start agents that run shell commands, so it answers only to its own page:
      // a known Host (blocks DNS rebinding) and a token no other site can read (blocks cross-site requests).
      if (!hostOk(req)) throw new HttpError(403, 'Unknown host');

      if (url.pathname.startsWith('/api/')) {
        const given = req.headers['x-proofline-token'] ?? url.searchParams.get('token');
        if (given !== token) throw new HttpError(403, 'Missing or wrong token. Reload the page.');

        if (url.pathname === '/api/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        const report = url.pathname.match(/^\/api\/runs\/([\w-]+)\/report\.html$/);
        if (report && req.method === 'GET') {
          const file = path.join(runDir(root, report[1]), 'report.html');
          if (!existsSync(file)) throw new HttpError(404, 'This run has no report yet.');
          return send(res, 200, readFileSync(file), TYPES['.html']);
        }
        for (const [method, pattern, handler] of routes) {
          const m = req.method === method && url.pathname.match(pattern);
          if (!m) continue;
          const body = method === 'GET' ? {} : await readBody(req);
          return send(res, 200, await handler(m, body));
        }
        throw new HttpError(404, 'No such endpoint');
      }

      // Static files of the built UI; any other path is the app itself.
      const rel = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(uiDir, rel);
      if (rel !== '/' && file.startsWith(uiDir) && existsSync(file) && !file.endsWith('index.html')) {
        return send(res, 200, readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
      }
      const index = path.join(uiDir, 'index.html');
      if (!existsSync(index)) throw new HttpError(500, 'The UI is not built. Run "npm run build" in the proofline folder.');
      const html = readFileSync(index, 'utf8').replace('</head>', `<script>window.__PROOFLINE__=${JSON.stringify({ token })}</script></head>`);
      send(res, 200, html, TYPES['.html']);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, problems: e.problems });
      if (e instanceof ValidationError) return send(res, 400, { error: `The ${e.what} is not valid.`, problems: e.problems });
      send(res, 500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    port,
    token,
    url: `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${port}`,
    async close() {
      job?.abort.abort();
      stateListeners.delete(onState);
      for (const res of clients) res.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
