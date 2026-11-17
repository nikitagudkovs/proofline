import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Run through `sh -c` in its own process group, so a timeout kills the whole tree. */
  shell?: boolean;
  /** Give the process its own group, so stopping it also stops whatever it started. */
  group?: boolean;
  /** Called with each complete line of stdout as it arrives. */
  onLine?: (line: string) => void;
  /** Aborting kills the process; the promise then rejects with an AbortError. */
  signal?: AbortSignal;
}

export class AbortError extends Error {
  constructor(message = 'stopped') {
    super(message);
    this.name = 'AbortError';
  }
}

export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

const MAX_CAPTURE = 5 * 1024 * 1024;

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const group = opts.shell || opts.group;
    const child = opts.shell
      ? spawn('sh', ['-c', cmd], { cwd: opts.cwd, env: opts.env ?? process.env, detached: true })
      : spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: !!opts.group });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let pending = '';
    const kill = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    if (opts.signal?.aborted) kill();
    opts.signal?.addEventListener('abort', kill, { once: true });
    const cap = (s: string) => (s.length > MAX_CAPTURE ? s.slice(-MAX_CAPTURE) : s);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on('data', (d) => {
      stdout = cap(stdout + d);
      if (!opts.onLine) return;
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) opts.onLine(line);
    });
    child.stderr.on('data', (d) => (stderr = cap(stderr + d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      if (pending && opts.onLine) opts.onLine(pending);
      if (opts.signal?.aborted) reject(new AbortError());
      else resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

/** Run git and return trimmed stdout; throws with git's own message on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec('git', args, { cwd });
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.trim();
}

export function gitTry(cwd: string, ...args: string[]): Promise<ExecResult> {
  return exec('git', args, { cwd });
}

/** Map with a concurrency cap, keeping input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  // Wait for every worker even when one fails, so nothing is still running when the error surfaces.
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return out;
}

/** Serialises async sections: git cannot add two worktrees to one repository at once. */
export function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

export function tail(text: string, lines: number): string {
  const all = text.replace(/\s+$/, '').split('\n');
  return all.slice(-lines).join('\n');
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export class ValidationError extends Error {
  constructor(
    public readonly what: string,
    public readonly problems: string[],
  ) {
    super(`${what} is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}
