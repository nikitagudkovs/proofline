import type { Config } from './config.js';
import { exec } from './util.js';

export type Role = 'planner' | 'builder' | 'verifier';

/** One step of an agent's work, as shown live in the UI and kept in the session record. */
export interface AgentEvent {
  kind: 'start' | 'text' | 'tool' | 'tool_result' | 'error';
  /** What the agent said, or a one-line description of the tool call or its result. */
  text: string;
  tool?: string;
  /** The model that is actually serving the session, known once it starts. */
  model?: string;
  failed?: boolean;
}

export interface AgentRequest {
  role: Role;
  /** Task or criterion id, for logs. */
  label: string;
  prompt: string;
  cwd: string;
  /** JSON Schema the agent's final answer must match. */
  schema: object;
  /** Only builders may change files. Planners and verifiers are read-only. */
  write: boolean;
  /** Overrides the model configured for the role, e.g. a per-task choice. */
  model?: string;
  /** Minutes before the run is given up on, when the role's own limit does not fit. */
  timeoutMin?: number;
  /** Folders outside `cwd` the agent may also read, e.g. the other repositories of a workspace. */
  addDirs?: string[];
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface AgentResult<T> {
  output: T;
  turns: number;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
  model?: string;
}

/** The only thing the orchestrator needs from an agent runtime. */
export interface Engine {
  run<T>(req: AgentRequest): Promise<AgentResult<T>>;
}

/** Environment variables that would make Claude Code bill an API key instead of the subscription. */
const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export function agentEnv(auth: Config['auth'], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (auth !== 'subscription') return env;
  const clean = { ...env };
  for (const name of API_KEY_VARS) delete clean[name];
  return clean;
}

export function claudeArgs(req: AgentRequest, cfg: Config): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(req.schema),
    '--strict-mcp-config',
  ];
  const model = req.model || cfg.models[req.role];
  if (model) args.push('--model', model);
  for (const dir of req.addDirs ?? []) args.push('--add-dir', dir);
  if (req.write) {
    args.push('--permission-mode', cfg.builder.permissionMode, '--allowedTools', cfg.builder.allowedTools.join(','));
  } else {
    args.push('--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk');
  }
  return [...args, ...cfg.claudeArgs];
}

/** Read the final result object that Claude Code prints (the last line of its stream). */
export function parseClaudeResult<T>(stdout: string): AgentResult<T> {
  let raw: any;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(`agent printed no JSON result: ${stdout.trim().slice(-300) || '(empty output)'}`);
  }
  if (raw.is_error) throw new Error(`agent run failed: ${String(raw.result ?? raw.subtype).slice(0, 500)}`);
  let output = raw.structured_output;
  if (output === undefined) {
    // Older CLI versions return the answer as text only.
    const match = String(raw.result ?? '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('agent returned no structured answer');
    output = JSON.parse(match[0]);
  }
  return {
    output: output as T,
    turns: raw.num_turns ?? 0,
    costUsd: raw.total_cost_usd ?? 0,
    durationMs: raw.duration_ms ?? 0,
    sessionId: raw.session_id,
    model: Object.keys(raw.modelUsage ?? {})[0],
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A tool call in one line: the part of its input a person would want to see. */
function describeTool(name: string, input: Record<string, any> = {}): string {
  const value = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.description ?? '';
  return clip(String(value).replace(/\s+/g, ' '), 240);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/**
 * Turn one line of Claude Code's `stream-json` output into the events worth showing.
 * Returns the final result object when the line carries it.
 */
export function parseStreamLine(line: string): { events: AgentEvent[]; result?: string } {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (raw.type === 'result') return { events: [], result: line };
  if (raw.type === 'system' && raw.subtype === 'init') {
    return { events: [{ kind: 'start', text: `session started on ${raw.model}`, model: raw.model }] };
  }
  const content = raw.message?.content;
  if (!Array.isArray(content)) return { events: [] };
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (raw.type === 'assistant' && block.type === 'text' && block.text?.trim()) {
      events.push({ kind: 'text', text: block.text.trim() });
    } else if (raw.type === 'assistant' && block.type === 'tool_use' && block.name !== 'StructuredOutput') {
      events.push({ kind: 'tool', tool: block.name, text: describeTool(block.name, block.input) });
    } else if (raw.type === 'user' && block.type === 'tool_result' && block.is_error) {
      // Successful results are noise in a timeline; a failed command is worth a line.
      events.push({ kind: 'tool_result', failed: true, text: clip(resultText(block.content).trim(), 400) });
    }
  }
  return { events };
}

/**
 * Runs each agent as a headless Claude Code process (`claude -p`).
 * It uses whatever login the `claude` CLI already has, which is how runs stay on a subscription.
 */
export class ClaudeCodeEngine implements Engine {
  constructor(
    private readonly cfg: Config,
    private readonly bin = process.env.PROOFLINE_CLAUDE_BIN ?? 'claude',
  ) {}

  async run<T>(req: AgentRequest): Promise<AgentResult<T>> {
    const minutes = req.timeoutMin ?? { planner: this.cfg.timeouts.plannerMin, builder: this.cfg.timeouts.builderMin, verifier: this.cfg.timeouts.verifierMin }[req.role];
    let result = '';
    const r = await exec(this.bin, claudeArgs(req, this.cfg), {
      cwd: req.cwd,
      env: agentEnv(this.cfg.auth),
      input: req.prompt,
      timeoutMs: minutes * 60_000,
      group: true,
      signal: req.signal,
      onLine: (line) => {
        const parsed = parseStreamLine(line);
        if (parsed.result) result = parsed.result;
        // Paths inside the working copy read better without its long prefix.
        for (const e of parsed.events) req.onEvent?.({ ...e, text: e.text.split(`${req.cwd}/`).join('') });
      },
    });
    if (r.timedOut) throw new Error(`${req.role} ${req.label} timed out after ${minutes} min`);
    if (!result) {
      throw new Error(`claude exited with code ${r.code} and no result: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    }
    return parseClaudeResult<T>(result);
  }
}
