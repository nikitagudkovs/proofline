import { repoList, type Config } from "./config.js";
import { agentEnv } from "./engine.js";
import { exec, gitTry } from "./util.js";

export interface Check {
  ok: boolean;
  /** Needed only to ship. A run can build and verify without it. */
  shipOnly?: boolean;
  label: string;
  detail: string;
}

async function tryExec(cmd: string, args: string[], env?: NodeJS.ProcessEnv) {
  try {
    return await exec(cmd, args, { env, timeoutMs: 20_000 });
  } catch {
    return undefined; // not installed
  }
}

/** Show which accounts a run will use, before it uses them. */
export async function doctor(root: string, cfg: Config): Promise<Check[]> {
  const checks: Check[] = [];

  for (const repo of repoList(root, cfg)) {
    const of = repo.name ? ` (${repo.name})` : "";
    const branch = (
      await gitTry(repo.root, "rev-parse", "--abbrev-ref", "HEAD")
    ).stdout.trim();
    if (repo.base && branch) {
      const known =
        (
          await gitTry(
            repo.root,
            "rev-parse",
            "--verify",
            "-q",
            `origin/${repo.base}`,
          )
        ).code === 0;
      checks.push({
        ok: known,
        label: `starts from${of}`,
        detail: known
          ? `${repo.base} as it is on the remote, fetched when a run starts; its pull request goes into ${repo.base}. Your checkout (on ${branch}) is not used`
          : `origin/${repo.base} is not known here: check the "base" setting`,
      });
    } else
      checks.push({
        ok: !!branch && branch !== "HEAD",
        label: `starts from${of}`,
        detail: !branch
          ? `${repo.root} is not a git repository`
          : branch === "HEAD"
            ? "a detached HEAD: check out a branch first"
            : `branch ${branch}: a run builds on it, and its pull request goes into it`,
      });

    const name = (await gitTry(repo.root, "config", "user.name")).stdout.trim();
    const email = (
      await gitTry(repo.root, "config", "user.email")
    ).stdout.trim();
    checks.push({
      ok: !!name && !!email,
      label: `git author${of}`,
      detail:
        name && email
          ? `commits are written as ${name}`
          : "set git user.name and user.email, or agents cannot commit",
    });

    const origin = (
      await gitTry(repo.root, "remote", "get-url", "origin")
    ).stdout.trim();
    checks.push({
      ok: !!origin,
      shipOnly: true,
      label: `git remote${of}`,
      detail: origin
        ? `ship pushes to ${origin}`
        : 'no "origin" remote: build and verify work, ship does not',
    });
  }

  const gh = await tryExec("gh", ["api", "user", "-q", ".login"]);
  checks.push({
    ok: gh?.code === 0,
    shipOnly: true,
    label: "GitHub account",
    detail:
      gh?.code === 0
        ? `pull requests are opened as ${gh.stdout.trim()}`
        : gh
          ? 'not signed in: run "gh auth login" (needed only for ship)'
          : "GitHub CLI (gh) not found (needed only for ship)",
  });

  const bin = process.env.PROOFLINE_CLAUDE_BIN ?? "claude";
  const auth = await tryExec(bin, ["auth", "status"], agentEnv(cfg.auth));
  let claude: Check = {
    ok: false,
    label: "Claude Code",
    detail: 'the "claude" command was not found: install Claude Code',
  };
  if (auth) {
    try {
      const s = JSON.parse(auth.stdout);
      if (!s.loggedIn) {
        claude.detail = 'not signed in: run "claude auth login"';
      } else if (s.authMethod === "claude.ai") {
        claude = {
          ok: true,
          label: "Claude Code",
          detail: `agents run on your Claude subscription (${s.subscriptionType ?? "plan unknown"})`,
        };
      } else {
        claude = {
          ok: cfg.auth !== "subscription",
          label: "Claude Code",
          detail: `signed in with ${s.authMethod}, which is billed per token, not a subscription. Run "claude auth login" to use your plan.`,
        };
      }
    } catch {
      claude.detail = 'could not read "claude auth status"; update Claude Code';
    }
  }
  checks.push(claude);

  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].filter(
    (k) => process.env[k],
  );
  if (keys.length) {
    checks.push({
      ok: true,
      label: "API key",
      detail:
        cfg.auth === "subscription"
          ? `${keys.join(", ")} is set here but is removed from every agent process, so it cannot be billed`
          : `${keys.join(", ")} is set and agents will use it (auth: inherit)`,
    });
  }
  return checks;
}
