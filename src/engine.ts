import type { Config } from './config.js';
import { exec } from './util.js';

export type Role = 'planner' | 'builder' | 'verifier';

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
}

export interface AgentResult<T> {
  output: T;
  turns: number;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
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
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(req.schema), '--strict-mcp-config'];
  const model = cfg.models[req.role];
  if (model) args.push('--model', model);
  if (req.write) {
    args.push('--permission-mode', cfg.builder.permissionMode, '--allowedTools', cfg.builder.allowedTools.join(','));
  } else {
    args.push('--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk');
  }
  return args;
}

/** Read the single JSON result that `claude -p --output-format json` prints. */
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
  };
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
    const minutes = { planner: this.cfg.timeouts.plannerMin, builder: this.cfg.timeouts.builderMin, verifier: this.cfg.timeouts.verifierMin }[req.role];
    const r = await exec(this.bin, claudeArgs(req, this.cfg), {
      cwd: req.cwd,
      env: agentEnv(this.cfg.auth),
      input: req.prompt,
      timeoutMs: minutes * 60_000,
    });
    if (r.timedOut) throw new Error(`${req.role} ${req.label} timed out after ${minutes} min`);
    if (r.code !== 0 && !r.stdout.trim()) {
      throw new Error(`claude exited with code ${r.code}: ${r.stderr.trim().slice(-500)}`);
    }
    return parseClaudeResult<T>(r.stdout);
  }
}
